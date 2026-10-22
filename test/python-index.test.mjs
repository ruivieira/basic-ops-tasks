import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  compareVersions,
  matchesSpecifierSet,
  parseSpecifierSet,
  parseVersion,
} from '../src/pep440.ts'
import {
  checkRequirements,
  normalizeName,
  parseRequirementsFile,
  versionFromFilename,
} from '../src/requirements.ts'
import { buildMarkerEnvironment, evaluateMarkerText, parseMarker } from '../src/markers.ts'

const root = mkdtempSync(join(tmpdir(), 'python-index-test-'))
after(() => rmSync(root, { recursive: true, force: true }))

function version(text) {
  const parsed = parseVersion(text)
  assert.ok(parsed, `expected "${text}" to parse`)
  return parsed
}

function compare(left, right) {
  return compareVersions(version(left), version(right))
}

function matches(specifier, candidate) {
  return matchesSpecifierSet(parseSpecifierSet(specifier), version(candidate))
}

function requirement(text, specifier) {
  return {
    raw: text,
    source: 'test:1',
    kind: 'index',
    name: text,
    extras: [],
    specifier: specifier === undefined ? null : specifier === null ? null : parseSpecifierSet(specifier),
    url: null,
  }
}

test('PEP 440 versions order like packaging', () => {
  const ordered = [
    '1.0.dev1',
    '1.0a1',
    '1.0a1.post1',
    '1.0b1',
    '1.0rc1',
    '1.0',
    '1.0+abc',
    '1.0.post1',
    '1.1.dev1',
  ]
  for (let index = 1; index < ordered.length; index++) {
    assert.equal(compare(ordered[index - 1], ordered[index]), -1, `${ordered[index - 1]} < ${ordered[index]}`)
    assert.equal(compare(ordered[index], ordered[index - 1]), 1)
  }
  assert.equal(compare('1.0', '1.0.0'), 0)
  assert.equal(compare('1!0.1', '2.0'), 1)
  assert.equal(compare('1.0+1', '1.0+abc'), 1)
  assert.equal(compare('1.0+abc.2', '1.0+abc'), 1)
  assert.equal(parseVersion('not-a-version'), null)
})

test('PEP 440 specifiers include the exclusive-comparison exclusions', () => {
  assert.equal(matches('>=1.0,<2.0', '1.9'), true)
  assert.equal(matches('>=1.0,<2.0', '2.0'), false)
  assert.equal(matches('>=1.0,<2.0', '2.0rc1'), false)
  assert.equal(matches('~=1.4.5', '1.4.9'), true)
  assert.equal(matches('~=1.4.5', '1.4.4'), false)
  assert.equal(matches('~=1.4.5', '1.5.0'), false)
  assert.equal(matches('~=1.4', '1.9.9'), true)
  assert.equal(matches('~=1.4', '2.0'), false)
  assert.equal(matches('==1.4.*', '1.4.9'), true)
  assert.equal(matches('==1.4.*', '1.5'), false)
  assert.equal(matches('!=1.4.*', '1.4.9'), false)
  assert.equal(matches('!=1.4.*', '1.5'), true)
  assert.equal(matches('==1.0', '1.0+local'), true)
  assert.equal(matches('>1.0', '1.0.post1'), false)
  assert.equal(matches('>1.0', '1.0+local'), false)
  assert.equal(matches('>1.0', '1.1'), true)
  assert.equal(matches('<1.0', '1.0rc1'), false)
  assert.equal(matches('<1.0', '0.9'), true)
  assert.equal(matches('<=1.0', '1.0+local'), true)
  assert.equal(matches('===1.0.0', '1.0.0'), true)
  assert.equal(matches('===1.0.0', '1.0'), false)
  assert.throws(() => parseSpecifierSet('~=1'), /at least two release segments/)
  assert.throws(() => parseSpecifierSet('>=oops'), /Invalid version/)
})

