#!/usr/bin/env node
/**
 * Local end-to-end test for the fork-sync action.
 *
 * Spins up two bare git repositories (an "upstream" and a "fork") under a temp
 * directory, exposes them over file:// remotes, and runs the built action
 * (dist/index.js) exactly the way the GitHub Actions runner would: inputs come
 * from INPUT_* environment variables, outputs are read back from the
 * GITHUB_OUTPUT file. No network access and no GitHub API calls happen, because
 * every branch input is pinned and skip-pr is on.
 *
 * Usage: npm test   (builds first)
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const ACTION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = mkdtempSync(path.join(os.tmpdir(), 'fork-sync-test-'))
process.once('exit', () => rmSync(ROOT, { recursive: true, force: true }))
const SERVER = path.join(ROOT, 'server')
const UPSTREAM = path.join(SERVER, 'acme', 'parent.git')
const FORK = path.join(SERVER, 'rui', 'fork.git')
const SERVER_URL = `file://${SERVER}`

const GIT_ENV = {
  HOME: ROOT,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'tester',
  GIT_AUTHOR_EMAIL: 'tester@example.com',
  GIT_COMMITTER_NAME: 'tester',
  GIT_COMMITTER_EMAIL: 'tester@example.com',
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString().trim()
}

function commitFile(cwd, name, content, message) {
  writeFileSync(path.join(cwd, name), `${content}\n`)
  git(cwd, 'add', name)
  git(cwd, 'commit', '-m', message)
}

// ---------------------------------------------------------------------------
// Fixture: upstream repo A ("acme/parent")
// ---------------------------------------------------------------------------
mkdirSync(UPSTREAM, { recursive: true })
git(UPSTREAM, 'init', '--bare', '-b', 'main')

const seed = path.join(ROOT, 'seed')
mkdirSync(seed)
git(seed, 'init', '-b', 'main')
git(seed, 'remote', 'add', 'origin', `file://${UPSTREAM}`)
commitFile(seed, 'README.md', '# hello', 'c1: initial commit')
git(seed, 'push', '-q', 'origin', 'main')

// ---------------------------------------------------------------------------
// Fixture: fork B ("rui/fork") — shares history with A, then diverges
// ---------------------------------------------------------------------------
git(ROOT, 'clone', '-q', '--bare', `file://${UPSTREAM}`, FORK)

const forkWork = path.join(ROOT, 'fork-work')
git(ROOT, 'clone', '-q', `file://${FORK}`, forkWork)
commitFile(forkWork, 'fork.txt', 'fork-only change', 'f1: fork-only commit')
git(forkWork, 'push', '-q', 'origin', 'main')

// upstream moves ahead of the fork
commitFile(seed, 'feature.txt', 'upstream work', 'u1: upstream commit')
git(seed, 'push', '-q', 'origin', 'main')

// ---------------------------------------------------------------------------
// Harness: run dist/index.js the way the runner would
// ---------------------------------------------------------------------------
const OUTPUT_FILE = path.join(ROOT, 'github-output.txt')
const SUMMARY_FILE = path.join(ROOT, 'summary.md')
const RUNNER_TEMP = path.join(ROOT, 'runner-temp')
mkdirSync(RUNNER_TEMP, { recursive: true })

function runAction(overrides = {}) {
  writeFileSync(OUTPUT_FILE, '')
  writeFileSync(SUMMARY_FILE, '')
  const env = {
    PATH: process.env.PATH,
    HOME: ROOT,
    GITHUB_REPOSITORY: 'rui/fork',
    GITHUB_SERVER_URL: SERVER_URL,
    GITHUB_OUTPUT: OUTPUT_FILE,
    GITHUB_STEP_SUMMARY: SUMMARY_FILE,
    RUNNER_TEMP: RUNNER_TEMP,
    INPUT_TOKEN: 'local-test-token',
    'INPUT_UPSTREAM-REPO': 'acme/parent',
    'INPUT_UPSTREAM-BRANCH': 'main',
    'INPUT_TARGET-BRANCH': 'main',
    'INPUT_HEAD-BRANCH': overrides['INPUT_SOURCE-BRANCH'] ? `sync/${overrides['INPUT_SOURCE-BRANCH']}-into-${overrides['INPUT_TARGET-BRANCH'] || 'main'}` : 'sync/upstream-main',
    'INPUT_ALLOW-HEAD-UPDATE': 'true', // Offline repeated skip-pr fixtures explicitly adopt their dedicated branch.
    'INPUT_MERGE-STRATEGY': 'merge',
    'INPUT_DRY-RUN': 'false',
    'INPUT_SKIP-PR': 'false',
    'INPUT_FAIL-ON-CONFLICT': 'false',
    ...overrides,
  }
  let exitCode = 0
  let output = ''
  try {
    output = execFileSync('node', [path.join(ACTION_DIR, 'dist', 'index.js')], {
      cwd: ACTION_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString()
  } catch (error) {
    exitCode = error.status ?? 1
    output = `${error.stdout?.toString() ?? ''}${error.stderr?.toString() ?? ''}`
  }
  const outputs = parseOutputFile(OUTPUT_FILE)
  return { exitCode, output, outputs }
}

/** Parses the GITHUB_OUTPUT file, which @actions/core writes in heredoc format. */
function parseOutputFile(file) {
  const outputs = {}
  const lines = readFileSync(file, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const heredoc = lines[i].match(/^(.+?)<<(.+)$/)
    if (heredoc) {
      const [, key, delimiter] = heredoc
      const value = []
      i += 1
      while (i < lines.length && lines[i] !== delimiter) {
        value.push(lines[i])
        i += 1
      }
      outputs[key] = value.join('\n')
    } else {
      const eq = lines[i].indexOf('=')
      if (eq > 0) outputs[lines[i].slice(0, eq)] = lines[i].slice(eq + 1)
    }
  }
  return outputs
}

