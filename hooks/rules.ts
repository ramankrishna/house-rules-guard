// The rules themselves, with no engine in them: every function here is pure,
// so the tests and the hooks read the same judgement.

export const RULES_FILE = '.house-rules.json'

export type Mode = 'allow' | 'ask' | 'deny'

export type RuleName =
  | 'pushToProtectedBranch'
  | 'forcePush'
  | 'destructiveCommands'
  | 'newDependencies'
  | 'protectedPaths'

export const RULE_NAMES: readonly RuleName[] = [
  'pushToProtectedBranch',
  'forcePush',
  'destructiveCommands',
  'newDependencies',
  'protectedPaths',
]

export type CustomRule = { match: string; mode: Mode; why: string }

export type Config = {
  protectedBranches: string[]
  rules: Record<RuleName, Mode>
  protectedPaths: string[]
  custom: CustomRule[]
}

export const DEFAULTS: Config = {
  protectedBranches: ['main', 'master'],
  rules: {
    pushToProtectedBranch: 'ask',
    forcePush: 'deny',
    destructiveCommands: 'ask',
    newDependencies: 'ask',
    protectedPaths: 'ask',
  },
  protectedPaths: ['.env', '.env.*', '*.pem', '*.key'],
  custom: [],
}

/** One rule a call ran into: which, how strictly, and what the call does. */
export type Finding = {
  rule: RuleName | 'custom' | 'rulesFile'
  mode: 'ask' | 'deny'
  /** Completes "this ...": `pushes to main, a protected branch`. */
  what: string
}

// ---------------------------------------------------------------- config

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(one => typeof one === 'string')

const isMode = (value: unknown): value is Mode =>
  value === 'allow' || value === 'ask' || value === 'deny'

/** Reads `.house-rules.json` over the defaults; answers one line when it is wrong. */
export function parseConfig(text: string): Config | string {
  let data: unknown

  try {
    data = JSON.parse(text)
  } catch {
    return 'not valid JSON'
  }

  if (!isRecord(data)) return 'expected an object'

  const config: Config = {
    protectedBranches: [...DEFAULTS.protectedBranches],
    rules: { ...DEFAULTS.rules },
    protectedPaths: [...DEFAULTS.protectedPaths],
    custom: [],
  }

  if (data.protectedBranches !== undefined) {
    if (!isStrings(data.protectedBranches)) return '"protectedBranches" must be a list of names'
    config.protectedBranches = data.protectedBranches
  }
  if (data.protectedPaths !== undefined) {
    if (!isStrings(data.protectedPaths)) return '"protectedPaths" must be a list of patterns'
    config.protectedPaths = data.protectedPaths
  }
  if (data.rules !== undefined) {
    if (!isRecord(data.rules)) return '"rules" must be an object'

    for (const [name, mode] of Object.entries(data.rules)) {
      if (!RULE_NAMES.includes(name as RuleName)) return `"${name}" is not a rule`
      if (!isMode(mode)) return `rule ${name} must be "allow", "ask" or "deny"`

      config.rules[name as RuleName] = mode
    }
  }
  if (data.custom !== undefined) {
    if (!Array.isArray(data.custom)) return '"custom" must be a list'

    for (const raw of data.custom) {
      if (!isRecord(raw) || typeof raw.match !== 'string' || raw.match === '') {
        return 'each custom rule needs a "match"'
      }
      if (!isMode(raw.mode)) return `custom rule "${raw.match}" needs a mode: "allow", "ask" or "deny"`

      const regex = regexOf(raw.match)

      if (regex === 'invalid') return `custom rule "${raw.match}" is not a valid pattern`

      config.custom.push({
        match: raw.match,
        mode: raw.mode,
        why: typeof raw.why === 'string' && raw.why !== '' ? raw.why : `matches "${raw.match}"`,
      })
    }
  }

  return config
}

/** A custom match written `/like this/i` is a pattern; anything else is literal text. */
function regexOf(match: string): RegExp | null | 'invalid' {
  const found = /^\/(.+)\/([a-z]*)$/.exec(match)

  if (found === null) return null

  try {
    return new RegExp(found[1] ?? '', found[2] ?? '')
  } catch {
    return 'invalid'
  }
}

// --------------------------------------------------------------- parsing