test('requirements files support includes, continuations, markers and pip options', async () => {
  const dir = join(root, 'requirements')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'requirements.txt'),
    [
      '# top-level comment',
      '-r extra.txt',
      '--index-url https://example.com/simple',
      '--extra-index-url=https://mirror.example.com/simple',
      'requests[security]>=2.0, <3 ; python_version >= "3.8"',
      'urllib3==2.2.1 \\',
      '    --hash=sha256:deadbeef',
      '-e .',
      'git+https://github.com/psf/requests.git@main',
      'https://example.com/pkg-1.0-py3-none-any.whl',
      'local-dep @ file:///tmp/dep # trailing comment',
      '--pre',
      '--find-links ./wheels',
      '--use-pep517',
    ].join('\n')
  )
  writeFileSync(join(dir, 'extra.txt'), 'flask==3.0.0\n')
  const parsed = await parseRequirementsFile(join(dir, 'requirements.txt'))
  assert.equal(parsed.allowPrerelease, true)
  assert.equal(parsed.requirements.length, 7)
  const [flask, requests, urllib3, editable, vcs, url, local] = parsed.requirements
  assert.equal(flask.name, 'flask')
  assert.equal(flask.specifier.text, '==3.0.0')
  assert.equal(requests.name, 'requests')
  assert.deepEqual(requests.extras, ['security'])
  assert.equal(requests.specifier.text, '>=2.0, <3')
  assert.equal(requests.marker, 'python_version >= "3.8"')
  assert.equal(urllib3.specifier.text, '==2.2.1')
  assert.equal(editable.kind, 'editable')
  assert.equal(vcs.kind, 'vcs')
  assert.equal(url.kind, 'url')
  assert.equal(local.kind, 'url')
  assert.equal(local.name, 'local-dep')
  assert.ok(parsed.warnings.some(warning => warning.includes('--find-links')))
  assert.ok(parsed.warnings.some(warning => warning.includes('--use-pep517') && warning.includes('not evaluated')))
  assert.equal(
    parsed.warnings.filter(warning => warning.includes('index options in requirements files are ignored')).length,
    2
  )
})

test('distribution filenames map to versions', () => {
  assert.equal(versionFromFilename('requests-2.32.0-py3-none-any.whl', normalizeName('requests')).raw, '2.32.0')
  assert.equal(versionFromFilename('zope.interface-5.0.tar.gz', normalizeName('zope.interface')).raw, '5.0')
  assert.equal(versionFromFilename('my-package-1.0.post1.tar.gz', normalizeName('my-package')).raw, '1.0.post1')
  assert.equal(versionFromFilename('my-package-1.0-py3-none-any.whl', normalizeName('my-package')).raw, '1.0')
  assert.equal(versionFromFilename('unrelated-1.0.tar.gz', normalizeName('other')), null)
})

function projectJson(name, versions, yanked = []) {
  return JSON.stringify({
    meta: { 'api-version': '1.0' },
    name,
    files: versions.map(item => ({
      filename: `${name.replace(/-/g, '_')}-${item}-py3-none-any.whl`,
      url: 'https://example.invalid/file.whl',
      yanked: yanked.includes(item),
    })),
    versions,
  })
}

