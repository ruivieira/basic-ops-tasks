import { syncRepository } from '../src/git-ops.ts'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { execFile, execFileSync, spawnSync } from 'node:child_process'

const root = mkdtempSync(join(tmpdir(), 'sync-security-'))
after(() => rmSync(root, { recursive: true, force: true }))
const home = join(root, 'home')
mkdirSync(home)
const baseEnv = { PATH: process.env.PATH, HOME: home, GITHUB_REPOSITORY: 'owner/fork',
  GITHUB_SERVER_URL: 'https://github.com', INPUT_TOKEN: 'FAKE_MAIN_TOKEN',
  'INPUT_UPSTREAM-TOKEN': 'FAKE_UPSTREAM_TOKEN', 'INPUT_UPSTREAM-REPO': 'owner/upstream',
  'INPUT_UPSTREAM-BRANCH': 'main', 'INPUT_TARGET-BRANCH': 'main', 'INPUT_MERGE-STRATEGY': 'merge',
  'INPUT_SKIP-PR': 'true', 'INPUT_DRY-RUN': 'true', 'INPUT_FAIL-ON-CONFLICT': 'false' }

function fixture() {
  const dir = mkdtempSync(join(root, 'fixture-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: {
    PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
  }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main', 'seed')
  git('-C', 'seed', 'commit', '--allow-empty', '-m', 'initial')
  git('clone', '--bare', 'seed', 'fork.git')
  git('-C', 'seed', 'commit', '--allow-empty', '-m', 'incoming')
  const opts = { workspace: join(dir, 'workspace'), originUrl: `file://${dir}/fork.git`,
    upstreamUrl: `file://${dir}/seed`, targetBranch: 'main', upstreamBranch: 'main',
    headBranch: 'sync/test', mergeStrategy: 'merge', mergeMessage: 'sync', push: true }
  return { dir, git, opts }
}

test('HTTPS credentials are scoped to subprocess config, never argv or persisted remotes', async () => {
  const { dir, opts } = fixture()
  const bin = join(dir, 'bin'); mkdirSync(bin)
  const capture = join(dir, 'capture')
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  writeFileSync(join(bin, 'git'), `#!${process.execPath}\nconst fs = require('node:fs'); const cp = require('node:child_process');\nconst args = process.argv.slice(2);\nif(args[0] === 'fetch') {\n const config = Array.from({length: Number(process.env.GIT_CONFIG_COUNT)}, (_,i) => [process.env['GIT_CONFIG_KEY_'+i],process.env['GIT_CONFIG_VALUE_'+i]]);\n fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args,config,hasInputToken: !!process.env.INPUT_TOKEN})); process.exit(128);\n}\nconst result = cp.spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'}); process.exit(result.status ?? 1);\n`, { mode: 0o755 })
  const old = process.env.PATH
  try {
    process.env.PATH = `${bin}:${old}`
    await assert.rejects(syncRepository({ ...opts, originUrl: 'https://github.com/owner/fork.git',
      upstreamUrl: 'https://github.com/owner/upstream.git', originToken: 'FAKE_MAIN_TOKEN', upstreamToken: 'FAKE_UPSTREAM_TOKEN' }))
    const seen = JSON.parse(readFileSync(capture, 'utf8'))
    assert.ok(!JSON.stringify(seen.args).includes('TOKEN'))
    assert.equal(seen.hasInputToken, false)
    assert.deepEqual(seen.config.find(([key]) => key.endsWith('.extraheader')), [
      'http.https://github.com/owner/fork.git.extraheader',
      `AUTHORIZATION: basic ${Buffer.from('x-access-token:FAKE_MAIN_TOKEN').toString('base64')}`,
    ])
    assert.ok(!readFileSync(join(opts.workspace, '.git/config'), 'utf8').includes('TOKEN'))
  } finally { process.env.PATH = old }
})

test('force-with-lease rejects a branch created after the snapshot', async () => {
  const { dir, git, opts } = fixture()
  const bin = join(dir, 'bin'); mkdirSync(bin)
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const target = git('--git-dir=fork.git', 'rev-parse', 'main')
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$1" = push ]; then "${realGit}" --git-dir="${dir}/fork.git" update-ref refs/heads/sync/test ${target}; fi\nexec "${realGit}" "$@"\n`, { mode: 0o755 })
  const old = process.env.PATH
  try {
    process.env.PATH = `${bin}:${old}`
    await assert.rejects(syncRepository(opts), /stale info/)
    assert.equal(git('--git-dir=fork.git', 'rev-parse', 'sync/test'), target)
  } finally { process.env.PATH = old }
})

test('unexpected ancestry and merge errors fail closed without publishing', async () => {
  for (const command of ['merge-base', 'merge']) {
    const { dir, git, opts } = fixture()
    const bin = join(dir, 'bin'); mkdirSync(bin)
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$1" = ${command} ]; then echo simulated-operational-failure >&2; exit 128; fi\nexec "${realGit}" "$@"\n`, { mode: 0o755 })
    const old = process.env.PATH
    try {
      process.env.PATH = `${bin}:${old}`
      await assert.rejects(syncRepository(opts), /simulated-operational-failure/)
      assert.throws(() => git('--git-dir=fork.git', 'rev-parse', '--verify', 'sync/test'))
    } finally { process.env.PATH = old }
  }
})

test('inherited Git configuration cannot install checkout hooks', async () => {
  const { dir, opts } = fixture()
  const hooks = join(dir, 'hooks'); mkdirSync(hooks)
  const sentinel = join(dir, 'executed')
  writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o755 })
  const keys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']
  const old = keys.map(key => process.env[key])
  try {
    Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks })
    await syncRepository(opts)
    assert.ok(!readdirSync(dir).includes('executed'))
  } finally { keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i] }) }
})

