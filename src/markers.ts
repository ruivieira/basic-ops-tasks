// PEP 508 environment marker parsing and evaluation.
//
// Markers let a requirements file pin alternatives that only apply to some
// interpreters or platforms (`pyyaml-ft==8.0.0 ; python_full_version == '3.13.*'`,
// `httpx2-jsfetch==1.0 ; sys_platform == 'emscripten'`). Without an environment
// those pins cannot be verified, so the caller supplies the target interpreter
// and platform explicitly.

import { compareVersions, matchesSpecifierSet, parseSpecifierSet, parseVersion } from './pep440.js'

export const MARKER_VARIABLES = [
  'python_version',
  'python_full_version',
  'os_name',
  'sys_platform',
  'platform_release',
  'platform_system',
  'platform_version',
  'platform_machine',
  'platform_python_implementation',
  'implementation_name',
  'implementation_version',
  'extra',
] as const

export type MarkerVariable = (typeof MARKER_VARIABLES)[number]

export interface MarkerEnvironment {
  python_version: string
  python_full_version: string
  os_name: string
  sys_platform: string
  platform_release: string
  platform_system: string
  platform_version: string
  platform_machine: string
  platform_python_implementation: string
  implementation_name: string
  implementation_version: string
  extra: string
}

type Operand = { type: 'variable'; name: MarkerVariable } | { type: 'string'; value: string }

type ComparisonOperator = '===' | '==' | '!=' | '<=' | '>=' | '~=' | '<' | '>' | 'in' | 'not in'

export type MarkerNode =
  | { kind: 'and' | 'or'; left: MarkerNode; right: MarkerNode }
  | { kind: 'compare'; left: Operand; operator: ComparisonOperator; right: Operand }

type Token =
  | { type: 'string'; value: string }
  | { type: 'variable'; value: MarkerVariable }
  | { type: 'operator'; value: ComparisonOperator }
  | { type: 'and' | 'or' | 'lparen' | 'rparen' }

const VERSION_VARIABLES = new Set<MarkerVariable>(['python_version', 'python_full_version', 'implementation_version'])
const OPERATOR_CHARS = /^(===|==|!=|<=|>=|~=|<|>|\(|\))/

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < text.length) {
    const rest = text.slice(index)
    const whitespace = /^\s+/.exec(rest)
    if (whitespace) {
      index += whitespace[0].length
      continue
    }
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quote = rest[0]
      const end = rest.indexOf(quote, 1)
      if (end === -1) throw new Error(`Unterminated string in environment marker "${text}".`)
      tokens.push({ type: 'string', value: rest.slice(1, end) })
      index += end + 1
      continue
    }
    const operator = OPERATOR_CHARS.exec(rest)
    if (operator) {
      const value = operator[0]
      if (value === '(') tokens.push({ type: 'lparen' })
      else if (value === ')') tokens.push({ type: 'rparen' })
      else tokens.push({ type: 'operator', value: value as ComparisonOperator })
      index += value.length
      continue
    }
    const word = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest)
    if (!word) throw new Error(`Unexpected character "${rest[0]}" in environment marker "${text}".`)
    const value = word[0]
    if (value === 'and' || value === 'or') tokens.push({ type: value })
    else if (value === 'in') tokens.push({ type: 'operator', value: 'in' })
    else if (value === 'not') {
      const following = /^\s+in\b/.exec(rest.slice(value.length))
      if (!following) throw new Error(`Expected "in" after "not" in environment marker "${text}".`)
      tokens.push({ type: 'operator', value: 'not in' })
      index += value.length + following[0].length
      continue
    }
    else if (value === 'extra') tokens.push({ type: 'variable', value: 'extra' })
    else if ((MARKER_VARIABLES as readonly string[]).includes(value)) tokens.push({ type: 'variable', value: value as MarkerVariable })
    else throw new Error(`Unknown environment marker variable "${value}".`)
    index += value.length
  }
  return tokens
}

export function parseMarker(text: string): MarkerNode {
  const tokens = tokenize(text)
  let position = 0
  const peek = (): Token | undefined => tokens[position]
  const take = (): Token => {
    const token = tokens[position]
    if (!token) throw new Error(`Unexpected end of environment marker "${text}".`)
    position += 1
    return token
  }

  const parseOperand = (): Operand => {
    const token = take()
    if (token.type === 'string') return { type: 'string', value: token.value }
    if (token.type === 'variable') return { type: 'variable', name: token.value }
    throw new Error(`Expected a value in environment marker "${text}".`)
  }

  const parseComparison = (): MarkerNode => {
    const token = peek()
    if (token?.type === 'lparen') {
      take()
      const inner = parseOr()
      const close = take()
      if (close.type !== 'rparen') throw new Error(`Missing ")" in environment marker "${text}".`)
      return inner
    }
    const left = parseOperand()
    const operator = take()
    if (operator.type !== 'operator') throw new Error(`Expected a comparison in environment marker "${text}".`)
    if (operator.value === 'not in') {
      // The tokenizer collapses "not in" into one token; "not" alone is invalid.
    }
    const right = parseOperand()
    return { kind: 'compare', left, operator: operator.value, right }
  }

  const parseAnd = (): MarkerNode => {
    let node = parseComparison()
    while (peek()?.type === 'and') {
      take()
      node = { kind: 'and', left: node, right: parseComparison() }
    }
    return node
  }

  const parseOr = (): MarkerNode => {
    let node = parseAnd()
    while (peek()?.type === 'or') {
      take()
      node = { kind: 'or', left: node, right: parseAnd() }
    }
    return node
  }

  if (tokens.length === 0) throw new Error('Empty environment marker.')
  const node = parseOr()
  if (position !== tokens.length) throw new Error(`Unexpected trailing tokens in environment marker "${text}".`)
  return node
}