export const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** The commands a shell line holds, each with wrappers such as `sudo` taken off. */
function segmentsOf(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map(part =>
      squash(part)
        .replace(/^[({]\s*/, '')
        .replace(/^((sudo|time|nohup|command)\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ''),
    )
    .filter(part => part !== '')
}

function tokensOf(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(token =>
    token.replace(/^(["'])(.*)\1$/, '$2'),
  )
}

/** A git command's subcommand and its arguments, global options skipped. */
function gitOf(tokens: readonly string[]): { sub: string; args: string[] } | null {
  if (tokens[0] !== 'git') return null

  let at = 1

  while (at < tokens.length) {
    const token = tokens[at] ?? ''

    if (token === '-C' || token === '-c') at += 2
    else if (token.startsWith('-')) at += 1
    else break
  }

  const sub = tokens[at]

  return sub === undefined ? null : { sub, args: tokens.slice(at + 1) }
}

const VALUE_FLAGS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])

type Push = {
  isForce: boolean
  isDelete: boolean
  /** Branch names the push writes; `null` stands for the current branch. */
  targets: Array<string | null>
  isEverything: boolean
}

function pushOf(args: readonly string[]): Push {
  const flags: string[] = []
  const positional: string[] = []

  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] ?? ''

    if (VALUE_FLAGS.has(arg)) at += 1
    else if (arg.startsWith('-')) flags.push(arg)
    else positional.push(arg)
  }

  const refspecs = positional.slice(1)
  const isShortForce = (flag: string): boolean => /^-[a-zA-Z]*f[a-zA-Z]*$/.test(flag)
  const isEverything = flags.some(flag => ['--all', '--mirror', '--branches'].includes(flag))
  const isTagsOnly = flags.includes('--tags') && refspecs.length === 0

  const targets = refspecs.map((refspec): string | null => {
    const plain = refspec.replace(/^\+/, '')
    const target = (plain.includes(':') ? (plain.split(':').pop() ?? '') : plain).replace(
      /^refs\/heads\//,
      '',
    )

    return target === '' || target === 'HEAD' || target === '@' ? null : target
  })

  return {
    isForce:
      flags.some(
        flag =>
          flag === '--force' ||
          flag.startsWith('--force-with-lease') ||
          flag === '--force-if-includes' ||
          isShortForce(flag),
      ) || refspecs.some(refspec => refspec.startsWith('+')),
    isDelete:
      flags.some(flag => flag === '--delete' || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(flag)) ||
      refspecs.some(refspec => refspec.startsWith(':')),
    targets: refspecs.length > 0 || isEverything || isTagsOnly ? targets : [null],
    isEverything,
  }
}

/** True when judging the command needs the branch that is checked out. */
export function needsBranch(command: string): boolean {
  return segmentsOf(command).some(segment => {
    const git = gitOf(tokensOf(segment))

    return git?.sub === 'push' && pushOf(git.args).targets.includes(null)
  })
}

// ------------------------------------------------------------ the rules

const DESTRUCTIVE: ReadonlyArray<readonly [RegExp, string]> = [
  [/^rm\s+(.*\s)?-[a-zA-Z]*[rR][a-zA-Z]*(\s|$)|^rm\s+(.*\s)?--recursive\b/, 'deletes a folder tree'],
  [/^git\s+(.*\s)?reset\s+(.*\s)?--hard\b/, 'discards uncommitted work (git reset --hard)'],
  [/^git\s+(.*\s)?clean\s+(.*\s)?-[a-zA-Z]*f/, 'deletes untracked files (git clean)'],
  [/^git\s+(.*\s)?(checkout|restore)\s+(--\s+)?\.(\s|$)/, 'discards every uncommitted change'],
  [/^git\s+(.*\s)?branch\s+(.*\s)?(-D\b|--delete\s+--force\b)/, 'force-deletes a branch'],
  [/^git\s+(.*\s)?stash\s+(drop|clear)\b/, 'drops stashed work'],
  [/^find\s+.*\s-delete\b/, 'deletes every file a search finds'],
  [/\b(drop\s+(table|database|schema)|truncate\s+table)\b/i, 'drops data from a database'],
  [/^terraform\s+(.*\s)?destroy\b/, 'destroys infrastructure (terraform destroy)'],
  [/^kubectl\s+(.*\s)?delete\b/, 'deletes cluster resources (kubectl delete)'],
  [/^docker\s+(system|volume)\s+(prune|rm)\b/, 'removes docker data'],
]

const LOCAL = /^(\.|\.\/.*|\.\.\/.*|\/.*|.*\.(whl|tar\.gz|tgz|zip))$/

/** The packages an install command names, as typed; empty when it names none. */
function packagesOf(tokens: readonly string[]): string[] {
  const [tool = '', sub = '', third = ''] = tokens
  const named = (from: number, skipAfter: readonly string[] = []): string[] => {
    const names: string[] = []

    for (let at = from; at < tokens.length; at += 1) {
      const token = tokens[at] ?? ''

      if (skipAfter.includes(token)) at += 1
      else if (!token.startsWith('-') && !LOCAL.test(token)) names.push(token)
    }

    return names
  }
  const pipSkips = ['-r', '--requirement', '-c', '--constraint', '-e', '--editable', '--target', '-t']

  switch (tool) {
    case 'npm':
      return ['install', 'i', 'add'].includes(sub) ? named(2) : []
    case 'pnpm':
    case 'bun':
      return ['add', 'install', 'i'].includes(sub) ? named(2) : []
    case 'yarn':
      return sub === 'add' ? named(2) : []
    case 'pip':
    case 'pip3':
      return sub === 'install' ? named(2, pipSkips) : []
    case 'python':
    case 'python3':
      return sub === '-m' && third === 'pip' && tokens[3] === 'install' ? named(4, pipSkips) : []
    case 'uv':
      if (sub === 'add') return named(2)

      return sub === 'pip' && third === 'install' ? named(3, pipSkips) : []
    case 'poetry':
    case 'bundle':
      return sub === 'add' ? named(2) : []
    case 'pipenv':
    case 'conda':
    case 'gem':
    case 'brew':
    case 'apt':
    case 'apt-get':
      return sub === 'install' ? named(2) : []
    case 'cargo':
      return sub === 'add' || sub === 'install' ? named(2) : []
    case 'go':
      return sub === 'get' || sub === 'install' ? named(2) : []
    case 'composer':
      return sub === 'require' ? named(2) : []
    default:
      return []
  }
}

function globOf(pattern: string): RegExp {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')

  return new RegExp(`^${body}$`)
}

/** Whether a path, relative to the project, matches one of the patterns. */
export function matchesPath(patterns: readonly string[], path: string): boolean {
  const clean = path.replace(/^\.\//, '')
  const base = clean.split('/').pop() ?? clean

  return patterns.some(pattern =>
    pattern.includes('/') ? globOf(pattern).test(clean) : globOf(pattern).test(base),
  )
}

const WRITES =
  /^(sed\s+[^|;&]*-i|tee\b|mv\b|rm\b|cp\b|truncate\b|patch\b|chmod\b|git\s+(checkout|restore|apply)\b)/

/** The protected path a shell command looks set to write, or null. */
function protectedWrite(patterns: readonly string[], segment: string): string | null {
  const tokens = tokensOf(segment)

  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at] ?? ''
    const isRedirect = /^\d?>{1,2}/.test(token) || /^\d?>{1,2}$/.test(tokens[at - 1] ?? '')
    const path = token.replace(/^\d?>{1,2}/, '')

    if (path === '' || path.startsWith('-') || !matchesPath(patterns, path)) continue
    if (isRedirect || WRITES.test(segment)) return path
  }

  return null
}

const strictest = (findings: readonly Finding[]): Finding | null =>
  findings.find(one => one.mode === 'deny') ?? findings[0] ?? null

function found(config: Config, rule: RuleName, what: string): Finding[] {
  const mode = config.rules[rule]

  return mode === 'allow' ? [] : [{ rule, mode, what }]
}

/**
 * Judges a shell command: the strictest rule it runs into, or null.
 *
 * `branch` is the branch checked out, asked for only when `needsBranch` says
 * so; null where it could not be read, which counts as protected.
 */
export function judgeBash(config: Config, command: string, branch: string | null): Finding | null {
  const findings: Finding[] = []
  const flat = squash(command)

  for (const custom of config.custom) {
    const regex = regexOf(custom.match)
    const isHit = regex instanceof RegExp ? regex.test(flat) : flat.includes(custom.match)

    if (isHit && custom.mode !== 'allow') {
      findings.push({ rule: 'custom', mode: custom.mode, what: custom.why })
    }
  }

  for (const segment of segmentsOf(command)) {
    const tokens = tokensOf(segment)
    const git = gitOf(tokens)

    if (git?.sub === 'push') {
      const push = pushOf(git.args)

      if (push.isForce) findings.push(...found(config, 'forcePush', 'is a force push'))
      if (push.isDelete) {
        findings.push(...found(config, 'destructiveCommands', 'deletes a remote branch'))
      }

      const isUnknown = push.targets.includes(null) && branch === null
      const hit = push.targets
        .map(target => target ?? branch)
        .find(target => target !== null && config.protectedBranches.includes(target))

      if (push.isEverything) {
        findings.push(...found(config, 'pushToProtectedBranch', 'pushes every branch'))
      } else if (hit !== undefined && hit !== null) {
        findings.push(
          ...found(config, 'pushToProtectedBranch', `pushes to ${hit}, a protected branch`),
        )
      } else if (isUnknown) {
        findings.push(
          ...found(
            config,
            'pushToProtectedBranch',
            'pushes the current branch, which could not be read and may be protected',
          ),
        )
      }
    }

    for (const [pattern, what] of DESTRUCTIVE) {
      if (pattern.test(segment)) {
        findings.push(...found(config, 'destructiveCommands', what))
        break
      }
    }

    const packages = packagesOf(tokens)

    if (packages.length > 0) {
      const shown = packages.slice(0, 3).join(', ') + (packages.length > 3 ? ', ...' : '')

      findings.push(...found(config, 'newDependencies', `installs ${shown}`))
    }

    const rulesFile = protectedWrite([RULES_FILE], segment)

    if (rulesFile !== null) {
      findings.push({ rule: 'rulesFile', mode: 'ask', what: `changes ${RULES_FILE}, the rules themselves` })
    }

    const path = protectedWrite(config.protectedPaths, segment)

    if (path !== null) {
      findings.push(...found(config, 'protectedPaths', `writes ${path}, a protected path`))
    }
  }

  return strictest(findings)
}

const ALWAYS_MANIFESTS =
  /^(requirements[\w.-]*\.txt|Cargo\.toml|go\.mod|Gemfile|Pipfile|pom\.xml|build\.gradle(\.kts)?)$/

const JSON_DEPENDENCY =
  /"(dependencies|devDependencies|peerDependencies|optionalDependencies|require|require-dev)"/

const TOML_DEPENDENCY =
  /dependenc|requires\s*=|["'][A-Za-z][\w.\-[\]]*\s*(==|>=|<=|~=|!=|>|<)\s*\d/

/** Whether an edit's text reads as a change to what a manifest depends on. */
function touchesDependencies(base: string, text: string): boolean {
  if (ALWAYS_MANIFESTS.test(base)) return true
  if (base === 'pyproject.toml') return TOML_DEPENDENCY.test(text)
  if (base !== 'package.json' && base !== 'composer.json') return false
  if (JSON_DEPENDENCY.test(text)) return true

  const pairs = text.matchAll(
    /"([@\w][\w@./-]*)"\s*:\s*"(\^|~|>=|<=|>|<|\*|\d+\.|workspace:|npm:|github:|file:|link:|latest)/g,
  )

  return [...pairs].some(pair => pair[1] !== 'version')
}

/**
 * Judges a file edit: the strictest rule it runs into, or null.
 *
 * `path` is relative to the project; `text` is what the edit removes and adds.
 */
export function judgeEdit(config: Config, path: string, text: string): Finding | null {
  const findings: Finding[] = []
  const clean = path.replace(/^\.\//, '')
  const base = clean.split('/').pop() ?? clean

  if (clean === RULES_FILE) {
    findings.push({ rule: 'rulesFile', mode: 'ask', what: `changes ${RULES_FILE}, the rules themselves` })
  }
  if (matchesPath(config.protectedPaths, clean)) {
    findings.push(...found(config, 'protectedPaths', `writes ${clean}, a protected path`))
  }
  if (touchesDependencies(base, text)) {
    findings.push(...found(config, 'newDependencies', `changes the dependencies in ${clean}`))
  }

  return strictest(findings)
}

// ------------------------------------------------------------------ words

const ADVICE: Record<Finding['rule'], string> = {
  pushToProtectedBranch: 'Push to a feature branch and open a pull request instead.',
  forcePush: 'Push to a new branch instead.',
  destructiveCommands: 'Find a way that does not delete work, or ask the user to do it.',
  newDependencies: 'Use what is already installed, or ask the user to add it.',
  protectedPaths: 'Leave that file as it is and tell the user what you needed from it.',
  custom: 'Ask the user before trying another way.',
  rulesFile: 'Ask the user to change the rules themselves.',
}

/** What the dialog shows on an ask, and what the model reads on a deny. */
export function reasonOf(finding: Finding): string {
  return finding.mode === 'ask'
    ? `House Rules: this ${finding.what}.`
    : `House Rules: this ${finding.what}, which is not allowed in this project. ${ADVICE[finding.rule]}`
}

export const LABELS: Record<RuleName, string> = {
  pushToProtectedBranch: 'Push to a protected branch',
  forcePush: 'Force push',
  destructiveCommands: 'Destructive commands',
  newDependencies: 'New dependencies',
  protectedPaths: 'Protected paths',
}

export function relative(root: string, path: string): string {
  const base = root.endsWith('/') ? root : `${root}/`

  return root !== '' && path.startsWith(base) ? path.slice(base.length) : path
}

export const clip = (text: string, width: number): string =>
  text.length > width ? `${text.slice(0, Math.max(1, width - 3))}...` : text
