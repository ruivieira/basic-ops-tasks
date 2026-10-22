// PEP 440 version parsing and specifier matching.
//
// This is the subset needed to answer "does a version satisfying this
// requirement exist on the index?". It follows the ordering rules that pip
// (and the packaging library) use, including pre/post/dev ordering, epochs,
// local versions, wildcard equality and the exclusive-comparison exclusions.

export interface Version {
  /** Original text, used by the === operator. */
  raw: string
  epoch: number
  release: number[]
  /** [rank, number] with rank 0=a, 1=b, 2=rc, or null when absent. */
  pre: [number, number] | null
  post: number | null
  dev: number | null
  local: string | null
}

const PRE_RANK: Record<string, number> = {
  a: 0, alpha: 0, b: 1, beta: 1, c: 2, rc: 2, pre: 2, preview: 2,
}

const VERSION_RE = new RegExp(
  '^\\s*v?' +
  '(?:(\\d+)!)?' + // epoch
  '(\\d+(?:\\.\\d+)*)' + // release
  '(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\\d+)?)?' + // pre
  '(?:(?:-(\\d+))|(?:[-_.]?(post|rev|r)[-_.]?(\\d+)?))?' + // post
  '(?:[-_.]?(dev)[-_.]?(\\d+)?)?' + // dev
  '(?:\\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?' + // local
  '\\s*$',
  'i'
)

export function parseVersion(input: string): Version | null {
  const match = VERSION_RE.exec(input)
  if (!match) return null
  const [, epoch, release, preLabel, preNumber, postNumber, postLabel, postLabelNumber, devLabel, devNumber, local] = match
  const pre =
    preLabel === undefined
      ? null
      : ([PRE_RANK[preLabel.toLowerCase()] ?? 3, preNumber === undefined ? 0 : Number(preNumber)] as [number, number])
  const post =
    postNumber !== undefined
      ? Number(postNumber)
      : postLabel !== undefined
        ? (postLabelNumber === undefined ? 0 : Number(postLabelNumber))
        : null
  return {
    raw: input.trim(),
    epoch: epoch === undefined ? 0 : Number(epoch),
    release: release.split('.').map(Number),
    pre,
    post,
    dev: devLabel === undefined ? null : devNumber === undefined ? 0 : Number(devNumber),
    local: local === undefined ? null : local.toLowerCase(),
  }
}

export function isPrerelease(version: Version): boolean {
  return version.pre !== null || version.dev !== null
}

function compareNumbers(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function preKey(version: Version): [number, number] {
  if (version.pre !== null) return version.pre
  // A pure dev release sorts before any pre-release; a final release after.
  if (version.post === null && version.dev !== null) return [-1, 0]
  return [3, 0]
}

export function compareLocal(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  const left = a.split(/[-_.]/)
  const right = b.split(/[-_.]/)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) {
    if (i >= left.length) return -1
    if (i >= right.length) return 1
    const leftNumeric = /^\d+$/.test(left[i])
    const rightNumeric = /^\d+$/.test(right[i])
    if (leftNumeric && rightNumeric) {
      const result = compareNumbers([Number(left[i])], [Number(right[i])])
      if (result !== 0) return result
    } else if (leftNumeric) {
      return 1
    } else if (rightNumeric) {
      return -1
    } else {
      const result = compareStrings(left[i], right[i])
      if (result !== 0) return result
    }
  }
  return 0
}

export function compareVersions(a: Version, b: Version, ignoreLocal = false): number {
  if (a.epoch !== b.epoch) return a.epoch < b.epoch ? -1 : 1
  const release = compareNumbers(a.release, b.release)
  if (release !== 0) return release
  const preA = preKey(a)
  const preB = preKey(b)
  if (preA[0] !== preB[0]) return preA[0] < preB[0] ? -1 : 1
  if (preA[1] !== preB[1]) return preA[1] < preB[1] ? -1 : 1
  const postA = a.post === null ? -1 : a.post
  const postB = b.post === null ? -1 : b.post
  if (postA !== postB) return postA < postB ? -1 : 1
  const devA = a.dev === null ? Number.POSITIVE_INFINITY : a.dev
  const devB = b.dev === null ? Number.POSITIVE_INFINITY : b.dev
  if (devA !== devB) return devA < devB ? -1 : 1
  if (ignoreLocal) return 0
  return compareLocal(a.local, b.local)
}

