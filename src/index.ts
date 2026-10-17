import * as core from '@actions/core'
import * as github from '@actions/github'
import { createHash } from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { syncRepository } from './git-ops.js'
import type { SyncRepoResult } from './git-ops.js'

type Octokit = ReturnType<typeof github.getOctokit>
type PullRequest = { number: number; html_url: string; body?: string | null }

const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/

/** Raw and encoded credentials to scrub from diagnostics. */
const secrets: string[] = []

function maskToken(token: string): void {
  for (const value of [token, encodeURIComponent(token), Buffer.from(`x-access-token:${token}`).toString('base64')]) {
    if (value) { secrets.push(value); core.setSecret(value) }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function redact(text: string): string {
  return [...secrets].sort((a, b) => b.length - a.length)
    .reduce((result, secret) => result.split(secret).join('***'), text)
}

function html(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function markdown(text: string): string {
  return html(text).replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1').replace(/@/g, '&#64;')
}

/** Icon shown next to the status in the job summary. */
function statusIcon(status: string): string {
  if (status === 'up-to-date') return '✅'
  if (status === 'synced') return '🔄'
  return '⚠️'
}

function splitRepository(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split('/')
  return { owner, repo }
}

function remoteUrl(server: string, fullName: string): string {
  const url = new URL(`${server.replace(/\/+$/, '')}/${fullName}.git`)
  if (url.username || url.password || !['https:', 'file:'].includes(url.protocol)) {
    throw new Error('Git remotes require credential-free HTTPS URLs (file URLs are supported for offline tests).')
  }
  return url.toString()
}

function csvInput(name: string): string[] {
  return core
    .getInput(name)
    .split(',')
    .map(item => item.trim())
    .filter(item => item.length > 0)
}

async function findOpenPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  head: string,
  base: string
): Promise<PullRequest | undefined> {
  const { data } = await octokit.rest.pulls.list({
    owner,
    repo,
    state: 'open',
    head: `${owner}:${head}`,
    base,
    per_page: 1,
  })
  return data[0]
}

async function openOrUpdatePullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  head: string,
  base: string,
  title: string,
  body: string
): Promise<PullRequest> {
  const existing = await findOpenPullRequest(octokit, owner, repo, head, base)
  if (existing) {
    core.info(`Updating existing pull request #${existing.number} (its branch was force-pushed).`)
    await octokit.rest.pulls.update({ owner, repo, pull_number: existing.number, body })
    return existing
  }
  const { data } = await octokit.rest.pulls.create({ owner, repo, title, head, base, body })
  core.info(`Opened pull request #${data.number}: ${data.html_url}`)
  return data
}

function buildPullRequestBody(
  result: SyncRepoResult,
  server: string,
  upstreamRepo: string,
  upstreamBranch: string,
  targetBranch: string
): string {
  const custom = core.getInput('pr-body').trim()
  if (custom) return custom

  upstreamBranch = markdown(upstreamBranch)
  targetBranch = markdown(targetBranch)
  const conflictBanner =
    result.status === 'conflicts'
      ? `> [!WARNING]\n> Merging ${upstreamBranch} into ${targetBranch} conflicts. ` +
        `The head branch points at upstream's tip; resolve the conflicts in this pull request.\n\n`
      : ''
  const commits = result.commits.map(commit => `- ${commit.sha.slice(0, 7)} ${markdown(commit.subject)}`)
  const overflow =
    result.commitCount > result.commits.length
      ? `\n- … and ${result.commitCount - result.commits.length} more`
      : ''
  return (
    `${conflictBanner}This pull request brings **${result.commitCount} commit(s)** from ` +
    `[${upstreamRepo}](${server}/${upstreamRepo}) ${upstreamBranch} into ${targetBranch}.\n\n` +
    `### Incoming commits\n${commits.join('\n')}${overflow}\n\n---\n` +
      `Automated by the [basic-ops-tasks](${server}/ruivieira/basic-ops-tasks)/fork-sync action.`
  )
}

async function run(): Promise<void> {
  const token = core.getInput('token')
  if (!token) {
    throw new Error(
      "The 'token' input is empty; pass a token with contents:write and pull-requests:write " +
        '(the default github.token usually works).'
    )
  }
  maskToken(token)

  const dryRun = core.getBooleanInput('dry-run')
  const skipPr = core.getBooleanInput('skip-pr')
  const failOnConflict = core.getBooleanInput('fail-on-conflict')
  const upstreamToken = core.getInput('upstream-token').trim() || token
  maskToken(upstreamToken)

  const { owner: forkOwner, repo: forkRepo } = github.context.repo
  const upstreamRepoInput = core.getInput('upstream-repo').trim()
  const upstreamBranchInput = core.getInput('upstream-branch').trim()
  const targetBranchInput = core.getInput('target-branch').trim()
  const sourceBranchInput = core.getInput('source-branch').trim()
  const modeInput = core.getInput('mode').trim() || 'auto'
  if (modeInput !== 'auto' && modeInput !== 'fork' && modeInput !== 'branch') {
    throw new Error(`mode must be "auto", "fork" or "branch", got "${modeInput}".`)
  }
  const branchMode = modeInput === 'branch' || (modeInput === 'auto' && sourceBranchInput !== '')

  if (modeInput === 'branch' && !sourceBranchInput) {
    throw new Error("The 'mode: branch' input requires 'source-branch' to be set.")
  }
  if (modeInput === 'fork' && sourceBranchInput) {
    throw new Error(
      "The 'mode: fork' input cannot be combined with 'source-branch'; use 'mode: branch' for branch-to-branch sync."
    )
  }

  if (branchMode && (upstreamRepoInput || upstreamBranchInput)) {
    throw new Error(
      "The 'source-branch' input (branch-to-branch sync) cannot be combined with 'upstream-repo' or 'upstream-branch'."
    )
  }

  if (upstreamRepoInput && !REPOSITORY_PATTERN.test(upstreamRepoInput)) {
    throw new Error(`upstream-repo must look like "owner/name", got "${upstreamRepoInput}".`)
  }

  const octokit = github.getOctokit(token)

  // Only hit the API for what the inputs did not pin down.
  let forkDefaultBranch = ''
  let parentRepo = ''
  if (!targetBranchInput || (!branchMode && !upstreamRepoInput)) {
    core.info(`Looking up ${forkOwner}/${forkRepo} …`)
    const { data: fork } = await octokit.rest.repos.get({ owner: forkOwner, repo: forkRepo })
    forkDefaultBranch = fork.default_branch
    parentRepo = fork.parent?.full_name ?? ''
    if (!branchMode && !upstreamRepoInput && !parentRepo) {
      throw new Error(
        `${forkOwner}/${forkRepo} does not appear to be a fork. ` +
          `Set the 'upstream-repo' input to sync from a specific repository, ` +
          `or 'source-branch' to sync between branches of this repository.`
      )
    }
  }

  // Branch-to-branch mode: the source is a branch of the repository the action runs in.
  const upstreamRepo = branchMode ? `${forkOwner}/${forkRepo}` : upstreamRepoInput || parentRepo
  let upstreamBranch = branchMode ? sourceBranchInput : upstreamBranchInput
  if (!upstreamBranch) {
    const { owner, repo } = splitRepository(upstreamRepo)
    core.info(`Looking up the default branch of ${upstreamRepo} …`)
    const { data: upstream } = await github.getOctokit(upstreamToken).rest.repos.get({ owner, repo })
    upstreamBranch = upstream.default_branch
  }

  const targetBranch = targetBranchInput || forkDefaultBranch
  if (branchMode && sourceBranchInput === targetBranch) {
    throw new Error(`source-branch ("${sourceBranchInput}") must differ from target-branch ("${targetBranch}").`)
  }
  const syncId = createHash('sha256').update(JSON.stringify([
    branchMode ? 'branch' : 'fork', `${forkOwner}/${forkRepo}`, upstreamRepo, upstreamBranch, targetBranch,
  ])).digest('hex')
  const marker = `<!-- basic-ops-tasks:sync:${syncId} -->`
  const headBranch =
    core.getInput('head-branch').trim() || `sync/${syncId}`
  if (headBranch === targetBranch) {
    throw new Error(`head-branch ("${headBranch}") must differ from target-branch ("${targetBranch}").`)
  }
  if (branchMode && headBranch === sourceBranchInput) {
    throw new Error(
      `head-branch ("${headBranch}") must differ from source-branch ("${sourceBranchInput}"): ` +
        'the head branch is force-pushed on every run, so it would overwrite the source branch.'
    )
  }

  const title =
    core.getInput('pr-title').trim() ||
    (branchMode
      ? `sync(branch): Sync ${sourceBranchInput} into ${targetBranch}`
      : `sync(pull): Sync ${upstreamRepo}:${upstreamBranch} (upstream) into ${targetBranch}`)
  core.info(`Pull request title: "${title}"`)

  const mergeStrategy = core.getInput('merge-strategy').trim()
  if (mergeStrategy !== 'merge' && mergeStrategy !== 'tip') {
    throw new Error(`merge-strategy must be "merge" or "tip", got "${mergeStrategy}".`)
  }

  const server = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '')
  const originUrl = remoteUrl(server, `${forkOwner}/${forkRepo}`)
  const upstreamUrl = remoteUrl(server, upstreamRepo)

  let allowHeadUpdate = core.getInput('allow-head-update') ? core.getBooleanInput('allow-head-update') : false
  if (!dryRun && !skipPr && !allowHeadUpdate) {
    const existing = await findOpenPullRequest(octokit, forkOwner, forkRepo, headBranch, targetBranch)
    allowHeadUpdate = existing?.body?.includes(marker) ?? false
  }

  const workspace = await mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'fork-sync-'))
  core.info(
    `Syncing ${upstreamRepo}:${upstreamBranch} -> ${forkOwner}/${forkRepo}:${targetBranch} ` +
      `via ${headBranch} (strategy: ${mergeStrategy}, dry-run: ${dryRun})`
  )

  let result: SyncRepoResult
  try {
    result = await syncRepository({
      workspace,
      originUrl,
      upstreamUrl,
      targetBranch,
      upstreamBranch,
      headBranch,
      mergeStrategy,
      mergeMessage: `Merge ${upstreamRepo}:${upstreamBranch} into ${targetBranch}`,
      push: !dryRun,
      failOnConflict,
      allowHeadUpdate,
      originToken: token,
      upstreamToken,
    })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }

  core.setOutput('status', result.status)
  core.setOutput('head-sha', result.headSha)
  core.setOutput('target-sha', result.targetSha)
  core.setOutput('upstream-sha', result.upstreamSha)
  core.setOutput('commit-count', String(result.commitCount))
  core.setOutput('pushed', String(result.pushed))
  core.info(`Sync result: ${result.status} — ${result.commitCount} commit(s), head ${result.headSha.slice(0, 7)}`)

  let pullRequest: PullRequest | undefined

  if (result.status === 'up-to-date') {
    core.info(`"${targetBranch}" is already up to date with ${upstreamRepo}:${upstreamBranch}.`)
  } else if (dryRun) {
    core.info('Dry run: nothing was pushed and no pull request was created.')
  } else if (skipPr) {
    core.info(`Pushed "${headBranch}" to ${forkOwner}/${forkRepo} (skip-pr: true, no pull request).`)
  } else {
    const body = `${buildPullRequestBody(result, server, upstreamRepo, upstreamBranch, targetBranch)}\n\n${marker}`
    pullRequest = await openOrUpdatePullRequest(octokit, forkOwner, forkRepo, headBranch, targetBranch, title, body)

    const labels = csvInput('labels')
    const assignees = csvInput('assignees')
    if (labels.length > 0) {
      try {
        await octokit.rest.issues.addLabels({
          owner: forkOwner,
          repo: forkRepo,
          issue_number: pullRequest.number,
          labels,
        })
      } catch (error) {
        core.warning(`Could not add labels: ${redact(errorMessage(error))}`)
      }
    }
    if (assignees.length > 0) {
      try {
        await octokit.rest.issues.addAssignees({
          owner: forkOwner,
          repo: forkRepo,
          issue_number: pullRequest.number,
          assignees,
        })
      } catch (error) {
        core.warning(`Could not add assignees: ${redact(errorMessage(error))}`)
      }
    }
  }

  core.setOutput('pull-request-number', pullRequest ? String(pullRequest.number) : '')
  core.setOutput('pull-request-url', pullRequest ? pullRequest.html_url : '')

  await core.summary
    .addHeading(branchMode ? 'Sync branch' : 'Sync upstream', 2)
    .addList([
      `${statusIcon(result.status)} status: ${result.status}`,
      // core.summary emits raw HTML, and markdown inside it does not render,
      // so links must be <a> anchors rather than [text](url).
      `upstream: <a href="${html(server)}/${html(upstreamRepo)}/tree/${encodeURIComponent(upstreamBranch)}">${html(upstreamRepo)}:${html(upstreamBranch)}</a> @ ` +
        `<a href="${html(server)}/${html(upstreamRepo)}/commit/${result.upstreamSha}">${result.upstreamSha.slice(0, 7)}</a>`,
      `target: <a href="${html(server)}/${html(forkOwner)}/${html(forkRepo)}/tree/${encodeURIComponent(targetBranch)}">${html(forkOwner)}/${html(forkRepo)}:${html(targetBranch)}</a> @ ` +
        `<a href="${html(server)}/${html(forkOwner)}/${html(forkRepo)}/commit/${result.targetSha}">${result.targetSha.slice(0, 7)}</a>`,
      `incoming commits: ${result.commitCount}`,
      `pull request: ${pullRequest ? `<a href="${html(pullRequest.html_url)}">#${pullRequest.number}</a>` : 'none'}`,
    ])
    .write()
}

run().catch(error => {
  core.setFailed(redact(errorMessage(error)))
})