// --- 1. diverged fork, default merge strategy --------------------------------
{
  const r = runAction({ 'INPUT_SKIP-PR': 'true' })
  assert.equal(r.exitCode, 0, `scenario 1 should succeed\n${r.output}`)
  assert.equal(r.outputs.status, 'synced')
  assert.equal(r.outputs['commit-count'], '2') // u1 + the merge commit
  assert.equal(r.outputs.pushed, 'true')
  assert.equal(r.outputs['pull-request-url'], '')
  const parents = git(FORK, 'show', '-s', '--format=%P', 'refs/heads/sync/upstream-main')
    .trim()
    .split(/\s+/)
  assert.equal(parents.length, 2, 'head branch should be a merge commit with two parents')
  assert.equal(r.outputs['target-sha'], git(FORK, 'rev-parse', 'refs/heads/main'), 'fork main must stay untouched')
  console.log('ok  1 - diverged fork: merge strategy creates and pushes a merge commit')
}

// Existing branches require explicit adoption unless verified against a matching PR.
{
  const before = git(FORK, 'rev-parse', 'refs/heads/sync/upstream-main')
  const r = runAction({ 'INPUT_SKIP-PR': 'true', 'INPUT_ALLOW-HEAD-UPDATE': 'false' })
  assert.equal(r.exitCode, 1, 'unverified existing head must not be overwritten')
  assert.equal(git(FORK, 'rev-parse', 'refs/heads/sync/upstream-main'), before)
}

// --- 2. fork already contains upstream -> up-to-date --------------------------
{
  git(forkWork, 'fetch', '-q', 'origin')
  git(forkWork, 'merge', '-q', '--no-edit', 'origin/sync/upstream-main')
  git(forkWork, 'push', '-q', 'origin', 'main')
  const r = runAction({ 'INPUT_SKIP-PR': 'true' })
  assert.equal(r.exitCode, 0, `scenario 2 should succeed\n${r.output}`)
  assert.equal(r.outputs.status, 'up-to-date')
  assert.equal(r.outputs.pushed, 'false')
  console.log('ok  2 - fork already contains upstream: reports up-to-date, pushes nothing')
}

// --- 3. conflicting merge -> head falls back to upstream tip ------------------
{
  commitFile(forkWork, 'conflict.txt', 'fork version', 'f2: fork edits conflict.txt')
  git(forkWork, 'push', '-q', 'origin', 'main')
  commitFile(seed, 'conflict.txt', 'upstream version', 'u2: upstream edits conflict.txt')
  git(seed, 'push', '-q', 'origin', 'main')

  const r = runAction({ 'INPUT_SKIP-PR': 'true' })
  assert.equal(r.exitCode, 0, `scenario 3 should succeed\n${r.output}`)
  assert.equal(r.outputs.status, 'conflicts')
  assert.equal(r.outputs['head-sha'], git(UPSTREAM, 'rev-parse', 'refs/heads/main'), 'head should be upstream tip')
  console.log('ok  3 - conflicting merge: head branch falls back to upstream tip')
}

