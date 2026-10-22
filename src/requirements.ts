// Parsing and verification of requirements.txt-like files against a PEP 503
// simple index (JSON via PEP 691/700, HTML as a fallback).
//
// Scope: every requirement that names a project and a version specifier is
// checked against the index; local paths are skipped; VCS, file:// and external
// URL requirements fail without being fetched. The only network destination is
// the index URL supplied by the action inputs. PEP 508 markers are evaluated
// when the caller supplies a target environment. Requirements files and -r/-c
// includes must resolve inside the checkout; the file is untrusted input in
// pull-request runs.

import { readFile, realpath } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import {
  compareVersions,
  exactPin,
  isPrerelease,
  matchesSpecifierSet,
  parseSpecifierSet,
  parseVersion,
  specifierMentionsPrerelease,
} from './pep440.js'
import type { SpecifierSet, Version } from './pep440.js'
import { describeMarkerEnvironment, evaluateMarkerText, parseMarker } from './markers.js'
import type { MarkerEnvironment } from './markers.js'

export type RequirementKind = 'index' | 'url' | 'vcs' | 'path' | 'editable'

export interface ParsedRequirement {
  raw: string
  source: string
  kind: RequirementKind
  name: string | null
  extras: string[]
  specifier: SpecifierSet | null
  url: string | null
  /** Raw PEP 508 environment marker after `;`, when present. */
  marker?: string
}

export interface ParsedRequirements {
  requirements: ParsedRequirement[]
  allowPrerelease: boolean
  warnings: string[]
}

const INCLUDED_EXTENSIONS = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tgz', '.zip']
const MAX_INDEX_BYTES = 20 * 1024 * 1024

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, '-')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function splitExtras(text: string | undefined): string[] {
  if (!text) return []
  return text.replace(/^\[|\]$/g, '').split(',').map(item => item.trim()).filter(Boolean)
}