function variableValue(name: MarkerVariable, environment: MarkerEnvironment): string {
  return environment[name] ?? ''
}

function resolve(operand: Operand, environment: MarkerEnvironment): { value: string; versionVariable: boolean } {
  if (operand.type === 'string') return { value: operand.value, versionVariable: false }
  return { value: variableValue(operand.name, environment), versionVariable: VERSION_VARIABLES.has(operand.name) }
}

function compareValues(
  left: { value: string; versionVariable: boolean },
  operator: ComparisonOperator,
  right: { value: string; versionVariable: boolean }
): boolean {
  if (operator === 'in' || operator === 'not in') {
    const contained = right.value.includes(left.value)
    return operator === 'in' ? contained : !contained
  }
  if (left.versionVariable || right.versionVariable) {
    const leftVersion = parseVersion(left.value)
    const rightVersion = parseVersion(right.value)
    if (leftVersion && rightVersion) {
      try {
        return matchesSpecifierSet(parseSpecifierSet(`${operator}${right.value}`), leftVersion)
      } catch {
        const comparison = compareVersions(leftVersion, rightVersion)
        if (operator === '==' || operator === '===') return comparison === 0
        if (operator === '!=') return comparison !== 0
        if (operator === '<') return comparison < 0
        if (operator === '<=') return comparison <= 0
        if (operator === '>') return comparison > 0
        return comparison >= 0
      }
    }
  }
  switch (operator) {
    case '==':
    case '===':
      return left.value === right.value
    case '!=':
      return left.value !== right.value
    case '<':
      return left.value < right.value
    case '<=':
      return left.value <= right.value
    case '>':
      return left.value > right.value
    case '>=':
      return left.value >= right.value
    default:
      return false
  }
}

export function evaluateMarker(node: MarkerNode, environment: MarkerEnvironment): boolean {
  if (node.kind === 'and') return evaluateMarker(node.left, environment) && evaluateMarker(node.right, environment)
  if (node.kind === 'or') return evaluateMarker(node.left, environment) || evaluateMarker(node.right, environment)
  if (node.kind !== 'compare') return false
  return compareValues(resolve(node.left, environment), node.operator, resolve(node.right, environment))
}

export function evaluateMarkerText(text: string, environment: MarkerEnvironment): boolean {
  return evaluateMarker(parseMarker(text), environment)
}

export interface MarkerEnvironmentOptions {
  /** Full target Python version, e.g. "3.12.7" (a bare "3.12" is accepted but imprecise). */
  pythonVersion: string
  /** sys_platform value: linux (default), darwin or win32. */
  platform?: string
  /** platform_machine; derived from the runner when omitted. */
  machine?: string
}

function defaultMachine(): string {
  const arch = process.arch
  if (arch === 'x64') return 'x86_64'
  if (arch === 'arm64') return 'aarch64'
  if (arch === 'ia32') return 'i686'
  return arch
}

export function buildMarkerEnvironment(options: MarkerEnvironmentOptions): MarkerEnvironment {
  const pythonVersion = options.pythonVersion.trim()
  if (!/^\d+\.\d+(\.\d+)?([a-z]+\d+)?$/i.test(pythonVersion)) {
    throw new Error(`python-version must look like "3.12" or "3.12.7", got "${options.pythonVersion}".`)
  }
  const release = /^(\d+)\.(\d+)/.exec(pythonVersion)
  if (!release) throw new Error(`python-version must start with a major.minor release, got "${pythonVersion}".`)
  const platform = (options.platform ?? 'linux').trim().toLowerCase()
  const system = platform === 'darwin' ? 'Darwin' : platform === 'win32' ? 'Windows' : 'Linux'
  return {
    python_version: `${release[1]}.${release[2]}`,
    python_full_version: pythonVersion,
    os_name: platform === 'win32' ? 'nt' : 'posix',
    sys_platform: platform,
    platform_release: '',
    platform_system: system,
    platform_version: '',
    platform_machine: options.machine?.trim() || defaultMachine(),
    platform_python_implementation: 'CPython',
    implementation_name: 'cpython',
    implementation_version: pythonVersion,
    extra: '',
  }
}

export function describeMarkerEnvironment(environment: MarkerEnvironment): string {
  return `python ${environment.python_version}, ${environment.sys_platform}/${environment.platform_machine}`
}