async function indexServer() {
  const state = { authorization: null, requests: [] }
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const path = url.pathname
    state.authorization = request.headers.authorization ?? state.authorization
    state.requests.push(path)
    if (path === '/simple/requests/') {
      response.setHeader('content-type', 'application/vnd.pypi.simple.v1+json')
      response.end(projectJson('requests', ['2.31.0', '2.32.0'], ['2.31.0']))
      return
    }
    if (path === '/simple/legacy/') {
      response.setHeader('content-type', 'text/html')
      response.end(
        '<html><body>' +
          '<a href="../../files/legacy-1.0.tar.gz">legacy-1.0.tar.gz</a>' +
          '<a href="../../files/legacy-1.1.tar.gz" data-yanked="broken">legacy-1.1.tar.gz</a>' +
          '</body></html>'
      )
      return
    }
    if (path === '/private/onlyprivate/') {
      if (request.headers.authorization !== 'Bearer index-secret') {
        response.writeHead(401)
        response.end()
        return
      }
      response.setHeader('content-type', 'application/vnd.pypi.simple.v1+json')
      response.end(projectJson('onlyprivate', ['1.0']))
      return
    }
    if (path === '/artifact.whl') {
      response.writeHead(200)
      response.end()
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return { server, base, state }
}

test('checks names and versions against JSON and HTML indexes', async () => {
  const { server, base } = await indexServer()
  try {
    const results = await checkRequirements(
      [
        requirement('requests', '>=2.0'),
        requirement('requests', '<2.32'),
        requirement('requests', '==2.31.0'),
        requirement('requests', '==1.0'),
        requirement('legacy', '>=1.0'),
        requirement('legacy', '>1.0'),
        requirement('nonexistent'),
      ],
      { indexUrls: [`${base}/simple`], concurrency: 3 }
    )
    const statuses = results.map(result => result.status)
    assert.equal(statuses[0], 'ok')
    assert.deepEqual(statuses, ['ok', 'missing', 'ok', 'missing', 'ok', 'missing', 'missing'])
    assert.match(results[0].detail, /resolves to 2\.32\.0/)
    assert.match(results[1].detail, /all versions matching "<2\.32" are yanked/)
    assert.match(results[2].detail, /2\.31\.0 \(yanked; allowed by exact pin\)/)
    assert.match(results[3].detail, /available: 2\.32\.0, 2\.31\.0 \(yanked\)/)
    assert.match(results[4].detail, /resolves to 1\.0/)
    assert.match(results[5].detail, /all versions matching ">1\.0" are yanked/)
    assert.match(results[6].detail, /project "nonexistent" not found/)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('requirements file and includes are confined to the workspace', async () => {
  const workspace = join(root, 'confined')
  mkdirSync(workspace, { recursive: true })
  const outside = join(root, 'outside-requirements.txt')
  writeFileSync(outside, 'flask==3.0.0\n')
  writeFileSync(join(workspace, 'requirements.txt'), 'requests==2.0.0\n')
  writeFileSync(join(workspace, 'escape.txt'), `-r ${outside}\n`)

  await assert.rejects(
    parseRequirementsFile(join(workspace, 'escape.txt'), { workspace }),
    /outside GITHUB_WORKSPACE/
  )
  await assert.rejects(parseRequirementsFile(outside, { workspace }), /outside GITHUB_WORKSPACE/)

  symlinkSync(outside, join(workspace, 'link.txt'))
  await assert.rejects(parseRequirementsFile(join(workspace, 'link.txt'), { workspace }), /outside GITHUB_WORKSPACE/)

  const inside = await parseRequirementsFile(join(workspace, 'requirements.txt'), { workspace })
  assert.equal(inside.requirements[0].name, 'requests')
})

test('PEP 508 environment markers are evaluated against the target interpreter', () => {
  const environment = buildMarkerEnvironment({ pythonVersion: '3.12.7', platform: 'linux', machine: 'x86_64' })
  assert.equal(evaluateMarkerText("sys_platform == 'emscripten'", environment), false)
  assert.equal(evaluateMarkerText("sys_platform == 'linux'", environment), true)
  assert.equal(evaluateMarkerText("python_full_version == '3.13.*'", environment), false)
  assert.equal(evaluateMarkerText("python_full_version < '3.14'", environment), true)
  assert.equal(evaluateMarkerText("python_version >= '3.10' and sys_platform != 'win32'", environment), true)
  assert.equal(evaluateMarkerText("(python_version < '3.10' or sys_platform == 'darwin')", environment), false)
  assert.equal(evaluateMarkerText("'linux' in sys_platform", environment), true)
  assert.equal(evaluateMarkerText("'win' not in sys_platform", environment), true)
  assert.equal(evaluateMarkerText("python_version ~= '3.12'", environment), true)
  assert.equal(evaluateMarkerText("extra == 'adapter'", environment), false)
  assert.equal(evaluateMarkerText("python_version > '9.0'", environment), false)
  assert.throws(() => parseMarker("bogus_variable == 'x'"), /Unknown environment marker variable/)
  assert.throws(() => parseMarker("python_version >= "), /Unexpected end/)
  assert.equal(buildMarkerEnvironment({ pythonVersion: '3.12' }).python_full_version, '3.12')
  assert.throws(() => buildMarkerEnvironment({ pythonVersion: 'three' }), /must look like/)
})

test('marker-gated requirements are skipped instead of checked', async () => {
  const { server, base, state } = await indexServer()
  const environment = buildMarkerEnvironment({ pythonVersion: '3.12.7', platform: 'linux', machine: 'x86_64' })
  try {
    const results = await checkRequirements(
      [
        { ...requirement('httpx2-jsfetch', '==1.0'), marker: "sys_platform == 'emscripten'" },
        { ...requirement('requests', '>=2.0'), marker: "python_version >= '3.10'" },
      ],
      { indexUrls: [`${base}/simple`], markerEnvironment: environment }
    )
    assert.equal(results[0].status, 'skipped')
    assert.match(results[0].detail, /environment marker not satisfied \(python 3\.12, linux\/x86_64\)/)
    assert.equal(results[1].status, 'ok')
    assert.equal(state.requests.filter(path => path.includes('httpx2-jsfetch')).length, 0)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('external, VCS and file requirements fail without any request', async () => {
  const { server, base, state } = await indexServer()
  try {
    const external = `${base}/artifact.whl`
    const results = await checkRequirements(
      [
        { raw: `pkg @ ${external}`, source: 'test:1', kind: 'url', name: 'pkg', extras: [], specifier: null, url: external },
        { raw: 'vcs @ git+https://github.com/org/repo.git@main', source: 'test:2', kind: 'url', name: 'vcs', extras: [], specifier: null, url: 'git+https://github.com/org/repo.git@main' },
        { raw: 'plain @ file:///tmp/pkg.whl', source: 'test:3', kind: 'url', name: 'plain', extras: [], specifier: null, url: 'file:///tmp/pkg.whl' },
        { raw: 'git+https://github.com/org/other.git', source: 'test:4', kind: 'vcs', name: null, extras: [], specifier: null, url: 'git+https://github.com/org/other.git' },
      ],
      { indexUrls: [`${base}/simple`] }
    )
    assert.deepEqual(results.map(result => result.status), ['error', 'error', 'error', 'error'])
    assert.match(results[0].detail, /external URL requirements are not supported/)
    assert.match(results[1].detail, /VCS requirements are not supported/)
    assert.match(results[2].detail, /file:\/\/ requirements are not supported/)
    assert.match(results[3].detail, /VCS requirements are not supported/)
    assert.deepEqual(state.requests, [], 'no requirement may trigger an outbound request')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('no authentication is sent and credential-bearing URLs are rejected', async () => {
  const { server, base, state } = await indexServer()
  try {
    const results = await checkRequirements([requirement('onlyprivate', '>=1.0')], {
      indexUrls: [`${base}/private`],
    })
    assert.equal(results[0].status, 'error')
    assert.match(results[0].detail, /HTTP 401/)
    assert.equal(state.authorization, null, 'the action must not send an Authorization header')

    await assert.rejects(
      checkRequirements([requirement('onlyauth', '>=1.0')], {
        indexUrls: [`http://user:pass@127.0.0.1:${server.address().port}/auth`],
      }),
      /must not embed credentials/
    )

    const directUrl = `http://user:pass@127.0.0.1:${server.address().port}/artifact.whl`
    const direct = await checkRequirements(
      [{ raw: `pkg @ ${directUrl}`, source: 'test:1', kind: 'url', name: 'pkg', extras: [], specifier: null, url: directUrl }],
      { indexUrls: [`${base}/simple`] }
    )
    assert.equal(direct[0].status, 'error')
    assert.match(direct[0].detail, /external URL requirements are not supported/)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('action fails the step when a requirement is unavailable', async () => {
  const { server, base } = await indexServer()
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const output = join(root, 'output.txt')
  const summary = join(root, 'summary.md')
  const outputValue = (name) => {
    const text = readFileSync(output, 'utf8')
    const match = new RegExp(`${name}<<([^\\n]+)\\n([^\\n]*)\\n\\1`).exec(text)
    return match ? match[2] : undefined
  }
  const run = (requirements, overrides = {}) => {
    if (requirements !== null) writeFileSync(join(workspace, 'requirements.txt'), requirements)
    writeFileSync(output, '')
    writeFileSync(summary, '')
    return promisify(execFile)(process.execPath, [resolve('dist/index.js')], {
      env: {
        PATH: process.env.PATH,
        GITHUB_WORKSPACE: workspace,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        INPUT_MODE: 'python-index',
        'INPUT_REQUIREMENTS-FILE': 'requirements.txt',
        'INPUT_INDEX-URL': `${base}/simple`,
        'INPUT_EXTRA-INDEX-URLS': '',
        'INPUT_ALLOW-PRERELEASE': 'false',
        'INPUT_TIMEOUT-SECONDS': '10',
        'INPUT_PYTHON-VERSION': '3.12.7',
        INPUT_PLATFORM: 'linux',
        'INPUT_PLATFORM-MACHINE': 'x86_64',
        ...overrides,
      },
    })
  }
  try {
    await assert.rejects(
      run('requests>=2.0\nnonexistent==1.0\nhttpx2-jsfetch==1.0 ; sys_platform == "emscripten"\n'),
      error => {
        assert.equal(error.code, 1)
        assert.match(error.stdout, /::error::/)
        return true
      }
    )
    assert.equal(outputValue('failed-count'), '1')
    assert.equal(outputValue('checked-count'), '3')
    assert.equal(outputValue('skipped-count'), '1')
    const rendered = readFileSync(summary, 'utf8')
    assert.match(rendered, /Python index check/)
    assert.match(rendered, /nonexistent==1\.0/)
    assert.match(rendered, /missing/)
    assert.match(rendered, /markers evaluated for python 3\.12, linux\/x86_64/)

    const success = await run('--index-url http://127.0.0.1:9/simple\nrequests>=2.0\nlegacy>=1.0\n')
    assert.equal(outputValue('failed-count'), '0')
    assert.equal(outputValue('checked-count'), '2')
    assert.match(success.stdout, /index options in requirements files are ignored/)

    const outside = join(root, 'outside-action-requirements.txt')
    writeFileSync(outside, 'requests>=2.0\n')
    await assert.rejects(
      run(null, { 'INPUT_REQUIREMENTS-FILE': outside }),
      error => error.code === 1 && /outside GITHUB_WORKSPACE/.test(error.stdout)
    )
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