// --- 3b. fail-on-conflict: true ------------------------------------------------
{
  const r = runAction({ 'INPUT_SKIP-PR': 'true', 'INPUT_FAIL-ON-CONFLICT': 'true', 'INPUT_HEAD-BRANCH': 'sync/rejected-conflict' })
  assert.equal(r.exitCode, 1, 'scenario 3b should fail')
  assert.throws(() => git(FORK, 'rev-parse', '--verify', 'refs/heads/sync/rejected-conflict'), 'rejected conflict must not publish a branch')
  assert.ok(r.output.toLowerCase().includes('conflict'), 'failure should mention the conflict')
  console.log('ok  3b - fail-on-conflict: true fails the run')
}

// --- 4. merge-strategy: tip ----------------------------------------------------
{
  const r = runAction({ 'INPUT_SKIP-PR': 'true', 'INPUT_MERGE-STRATEGY': 'tip' })
  assert.equal(r.exitCode, 0, `scenario 4 should succeed\n${r.output}`)
  assert.equal(r.outputs.status, 'conflicts', 'tip must report known merge conflicts')
  assert.equal(r.outputs['head-sha'], git(UPSTREAM, 'rev-parse', 'refs/heads/main'))
  console.log('ok  4 - merge-strategy: tip points head at upstream tip')
}

// --- 5. dry-run pushes nothing --------------------------------------------------
{
  commitFile(seed, 'more.txt', 'more upstream work', 'u3: another upstream commit')
  git(seed, 'push', '-q', 'origin', 'main')
  const before = git(FORK, 'rev-parse', 'refs/heads/sync/upstream-main')
  const r = runAction({ 'INPUT_DRY-RUN': 'true' })
  assert.equal(r.exitCode, 0, `scenario 5 should succeed\n${r.output}`)
  assert.equal(r.outputs.pushed, 'false')
  assert.equal(git(FORK, 'rev-parse', 'refs/heads/sync/upstream-main'), before, 'dry-run must not touch the remote')
  console.log('ok  5 - dry-run leaves the fork untouched')
}

// --- 6. custom head branch ------------------------------------------------------
{
  const r = runAction({ 'INPUT_SKIP-PR': 'true', 'INPUT_HEAD-BRANCH': 'sync/custom-branch' })
  assert.equal(r.exitCode, 0, `scenario 6 should succeed\n${r.output}`)
  assert.equal(r.outputs['head-sha'], git(FORK, 'rev-parse', 'refs/heads/sync/custom-branch'))
  console.log('ok  6 - custom head-branch is pushed')
}

// --- 7. branch-to-branch sync (source-branch) -----------------------------------
{
  git(forkWork, 'checkout', '-q', '-b', 'develop')
  commitFile(forkWork, 'branch-sync.txt', 'work on develop', 'd1: develop commit')
  git(forkWork, 'push', '-q', 'origin', 'develop')
  const r = runAction({
    'INPUT_UPSTREAM-REPO': '',
    'INPUT_UPSTREAM-BRANCH': '',
    'INPUT_SOURCE-BRANCH': 'develop',
    'INPUT_TARGET-BRANCH': 'main',
    'INPUT_SKIP-PR': 'true',
  })
  assert.equal(r.exitCode, 0, `scenario 7 should succeed\n${r.output}`)
  assert.equal(r.outputs.status, 'synced')
  assert.equal(
    r.outputs['head-sha'],
    git(FORK, 'rev-parse', 'refs/heads/develop'),
    'head should fast-forward to the source branch tip'
  )
  assert.equal(r.outputs['commit-count'], '1')
  assert.equal(
    git(FORK, 'rev-parse', 'refs/heads/main'),
    r.outputs['target-sha'],
    'target branch must stay untouched'
  )
  assert.equal(
    r.outputs['head-sha'],
    git(FORK, 'rev-parse', 'refs/heads/sync/develop-into-main'),
    'explicit legacy head should remain usable with adoption enabled'
  )
  console.log('ok  7 - branch-to-branch sync: source fast-forwards into configured sync head')
}

