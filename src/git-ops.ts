import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir } from 'node:fs/promises'
import { devNull } from 'node:os'

const execFileAsync = promisify(execFile)

export interface CommitInfo {
  sha: string
  subject: string
}

export interface SyncRepoOptions {
  /** Directory in which a throwaway git repository is created. */
  workspace: string
  /** Remote URL of the fork: the target branch is fetched from here and the head branch pushed to it. */
  originUrl: string
  /** Remote URL of the upstream repository: the upstream branch is fetched from here. */
  upstreamUrl: string
  /** Branch on the fork that receives the changes (pull request base). */
  targetBranch: string
  /** Branch on the upstream repository to pull from. */
  upstreamBranch: string
  /** Branch on the fork that carries the changes (pull request head). */
  headBranch: string
  /** "merge": merge upstream into the target branch. "tip": head points at upstream's tip. */
  mergeStrategy: 'merge' | 'tip'
  /** Commit message used when the merge creates a merge commit. */
  mergeMessage: string
  /** Push the head branch to the fork when true. */
  push: boolean
  failOnConflict?: boolean
  originToken?: string
  upstreamToken?: string
  allowHeadUpdate?: boolean
}

export interface SyncRepoResult {
  /** "up-to-date": nothing to do. "synced": head branch ready. "conflicts": the merge conflicted and head points at upstream's tip. */
  status: 'up-to-date' | 'synced' | 'conflicts'
  targetSha: string
  upstreamSha: string
  headSha: string
  commitCount: number
  commits: CommitInfo[]
  pushed: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class GitError extends Error {
  readonly exitCode: unknown
  constructor(message: string, exitCode: unknown) { super(message); this.exitCode = exitCode }
}

async function git(cwd: string, args: string[], auth?: { url: string; token?: string }): Promise<string> {
  // Discard inherited Git overrides, helpers, hooks, templates and input secrets.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('INPUT_')))
  const config: [string, string][] = [
    ['core.hooksPath', devNull], ['credential.helper', ''], ['http.followRedirects', 'false'],
    ['submodule.recurse', 'false'], ['protocol.ext.allow', 'never'],
  ]
  if (auth?.token && auth.url.startsWith('https://')) {
    config.push([`http.${auth.url}.extraheader`, `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${auth.token}`).toString('base64')}`])
  }
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_COUNT: String(config.length) })
  config.forEach(([key, value], i) => { env[`GIT_CONFIG_KEY_${i}`] = key; env[`GIT_CONFIG_VALUE_${i}`] = value })
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
      env,
    })
    return stdout.toString()
  } catch (error) {
    const err = error as { stderr?: string | Buffer; message: string; code?: unknown }
    const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString() ?? ''
    throw new GitError(`git ${args.join(' ')} failed:\n${stderr.trim() || err.message}`, err.code)
  }
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) return false
    throw error
  }
}

async function listCommits(cwd: string, from: string, to: string, limit = 30): Promise<CommitInfo[]> {
  const out = await git(cwd, ['log', `--max-count=${limit}`, '--pretty=format:%H%x1f%s', `${from}..${to}`])
  const trimmed = out.trim()
  if (!trimmed) return []
  return trimmed.split('\n').map(line => {
    const sep = line.indexOf('\x1f')
    return { sha: line.slice(0, sep), subject: line.slice(sep + 1) }
  })
}

export async function syncRepository(opts: SyncRepoOptions): Promise<SyncRepoResult> {
  const {
    workspace,
    originUrl,
    upstreamUrl,
    targetBranch,
    upstreamBranch,
    headBranch,
    mergeStrategy,
    mergeMessage,
    push,
  } = opts

  await mkdir(workspace, { recursive: true })
  for (const branch of [targetBranch, upstreamBranch, headBranch]) {
    if (branch.startsWith('-') || branch.includes('@{')) throw new Error('Invalid branch name')
    await git(workspace, ['check-ref-format', `refs/heads/${branch}`])
  }
  if (!headBranch.startsWith('sync/')) throw new Error('head-branch must be in the reserved sync/ namespace')
  await git(workspace, ['init', '--template=', '--initial-branch=main'])
  await git(workspace, ['config', 'user.name', 'github-actions[bot]'])
  await git(workspace, ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
  await git(workspace, ['config', 'commit.gpgsign', 'false'])
  await git(workspace, ['remote', 'add', 'origin', originUrl])
  await git(workspace, ['remote', 'add', 'upstream', upstreamUrl])

  try {
    await git(workspace, [
      'fetch',
      '--no-tags',
      'origin',
      `+refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`,
    ], { url: originUrl, token: opts.originToken })
  } catch (error) {
    throw new Error(
      `Could not fetch the target branch "${targetBranch}" from the fork. Does the branch exist? ` +
        `(${errorMessage(error)})`
    )
  }
  try {
    await git(workspace, [
      'fetch',
      '--no-tags',
      'upstream',
      `+refs/heads/${upstreamBranch}:refs/remotes/upstream/${upstreamBranch}`,
    ], { url: upstreamUrl, token: opts.upstreamToken })
  } catch (error) {
    throw new Error(
      `Could not fetch the upstream branch "${upstreamBranch}". Does it exist, and does the token have read ` +
        `access to the upstream repository? (${errorMessage(error)})`
    )
  }

  const targetSha = (await git(workspace, ['rev-parse', `refs/remotes/origin/${targetBranch}`])).trim()
  const upstreamSha = (await git(workspace, ['rev-parse', `refs/remotes/upstream/${upstreamBranch}`])).trim()

  if (await isAncestor(workspace, upstreamSha, targetSha)) {
    return { status: 'up-to-date', targetSha, upstreamSha, headSha: targetSha, commitCount: 0, commits: [], pushed: false }
  }

  const observed = push
    ? (await git(workspace, ['ls-remote', '--heads', 'origin', `refs/heads/${headBranch}`], { url: originUrl, token: opts.originToken })).trim().split(/\s+/)[0]
    : ''
  if (observed && !opts.allowHeadUpdate) {
    throw new Error('Existing head branch is not verified for this sync. Use a new head or explicitly set allow-head-update: true to adopt it.')
  }

  let status: 'synced' | 'conflicts' = 'synced'
  await git(workspace, ['checkout', '-B', headBranch, targetSha])
  try {
    // Check mergeability even in tip mode; operational failures are not conflicts.
    await git(workspace, ['merge', '--no-edit', '-m', mergeMessage, upstreamSha])
  } catch (error) {
    if (!(error instanceof GitError) || error.exitCode !== 1 ||
        !(await git(workspace, ['ls-files', '--unmerged'])).trim()) throw error
    await git(workspace, ['merge', '--abort'])
    await git(workspace, ['checkout', '-B', headBranch, upstreamSha])
    status = 'conflicts'
  }
  if (mergeStrategy === 'tip' && status !== 'conflicts') {
    await git(workspace, ['checkout', '-B', headBranch, upstreamSha])
  }

  const headSha = (await git(workspace, ['rev-parse', 'HEAD'])).trim()
  const commitCount = parseInt(
    (await git(workspace, ['rev-list', '--count', `${targetSha}..${headSha}`])).trim(),
    10
  )
  const commits = await listCommits(workspace, targetSha, headSha)

  if (status === 'conflicts' && opts.failOnConflict) {
    throw new Error('Merge conflicts; refusing to publish the sync branch.')
  }

  let pushed = false
  if (push) {
    // The head branch is owned by this action; force-push keeps re-runs idempotent.
    await git(workspace, ['push', `--force-with-lease=refs/heads/${headBranch}:${observed}`, 'origin', `refs/heads/${headBranch}:refs/heads/${headBranch}`], { url: originUrl, token: opts.originToken })
    pushed = true
  }

  return { status, targetSha, upstreamSha, headSha, commitCount, commits, pushed }
}