/** Strip a trailing comment; `#` only starts one after whitespace (URL fragments stay intact). */
function stripComment(line: string): string {
  return line.replace(/(^|\s+)#.*$/, '')
}

function parseRequirementText(text: string, source: string): ParsedRequirement {
  const raw = text.trim()
  const markerIndex = raw.indexOf(';')
  const withoutMarker = markerIndex === -1 ? raw : raw.slice(0, markerIndex).trim()
  const marker = markerIndex === -1 ? undefined : raw.slice(markerIndex + 1).trim()
  if (marker !== undefined) {
    try {
      parseMarker(marker)
    } catch (error) {
      throw new Error(`${source}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const withMarker = <T extends Omit<ParsedRequirement, 'marker'>>(requirement: T): ParsedRequirement =>
    marker === undefined ? requirement : { ...requirement, marker }

  const direct = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*@\s*(\S.*)$/.exec(withoutMarker)
  if (direct) {
    return withMarker({
      raw,
      source,
      kind: 'url',
      name: direct[1],
      extras: splitExtras(direct[2]),
      specifier: null,
      url: direct[3].trim(),
    })
  }

  if (/^(git|hg|svn|bzr)\+/i.test(withoutMarker)) {
    return withMarker({ raw, source, kind: 'vcs', name: null, extras: [], specifier: null, url: withoutMarker })
  }
  if (/^https?:\/\//i.test(withoutMarker) || /^ftp:\/\//i.test(withoutMarker)) {
    return withMarker({ raw, source, kind: 'url', name: null, extras: [], specifier: null, url: withoutMarker })
  }
  if (/^(\.{1,2}\/|\/|~\/|[A-Za-z]:\\)/.test(withoutMarker) || withoutMarker === '.' || withoutMarker === '..') {
    return withMarker({ raw, source, kind: 'path', name: null, extras: [], specifier: null, url: withoutMarker })
  }

  const named = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(withoutMarker)
  if (!named) throw new Error(`${source}: cannot parse requirement "${raw}".`)
  const specifierText = named[3].trim()
  return withMarker({
    raw,
    source,
    kind: 'index',
    name: named[1],
    extras: splitExtras(named[2]),
    specifier: specifierText === '' ? null : parseSpecifierSet(specifierText),
    url: null,
  })
}

function optionValue(option: string, line: string): string | null | undefined {
  if (line === option) return null
  if (line.startsWith(`${option} `)) return line.slice(option.length + 1).trim()
  if (line.startsWith(`${option}=`)) return line.slice(option.length + 1).trim()
  return undefined
}

/** Read a requirements file, following -r/-c includes relative to the including file. */
export interface ParseOptions {
  /** Files must resolve (after symlinks) inside this directory. */
  workspace?: string
}

export async function parseRequirementsFile(file: string, options: ParseOptions = {}): Promise<ParsedRequirements> {
  const result: ParsedRequirements = { requirements: [], allowPrerelease: false, warnings: [] }
  const stack: string[] = []
  await readFileInto(resolve(file), result, stack, options)
  return result
}

async function assertInsideWorkspace(file: string, options: ParseOptions): Promise<void> {
  if (!options.workspace) return
  const [resolvedFile, resolvedWorkspace] = await Promise.all([
    realpath(file).catch(() => null),
    realpath(options.workspace).catch(() => options.workspace as string),
  ])
  // A missing file is reported by readFile with its own message.
  if (resolvedFile === null) return
  const prefix = resolvedWorkspace.endsWith(sep) ? resolvedWorkspace : `${resolvedWorkspace}${sep}`
  if (resolvedFile !== resolvedWorkspace && !resolvedFile.startsWith(prefix)) {
    throw new Error(
      `Refusing to read "${file}": it resolves to "${resolvedFile}", outside GITHUB_WORKSPACE ` +
        `("${resolvedWorkspace}"). Requirements files and -r/-c includes must live in the repository checkout.`
    )
  }
}

async function readFileInto(
  file: string,
  result: ParsedRequirements,
  stack: string[],
  options: ParseOptions
): Promise<void> {
  await assertInsideWorkspace(file, options)
  if (stack.includes(file)) {
    result.warnings.push(`${file}: include cycle ignored.`)
    return
  }
  if (stack.length >= 25) throw new Error(`${file}: include depth exceeds 25 files.`)
  let content: string
  try {
    content = await readFile(file, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Cannot read requirements file "${file}": ${reason}`)
  }
  stack.push(file)
  try {
    const lines = joinContinuations(content.replace(/\r\n?/g, '\n').split('\n'))
    for (let index = 0; index < lines.length; index++) {
      const { text: joined, line } = lines[index]
      const text = stripComment(joined).trim()
      if (text === '') continue
      const source = `${file}:${line}`
      const takeValue = (option: string): string | null | undefined => {
        const inline = optionValue(option, text)
        if (inline === null) {
          const next = index + 1 < lines.length ? stripComment(lines[index + 1].text).trim() : ''
          if (next === '') return undefined
          index += 1
          return next
        }
        return inline
      }

      if (/^--?e(ditable)?(\s|$)/.test(text)) {
        const value = takeValue(text.startsWith('--editable') ? '--editable' : '-e')
        result.requirements.push({
          raw: text,
          source,
          kind: 'editable',
          name: null,
          extras: [],
          specifier: null,
          url: typeof value === 'string' ? value : null,
        })
        continue
      }

      const include = /^(?:-r|--requirement)(?:\s+|=)(\S+)$/.exec(text)
      const constraint = /^(?:-c|--constraint)(?:\s+|=)(\S+)$/.exec(text)
      const included = include ?? constraint
      if (included) {
        const includePath = resolve(dirname(file), included[1])
        await readFileInto(includePath, result, stack, options)
        continue
      }

      if (/^(?:-i|--index-url|--extra-index-url)(?:\s|=|$)/.test(text)) {
        result.warnings.push(
          `${source}: index options in requirements files are ignored; ` +
            "the index comes from the action's index-url input."
        )
        continue
      }
      if (/^--pre$/.test(text)) {
        result.allowPrerelease = true
        continue
      }

      if (/^(?:-f|--find-links)(?:\s|=|$)/.test(text)) {
        result.warnings.push(`${source}: --find-links is not checked; only index versions are verified.`)
        continue
      }
      if (/^--?(hash|trusted-host|no-index|require-hashes|only-binary|no-binary|prefer-binary|use-feature|use-deprecated|config-settings|global-option|no-deps|progress-bar|no-cache-dir|exists-action|cert|client-cert|proxy|retries|timeout|log)(\s|=|$)/.test(text)) {
        continue
      }
      if (/^--hash=/.test(text)) continue
      // Any other long option is a pip flag this check does not need to
      // evaluate (for example --use-pep517). Ignore it, but say so.
      if (/^--[a-z][a-z0-9-]*(?:\s|=|$)/i.test(text)) {
        const option = text.split(/[\s=]/)[0]
        result.warnings.push(`${source}: option "${option}" is not evaluated.`)
        continue
      }

      const cleaned = text.replace(/(^|\s)--hash=\S+/g, ' ').trim()
      if (cleaned === '') continue
      if (cleaned.startsWith('-')) {
        throw new Error(`${source}: unsupported pip option "${cleaned}".`)
      }
      result.requirements.push(parseRequirementText(cleaned, source))
    }
  } finally {
    stack.pop()
  }
}

function joinContinuations(rawLines: string[]): { text: string; line: number }[] {
  const joined: { text: string; line: number }[] = []
  let buffer = ''
  let start = 0
  rawLines.forEach((line, index) => {
    if (buffer === '') start = index + 1
    if (line.endsWith('\\')) {
      buffer += `${line.slice(0, -1)} `
      return
    }
    joined.push({ text: `${buffer}${line}`, line: start })
    buffer = ''
  })
  if (buffer !== '') joined.push({ text: buffer, line: start })
  return joined
}

/** Extract a version from a distribution filename (wheel or sdist). */
export function versionFromFilename(filename: string, normalizedName: string): Version | null {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.whl')) {
    const parts = filename.slice(0, -4).split('-')
    // The distribution segment may itself contain separators in malformed or
    // hand-built filenames, so try every split point before the version.
    for (let index = 1; index < parts.length; index++) {
      if (normalizeName(parts.slice(0, index).join('-')) !== normalizedName) continue
      const version = parseVersion(parts[index])
      if (version) return version
    }
    return null
  }
  const extension = INCLUDED_EXTENSIONS.find(ext => lower.endsWith(ext))
  if (!extension) return null
  const base = filename.slice(0, -extension.length)
  const pattern = normalizeName(normalizedName).replace(/-/g, '[-_.]')
  const match = new RegExp(`^${pattern}-(.+)$`, 'i').exec(base)
  return match ? parseVersion(match[1]) : null
}

export interface AvailableVersion {
  version: Version
  yanked: boolean
}

interface IndexLocation {
  href: string
  display: string
}

function indexLocation(raw: string): IndexLocation {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Invalid index URL: an absolute http or https URL is required.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Index URL must use http or https.')
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(
      `Index URL "${url.origin}${url.pathname}" must not embed credentials: this action sends no authentication.`
    )
  }
  const href = url.toString().replace(/\/+$/, '')
  return { href, display: `${url.origin}${url.pathname.replace(/\/+$/, '')}` }
}