// --- 7b. branch sync: target already contains source -> up-to-date ---------------
{
  git(forkWork, 'fetch', '-q', 'origin')
  git(forkWork, 'checkout', '-q', 'main')
  git(forkWork, 'merge', '-q', '--ff-only', 'origin/sync/develop-into-main')
  git(forkWork, 'push', '-q', 'origin', 'main')
  const r = runAction({
    'INPUT_UPSTREAM-REPO': '',
    'INPUT_UPSTREAM-BRANCH': '',
    'INPUT_SOURCE-BRANCH': 'develop',
    'INPUT_TARGET-BRANCH': 'main',
    'INPUT_SKIP-PR': 'true',
  })
  assert.equal(r.exitCode, 0, `scenario 7b should succeed\n${r.output}`)
  assert.equal(r.outputs.status, 'up-to-date')
  assert.equal(r.outputs.pushed, 'false')
  console.log('ok 7b - branch sync: target already contains source -> up-to-date, pushes nothing')
}

// --- 8. branch sync: conflicting merge -> head falls back to source tip -----------
{
  git(forkWork, 'checkout', '-q', 'develop')
  commitFile(forkWork, 'shared.txt', 'develop version', 'd2: develop edits shared.txt')
  git(forkWork, 'push', '-q', 'origin', 'develop')
  git(forkWork, 'checkout', '-q', 'main')
  commitFile(forkWork, 'shared.txt', 'main version', 'm1: main edits shared.txt')
  git(forkWork, 'push', '-q', 'origin', 'main')

  const r = runAction({
    'INPUT_UPSTREAM-REPO': '',
    'INPUT_UPSTREAM-BRANCH': '',
    'INPUT_SOURCE-BRANCH': 'develop',
    'INPUT_TARGET-BRANCH': 'main',
    'INPUT_SKIP-PR': 'true',
  })
  assert.equal(r.exitCode, 0, `scenario 8 should succeed\n${r.output}`)
  assert.equal(r.outputs.status, 'conflicts')
  assert.equal(
    r.outputs['head-sha'],
    git(FORK, 'rev-parse', 'refs/heads/develop'),
    'head should fall back to the source branch tip'
  )
  console.log('ok  8 - branch sync: conflicting merge falls back to the source branch tip')
}

// --- 9. branch sync: source-branch == target-branch -> error ----------------------
{
  const r = runAction({
    'INPUT_UPSTREAM-REPO': '',
    'INPUT_UPSTREAM-BRANCH': '',
    'INPUT_SOURCE-BRANCH': 'main',
    'INPUT_TARGET-BRANCH': 'main',
    'INPUT_SKIP-PR': 'true',
  })
  assert.equal(r.exitCode, 1, 'scenario 9 should fail')
  assert.ok(r.output.includes('must differ from target-branch'), `unexpected output: ${r.output}`)
  console.log('ok  9 - source-branch equal to target-branch is rejected')
}

// --- 9b. branch sync combined with upstream inputs -> error -----------------------
{
  const r = runAction({ 'INPUT_SOURCE-BRANCH': 'develop', 'INPUT_SKIP-PR': 'true' })
  assert.equal(r.exitCode, 1, 'scenario 9b should fail')
  assert.ok(r.output.includes('cannot be combined'), `unexpected output: ${r.output}`)
  console.log('ok 9b - source-branch combined with upstream-repo/upstream-branch is rejected')
}

// --- 9c. branch sync: head-branch == source-branch -> error ------------------------
{
  const r = runAction({
    'INPUT_UPSTREAM-REPO': '',
    'INPUT_UPSTREAM-BRANCH': '',
    'INPUT_SOURCE-BRANCH': 'develop',
    'INPUT_TARGET-BRANCH': 'main',
    'INPUT_HEAD-BRANCH': 'develop',
    'INPUT_SKIP-PR': 'true',
  })
  assert.equal(r.exitCode, 1, 'scenario 9c should fail')
  assert.ok(r.output.includes('must differ from source-branch'), `unexpected output: ${r.output}`)
  console.log('ok 9c - head-branch equal to source-branch is rejected (would overwrite it)')
}

// --- 10. mode: branch without source-branch -> error ----------------------------
{
  const r = runAction({
    'INPUT_MODE': 'branch',
    'INPUT_UPSTREAM-REPO': '',
    'INPUT_UPSTREAM-BRANCH': '',
    'INPUT_TARGET-BRANCH': 'main',
    'INPUT_SKIP-PR': 'true',
  })
  assert.equal(r.exitCode, 1, 'scenario 10 should fail')
  assert.ok(r.output.includes("requires 'source-branch'"), `unexpected output: ${r.output}`)
  console.log('ok 10 - mode: branch without source-branch is rejected')
}