test('PR marker permits same-identity reruns, rejects foreign heads, and distinguishes targets', async () => {
  const { dir, git } = fixture()
  git('-C', 'seed', 'commit', '--allow-empty', '-m', '<img src=x> @everyone [spoof](https://example.com)')
  mkdirSync(join(dir, 'owner'))
  symlinkSync(join(dir, 'fork.git'), join(dir, 'owner/fork.git'))
  symlinkSync(join(dir, 'seed/.git'), join(dir, 'owner/upstream.git'))
  const output = join(dir, 'output'); writeFileSync(output, '')
  const summary = join(dir, 'summary'); writeFileSync(summary, '')
  let pr
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET') {
      const query = new URL(req.url, 'http://localhost').searchParams
      res.end(JSON.stringify(pr && query.get('head') === `owner:${pr.head}` && query.get('base') === pr.base ? [pr] : []))
    } else {
      let body = ''; for await (const chunk of req) body += chunk
      pr = { ...pr, ...JSON.parse(body), number: 1, html_url: 'https://github.com/owner/fork/pull/1' }
      res.end(JSON.stringify(pr))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const run = (extra = {}) => promisify(execFile)(process.execPath, [resolve('dist/index.js')], { env: {
    ...baseEnv, GITHUB_SERVER_URL: `file://${dir}`, GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
    GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: dir,
    'INPUT_DRY-RUN': 'false', 'INPUT_SKIP-PR': 'false', ...extra,
  } })
  try {
    await run()
    assert.ok(!pr.body.includes('<img src=x>'))
    assert.ok(!pr.body.includes('@everyone'))
    assert.ok(pr.body.includes('&lt;img src=x&gt;'))
    const first = pr.head
    assert.match(first, /^sync\/[a-f0-9]{64}$/)
    assert.match(pr.body, /<!-- basic-ops-tasks:sync:[a-f0-9]{64} -->/)
    git('-C', 'seed', 'commit', '--allow-empty', '-m', 'another')
    await run()
    assert.equal(pr.head, first)
    pr.body = 'unverified PR'
    await assert.rejects(run(), error => error.stdout.includes('not verified'))
    git('--git-dir=fork.git', 'branch', 'release', 'main')
    await run({ 'INPUT_TARGET-BRANCH': 'release' })
    assert.notEqual(pr.head, first)
    assert.ok(!readdirSync(dir).some(name => name.startsWith('fork-sync-')))
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('upstream metadata uses the read-only upstream token', async () => {
  let auth
  const server = createServer((req, res) => {
    auth = req.headers.authorization
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: 'fixture: stop before Git' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await promisify(execFile)(process.execPath, [resolve('dist/index.js')], { env: {
      ...baseEnv, GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
      'INPUT_UPSTREAM-BRANCH': '',
    } }).catch(() => {})
    assert.equal(auth, 'token FAKE_UPSTREAM_TOKEN')
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('Git failure does not disclose credentials or retain its workspace', () => {
  const bin = join(root, 'bin'); mkdirSync(bin)
  const temp = join(root, 'runner'); mkdirSync(temp)
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$1" = remote ] && [ "$3" = upstream ]; then echo failure >&2; exit 1; fi\nexec "${realGit}" "$@"\n`, { mode: 0o755 })
  const r = spawnSync(process.execPath, [resolve('dist/index.js')], { encoding: 'utf8',
    env: { ...baseEnv, PATH: `${bin}:${baseEnv.PATH}`, RUNNER_TEMP: temp } })
  assert.equal(r.status, 1)
  const diagnostics = r.stdout.split('\n').filter(l => !l.startsWith('::add-mask::')).join('\n')
  assert.ok(!diagnostics.includes('FAKE_UPSTREAM_TOKEN'), diagnostics)
  assert.ok(!diagnostics.includes('FAKE_MAIN_TOKEN'), diagnostics)
  assert.deepEqual(readdirSync(temp), [])
})