export function displayIndexUrl(raw: string): string {
  return indexLocation(raw).display
}

async function readCapped(response: Response): Promise<string> {
  const body = response.body
  if (body === null) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      size += value.byteLength
      if (size > MAX_INDEX_BYTES) {
        await reader.cancel()
        throw new Error(`Index response exceeded ${MAX_INDEX_BYTES / (1024 * 1024)} MiB.`)
      }
      chunks.push(value)
    }
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

async function request(url: string, timeoutMs: number, method: string): Promise<Response> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.pypi.simple.v1+json, application/vnd.pypi.simple.v1+html;q=0.9, text/html;q=0.8',
    'user-agent': 'basic-ops-tasks-python-index-check',
  }
  return fetch(url, { method, headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
}

interface JsonFile {
  filename?: string
  yanked?: boolean | string
}

function collectVersions(
  entries: { filename: string; yanked: boolean }[],
  normalizedName: string,
  listed: string[]
): AvailableVersion[] {
  const byRaw = new Map<string, { version: Version; files: number; yankedFiles: number }>()
  for (const raw of listed) {
    const version = parseVersion(raw)
    if (version) byRaw.set(raw, { version, files: 0, yankedFiles: 0 })
  }
  for (const entry of entries) {
    const version = versionFromFilename(entry.filename, normalizedName)
    if (!version) continue
    const existing = byRaw.get(version.raw)
    if (existing) {
      existing.files += 1
      if (entry.yanked) existing.yankedFiles += 1
    } else {
      byRaw.set(version.raw, { version, files: 1, yankedFiles: entry.yanked ? 1 : 0 })
    }
  }
  return [...byRaw.values()].map(item => ({
    version: item.version,
    yanked: item.files > 0 && item.yankedFiles === item.files,
  }))
}

function parseJsonIndex(body: string, normalizedName: string): AvailableVersion[] | null {
  let parsed: { versions?: unknown; files?: unknown }
  try {
    parsed = JSON.parse(body) as { versions?: unknown; files?: unknown }
  } catch {
    return null
  }
  const listed = Array.isArray(parsed.versions) ? parsed.versions.filter((item): item is string => typeof item === 'string') : []
  const files = Array.isArray(parsed.files) ? (parsed.files as JsonFile[]) : []
  const entries = files
    .filter(file => typeof file.filename === 'string')
    .map(file => ({ filename: file.filename as string, yanked: file.yanked === true || file.yanked === 'true' }))
  if (listed.length === 0 && entries.length === 0) return []
  return collectVersions(entries, normalizedName, listed)
}

function parseHtmlIndex(body: string, normalizedName: string): AvailableVersion[] {
  const entries: { filename: string; yanked: boolean }[] = []
  const anchor = /<a\s([^>]*)>([^<]*)<\/a>/gi
  for (let match = anchor.exec(body); match !== null; match = anchor.exec(body)) {
    const attributes = match[1]
    const filename = match[2].trim()
    if (filename === '') continue
    entries.push({ filename, yanked: /\bdata-yanked(?:\s*=|\s|$)/i.test(attributes) })
  }
  return collectVersions(entries, normalizedName, [])
}

async function fetchProject(
  location: IndexLocation,
  normalizedName: string,
  timeoutMs: number
): Promise<AvailableVersion[] | null> {
  const url = `${location.href}/${encodeURIComponent(normalizedName)}/`
  const response = await request(url, timeoutMs, 'GET')
  if (response.status === 404 || response.status === 410) return null
  if (!response.ok) {
    throw new Error(`${location.display}: HTTP ${response.status} for /${normalizedName}/`)
  }
  const body = await readCapped(response)
  const json = parseJsonIndex(body, normalizedName)
  return json ?? parseHtmlIndex(body, normalizedName)
}

export type RequirementStatus = 'ok' | 'missing' | 'error' | 'skipped'

export interface RequirementResult {
  requirement: ParsedRequirement
  status: RequirementStatus
  detail: string
}

export interface CheckOptions {
  indexUrls: string[]
  /** When set, PEP 508 environment markers are evaluated against this environment. */
  markerEnvironment?: MarkerEnvironment
  allowPrerelease?: boolean
  timeoutMs?: number
  concurrency?: number
}

function describeAvailable(versions: AvailableVersion[]): string {
  const sorted = [...versions].sort((a, b) => compareVersions(b.version, a.version))
  const names = sorted.slice(0, 8).map(item => `${item.version.raw}${item.yanked ? ' (yanked)' : ''}`)
  const overflow = sorted.length > names.length ? `, … (${sorted.length} total)` : ''
  return names.length === 0 ? 'none' : `${names.join(', ')}${overflow}`
}

async function checkIndexed(
  requirement: ParsedRequirement,
  options: CheckOptions,
  locations: IndexLocation[],
  cache: Map<string, Promise<AvailableVersion[] | null>>,
  timeoutMs: number
): Promise<RequirementResult> {
  const name = requirement.name as string
  const normalized = normalizeName(name)
  const perIndex: { location: IndexLocation; versions: AvailableVersion[] | null; error?: string }[] = await Promise.all(
    locations.map(async location => {
      const key = `${location.href}|${normalized}`
      let pending = cache.get(key)
      if (!pending) {
        pending = fetchProject(location, normalized, timeoutMs)
        cache.set(key, pending)
      }
      try {
        return { location, versions: await pending }
      } catch (error) {
        return { location, versions: null, error: error instanceof Error ? error.message : String(error) }
      }
    })
  )

  const failed = perIndex.filter(item => item.error !== undefined)
  const found = perIndex.filter(item => item.versions !== null)
  const note = failed.length > 0
    ? ` [warning: ${failed.map(item => item.error).join('; ')}]`
    : ''
  if (found.length === 0) {
    if (failed.length > 0) {
      return { requirement, status: 'error', detail: failed.map(item => item.error).join('; ') }
    }
    return {
      requirement,
      status: 'missing',
      detail: `project "${name}" not found on ${locations.map(item => item.display).join(', ')}`,
    }
  }

  const merged = new Map<string, AvailableVersion>()
  for (const item of found) {
    for (const version of item.versions as AvailableVersion[]) {
      const existing = merged.get(version.version.raw)
      if (existing) {
        // A version is yanked only when every index marks it yanked.
        existing.yanked = existing.yanked && version.yanked
      } else {
        merged.set(version.version.raw, { ...version })
      }
    }
  }
  const available = [...merged.values()]
  const sorted = [...available].sort((a, b) => compareVersions(b.version, a.version))
  if (sorted.length === 0) {
    return {
      requirement,
      status: 'missing',
      detail: `project "${name}" is listed on the index but publishes no parseable versions${note}`,
    }
  }

  if (requirement.specifier === null) {
    return {
      requirement,
      status: 'ok',
      detail: `${available.length} version(s) available (latest ${sorted[0].version.raw})${note}`,
    }
  }

  const specifier = requirement.specifier
  const matching = sorted.filter(item => matchesSpecifierSet(specifier, item.version))
  const installable = matching.filter(item => !item.yanked)
  if (installable.length > 0) {
    const best = installable[0]
    const prereleaseNote =
      isPrerelease(best.version) && !options.allowPrerelease && !specifierMentionsPrerelease(specifier)
        ? ' (pre-release; no stable version matches)'
        : ''
    return { requirement, status: 'ok', detail: `resolves to ${best.version.raw}${prereleaseNote}${note}` }
  }

  if (matching.length > 0) {
    const pin = exactPin(specifier)
    const pinnedYanked = pin !== null && matching.some(item => compareVersions(item.version, pin) === 0)
    if (pinnedYanked) {
      return {
        requirement,
        status: 'ok',
        detail: `resolves to ${pin.raw} (yanked; allowed by exact pin)${note}`,
      }
    }
    return {
      requirement,
      status: 'missing',
      detail: `all versions matching "${specifier.text}" are yanked (${describeAvailable(matching)})${note}`,
    }
  }

  return {
    requirement,
    status: 'missing',
    detail: `no version matches "${specifier.text}"; available: ${describeAvailable(sorted)}${note}`,
  }
}

async function checkOne(
  requirement: ParsedRequirement,
  options: CheckOptions,
  locations: IndexLocation[],
  cache: Map<string, Promise<AvailableVersion[] | null>>,
  timeoutMs: number
): Promise<RequirementResult> {
  try {
    if (requirement.marker && options.markerEnvironment) {
      if (!evaluateMarkerText(requirement.marker, options.markerEnvironment)) {
        return {
          requirement,
          status: 'skipped',
          detail: `environment marker not satisfied (${describeMarkerEnvironment(options.markerEnvironment)})`,
        }
      }
    }
    if (requirement.kind === 'path' || requirement.kind === 'editable') {
      return { requirement, status: 'skipped', detail: 'local path (no index request)' }
    }
    if (requirement.kind === 'vcs') {
      return {
        requirement,
        status: 'error',
        detail: 'VCS requirements are not supported: only the configured index is queried',
      }
    }
    if (requirement.kind === 'url') {
      const url = requirement.url as string
      if (/^(git|hg|svn|bzr)\+/i.test(url)) {
        return {
          requirement,
          status: 'error',
          detail: 'VCS requirements are not supported: only the configured index is queried',
        }
      }
      if (/^file:\/\//i.test(url)) {
        return {
          requirement,
          status: 'error',
          detail: 'file:// requirements are not supported: only the configured index is queried',
        }
      }
      return {
        requirement,
        status: 'error',
        detail:
          'external URL requirements are not supported: they cannot be verified against the index ' +
          'and the action will not fetch them',
      }
    }
    return await checkIndexed(requirement, options, locations, cache, timeoutMs)
  } catch (error) {
    return {
      requirement,
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function checkRequirements(
  requirements: ParsedRequirement[],
  options: CheckOptions
): Promise<RequirementResult[]> {
  if (options.indexUrls.length === 0) throw new Error('At least one index URL is required.')
  const locations = options.indexUrls.map(indexLocation)
  const timeoutMs = options.timeoutMs ?? 30_000
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 6, requirements.length || 1))
  const cache = new Map<string, Promise<AvailableVersion[] | null>>()
  const results: RequirementResult[] = new Array(requirements.length)

  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= requirements.length) return
      results[index] = await checkOne(requirements[index], options, locations, cache, timeoutMs)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return results
}