// --- 10b. mode: fork combined with source-branch -> error -----------------------
{
  const r = runAction({
    'INPUT_MODE': 'fork',
    'INPUT_SOURCE-BRANCH': 'develop',
    'INPUT_UPSTREAM-REPO': '',
    'INPUT_UPSTREAM-BRANCH': '',
    'INPUT_TARGET-BRANCH': 'main',
    'INPUT_SKIP-PR': 'true',
  })
  assert.equal(r.exitCode, 1, 'scenario 10b should fail')
  assert.ok(r.output.includes('cannot be combined'), `unexpected output: ${r.output}`)
  console.log('ok 10b - mode: fork combined with source-branch is rejected')
}

// --- 10c. invalid mode value -> error -------------------------------------------
{
  const r = runAction({
    'INPUT_MODE': 'branchs',
    'INPUT_UPSTREAM-REPO': '',
    'INPUT_UPSTREAM-BRANCH': '',
    'INPUT_TARGET-BRANCH': 'main',
    'INPUT_SKIP-PR': 'true',
  })
  assert.equal(r.exitCode, 1, 'scenario 10c should fail')
  assert.ok(r.output.includes('mode must be'), `unexpected output: ${r.output}`)
  console.log('ok 10c - invalid mode value is rejected')
}

// --- 10d. mode: branch runs the branch sync explicitly ---------------------------
{
  const r = runAction({
    'INPUT_MODE': 'branch',
    'INPUT_SOURCE-BRANCH': 'develop',
    'INPUT_UPSTREAM-REPO': '',
    'INPUT_UPSTREAM-BRANCH': '',
    'INPUT_TARGET-BRANCH': 'main',
    'INPUT_SKIP-PR': 'true',
  })
  assert.equal(r.exitCode, 0, `scenario 10d should succeed\n${r.output}`)
  // develop and main still conflict (scenario 8 fixture), so the head falls
  // back to the source tip; the routing is what this scenario pins.
  assert.equal(r.outputs.status, 'conflicts')
  assert.equal(
    r.outputs['head-sha'],
    git(FORK, 'rev-parse', 'refs/heads/develop'),
    'explicit mode: branch must sync the source branch, not fall back to fork mode'
  )
  console.log('ok 10d - mode: branch runs the branch sync explicitly')
}

// --- 11. branch mode: conventional-commit default PR title -----------------------
{
  const r = runAction({
    'INPUT_MODE': 'branch',
    'INPUT_SOURCE-BRANCH': 'develop',
    'INPUT_UPSTREAM-REPO': '',
    'INPUT_UPSTREAM-BRANCH': '',
    'INPUT_TARGET-BRANCH': 'main',
    'INPUT_SKIP-PR': 'true',
  })
  assert.equal(r.exitCode, 0, `scenario 11 should succeed\n${r.output}`)
  assert.ok(
    r.output.includes('sync(branch): Sync develop into main'),
    `branch-mode default title should be conventional and omit the repo\n${r.output}`
  )
  console.log('ok 11 - branch mode default PR title: "sync(branch): Sync develop into main"')
}

// --- 11b. fork mode: conventional-commit default PR title ------------------------
{
  const r = runAction({ 'INPUT_SKIP-PR': 'true' })
  assert.equal(r.exitCode, 0, `scenario 11b should succeed\n${r.output}`)
  assert.ok(
    r.output.includes('sync(pull): Sync acme/parent:main (upstream) into main'),
    `fork-mode default title should be conventional and mark the upstream\n${r.output}`
  )
  console.log('ok 11b - fork mode default PR title: "sync(pull): Sync acme/parent:main (upstream) into main"')
}

// --- 11c. custom pr-title overrides the default ----------------------------------
{
  const r = runAction({
    'INPUT_MODE': 'branch',
    'INPUT_SOURCE-BRANCH': 'develop',
    'INPUT_UPSTREAM-REPO': '',
    'INPUT_UPSTREAM-BRANCH': '',
    'INPUT_TARGET-BRANCH': 'main',
    'INPUT_PR-TITLE': 'chore: my custom sync title',
    'INPUT_SKIP-PR': 'true',
  })
  assert.equal(r.exitCode, 0, `scenario 11c should succeed\n${r.output}`)
  assert.ok(
    r.output.includes('Pull request title: "chore: my custom sync title"'),
    `custom pr-title must win over the default\n${r.output}`
  )
  console.log('ok 11c - custom pr-title overrides the default')
}