export type Operator = '===' | '==' | '!=' | '<=' | '>=' | '~=' | '<' | '>'

export interface Specifier {
  op: Operator
  value: string
  version: Version | null
  wildcard: boolean
}

export interface SpecifierSet {
  text: string
  specs: Specifier[]
}

export function parseSpecifierSet(text: string): SpecifierSet {
  const specs: Specifier[] = []
  for (const piece of text.split(',')) {
    const trimmed = piece.trim()
    if (trimmed === '') continue
    const match = /^(===|==|!=|<=|>=|~=|<|>)\s*(\S+)$/.exec(trimmed)
    if (!match) throw new Error(`Invalid version specifier "${trimmed}" in "${text}".`)
    const op = match[1] as Operator
    let value = match[2]
    let wildcard = false
    if (op === '===') {
      specs.push({ op, value, version: null, wildcard: false })
      continue
    }
    if ((op === '==' || op === '!=') && value.endsWith('.*')) {
      wildcard = true
      value = value.slice(0, -2)
    }
    const version = parseVersion(value)
    if (!version) throw new Error(`Invalid version "${value}" in specifier "${trimmed}".`)
    if (op === '~=' && version.release.length < 2) {
      throw new Error(`The ~= operator needs at least two release segments, got "${trimmed}".`)
    }
    specs.push({ op, value, version, wildcard })
  }
  if (specs.length === 0) throw new Error(`Empty version specifier "${text}".`)
  return { text, specs }
}

function releasePrefixMatches(candidate: Version, prefix: Version): boolean {
  if (candidate.epoch !== prefix.epoch) return false
  return prefix.release.every((part, index) => (candidate.release[index] ?? 0) === part)
}

function sameReleaseAndEpoch(a: Version, b: Version): boolean {
  return a.epoch === b.epoch && compareNumbers(a.release, b.release) === 0
}

/** Compare a candidate against a specifier version, ignoring candidate local parts when unspecified. */
function specCompare(candidate: Version, spec: Version): number {
  const left = spec.local === null ? { ...candidate, local: null } : candidate
  return compareVersions(left, spec)
}

export function matchesSpecifier(specifier: Specifier, candidate: Version): boolean {
  const spec = specifier.version
  if (specifier.op === '===') {
    return candidate.raw.toLowerCase() === specifier.value.toLowerCase()
  }
  if (spec === null) return false

  if (specifier.op === '==' || specifier.op === '!=') {
    const equal = specifier.wildcard
      ? releasePrefixMatches(candidate, spec)
      : specCompare(candidate, spec) === 0
    return specifier.op === '==' ? equal : !equal
  }

  if (specifier.op === '~=') {
    if (specCompare(candidate, spec) < 0) return false
    const prefix: Version = { ...spec, release: spec.release.slice(0, -1) }
    return releasePrefixMatches(candidate, prefix)
  }

  const comparison = specCompare(candidate, spec)
  if (specifier.op === '>=') return comparison >= 0
  if (specifier.op === '<=') return comparison <= 0
  if (specifier.op === '>') {
    if (comparison <= 0) return false
    // >V must not match a post-release of V unless V is a post-release, nor a
    // local version of V (PEP 440, exclusive ordered comparison).
    if (sameReleaseAndEpoch(candidate, spec)) {
      if (candidate.post !== null && spec.post === null) return false
      if (candidate.local !== null) return false
    }
    return true
  }
  if (comparison >= 0) return false
  // <V must not match a pre-release of V unless V itself is a pre-release.
  if (sameReleaseAndEpoch(candidate, spec) && isPrerelease(candidate) && !isPrerelease(spec)) return false
  return true
}

export function matchesSpecifierSet(set: SpecifierSet, candidate: Version): boolean {
  return set.specs.every(spec => matchesSpecifier(spec, candidate))
}

export function specifierMentionsPrerelease(set: SpecifierSet): boolean {
  return set.specs.some(spec => spec.version !== null && isPrerelease(spec.version))
}

/** True when the set is a single `==` pin (used for the PEP 592 yanked exception). */
export function exactPin(set: SpecifierSet): Version | null {
  if (set.specs.length !== 1) return null
  const spec = set.specs[0]
  if (spec.op !== '==' || spec.wildcard) return null
  return spec.version
}