// --- 12. job summary: linked branches/commits and a status icon -----------------
{
  const r = runAction({ 'INPUT_SKIP-PR': 'true' })
  assert.equal(r.exitCode, 0, `scenario 12 should succeed\n${r.output}`)
  const summary = readFileSync(SUMMARY_FILE, 'utf8')
  assert.ok(summary.includes('<h2>Sync upstream</h2>'), `fork-mode heading\n${summary}`)
  assert.ok(
    summary.includes(`<a href="${SERVER_URL}/acme/parent/tree/main">acme/parent:main</a>`),
    `upstream branch should be an HTML anchor (markdown is inert inside summary HTML)\n${summary}`
  )
  assert.ok(
    summary.includes(
      `<a href="${SERVER_URL}/acme/parent/commit/${r.outputs['upstream-sha']}">${r.outputs['upstream-sha'].slice(0, 7)}</a>`
    ),
    `upstream commit should be an HTML anchor\n${summary}`
  )
  assert.ok(
    summary.includes(`<a href="${SERVER_URL}/rui/fork/tree/main">rui/fork:main</a>`),
    `target branch should be an HTML anchor\n${summary}`
  )
  assert.ok(
    summary.includes(
      `<a href="${SERVER_URL}/rui/fork/commit/${r.outputs['target-sha']}">${r.outputs['target-sha'].slice(0, 7)}</a>`
    ),
    `target commit should be an HTML anchor\n${summary}`
  )
  assert.ok(summary.includes('⚠️ status: conflicts'), `status line should carry an icon\n${summary}`)
  console.log('ok 12 - summary links branches and commits via HTML anchors; status line has an icon')
}

// --- 12b. summary on the up-to-date path -----------------------------------------
{
  git(forkWork, 'fetch', '-q', 'origin')
  git(forkWork, 'checkout', '-q', 'main')
  git(forkWork, 'reset', '-q', '--hard', 'origin/sync/upstream-main')
  git(forkWork, 'push', '-q', '--force', 'origin', 'main')
  const r = runAction({ 'INPUT_SKIP-PR': 'true' })
  assert.equal(r.exitCode, 0, `scenario 12b should succeed\n${r.output}`)
  assert.equal(r.outputs.status, 'up-to-date')
  const summary = readFileSync(SUMMARY_FILE, 'utf8')
  assert.ok(summary.includes('✅ status: up-to-date'), `up-to-date should carry the check icon\n${summary}`)
  console.log('ok 12b - summary on the up-to-date path: "✅ status: up-to-date"')
}

// --- 12c. summary on the synced path ---------------------------------------------
{
  commitFile(seed, 'newer.txt', 'even more upstream work', 'u4: upstream commit after catch-up')
  git(seed, 'push', '-q', 'origin', 'main')
  const r = runAction({ 'INPUT_SKIP-PR': 'true' })
  assert.equal(r.exitCode, 0, `scenario 12c should succeed\n${r.output}`)
  assert.equal(r.outputs.status, 'synced')
  const summary = readFileSync(SUMMARY_FILE, 'utf8')
  assert.ok(summary.includes('🔄 status: synced'), `synced should carry the sync icon\n${summary}`)
  console.log('ok 12c - summary on the synced path: "🔄 status: synced"')
}

// --- 12d. summary heading reflects the mode --------------------------------------
{
  const r = runAction({
    'INPUT_MODE': 'branch',
    'INPUT_SOURCE-BRANCH': 'develop',
    'INPUT_UPSTREAM-REPO': '',
    'INPUT_UPSTREAM-BRANCH': '',
    'INPUT_TARGET-BRANCH': 'main',
    'INPUT_SKIP-PR': 'true',
  })
  assert.equal(r.exitCode, 0, `scenario 12d should succeed\n${r.output}`)
  const summary = readFileSync(SUMMARY_FILE, 'utf8')
  assert.ok(summary.includes('<h2>Sync branch</h2>'), `branch-mode heading\n${summary}`)
  console.log('ok 12d - summary heading reflects the mode')
}

{
  const branch = 'audit"><h1>FORGED</h1>'
  git(seed, 'branch', branch)
  git(seed, 'push', '-q', 'origin', branch)
  const r = runAction({ 'INPUT_UPSTREAM-BRANCH': branch, 'INPUT_DRY-RUN': 'true' })
  assert.equal(r.exitCode, 0, r.output)
  const summary = readFileSync(SUMMARY_FILE, 'utf8')
  assert.ok(!summary.includes('<h1>FORGED</h1>'), 'branch markup must be escaped')
  assert.ok(summary.includes('&lt;h1&gt;FORGED&lt;/h1&gt;'))
}

rmSync(ROOT, { recursive: true, force: true })
console.log('\nAll local scenarios passed.')
