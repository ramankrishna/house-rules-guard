// House Rules: the constraints you would otherwise paste into every prompt,
// enforced where Claude Code decides whether a tool call may run.
//
// A rule set to "ask" puts the call to you with the reason; "deny" refuses it
// and tells Claude why. Nothing here asks a model anything or leaves the machine.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry, Tab } from '../types'
import {
  clip,
  DEFAULTS,
  judgeBash,
  judgeEdit,
  LABELS,
  needsBranch,
  parseConfig,
  reasonOf,
  relative,
  RULE_NAMES,
  RULES_FILE,
} from './rules'
import type { Config, Finding } from './rules'

const PANE = 'house-rules'

const log = atom({ plugin: 'house-rules-guard', key: 'log' } as const, [])
const tab = atom({ plugin: 'house-rules-guard', key: 'tab' } as const, 'rules')
const problem = atom({ plugin: 'house-rules-guard', key: 'problem' } as const, null)

// What the guards read without a call on `$`: a `.catch` handler may not make
// one, and a guard that cannot tell must still hold the rules.
let root = ''
let config: Config = DEFAULTS
let hasFile = false
const asked = new Set<string>()

const field = (input: unknown, name: string): string => {
  const value = (input as Record<string, unknown> | null)?.[name]

  return typeof value === 'string' ? value : ''
}

/** Reads `.house-rules.json` at the project root; the defaults stand without one. */
async function load($: EngineInterface): Promise<void> {
  root = await $.session.root()

  const path = `${root}/${RULES_FILE}`

  hasFile = await $.fs.exists(path)

  if (!hasFile) {
    config = DEFAULTS
    await update($, problem, () => null)

    return
  }

  let text = ''

  try {
    text = await $.fs.read(path)
  } catch {
    text = ''
  }

  const parsed = parseConfig(text)

  // A file that does not parse loosens nothing: the defaults hold until it is fixed.
  config = typeof parsed === 'string' ? DEFAULTS : parsed
  await update($, problem, () => (typeof parsed === 'string' ? parsed : null))
}

async function init($: EngineInterface): Promise<string> {
  root = await $.session.root()

  const path = `${root}/${RULES_FILE}`

  if (await $.fs.exists(path)) return `${RULES_FILE} already exists. Edit it, then run /house-rules.`

  const starter = {
    protectedBranches: DEFAULTS.protectedBranches,
    rules: DEFAULTS.rules,
    protectedPaths: DEFAULTS.protectedPaths,
    custom: [],
  }

  await $.fs.write(path, `${JSON.stringify(starter, null, 2)}\n`)
  await load($)

  return `Wrote ${RULES_FILE} with the default rules. Set each rule to "allow", "ask" or "deny".`
}

async function currentBranch($: EngineInterface): Promise<string | null> {
  try {
    const ran = await $.process.run(['git', 'branch', '--show-current'], { cwd: root, timeoutMs: 5000 })
    const name = ran.stdout.trim()

    return ran.exitCode === 0 && name !== '' ? name : null
  } catch {
    return null
  }
}

/** Records that a rule stepped in, and says so when it blocked. */
async function note(
  $: EngineInterface,
  id: string | undefined,
  finding: Finding,
  subject: string,
): Promise<void> {
  const entry: Entry = {
    id: id ?? '',
    rule: finding.rule,
    mode: finding.mode,
    what: finding.what,
    subject: clip(subject.replace(/\s+/g, ' ').trim(), 120),
    outcome: finding.mode === 'deny' ? 'blocked' : 'asked',
  }

  if (finding.mode === 'ask' && id !== undefined) asked.add(id)
  if (finding.mode === 'deny') $.ui.toast(`Blocked: this ${finding.what}.`)

  await update($, log, was => [...was, entry].slice(-50))
}

const openPane = ($: EngineInterface) =>
  $.ui.open({ id: PANE, title: 'House Rules', focus: true, closeOnEscape: true })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'house-rules',
      description: 'Show the rules Claude works under here, and when they stepped in',
      argumentHint: '[init]',
    })
    await load($)

    return next(e)
  })

  // /clear, /resume and /branch raise no session.start: read the rules again.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await load($)

    return next(e)
  })

  // An edit you make by hand between turns takes hold on the next one.
  on('turn.start', async ($, e, next) => {
    await load($)

    return next(e)
  })

  on('command.run', { command: 'house-rules' }, async ($, e) => {
    if (e.args.trim() === 'init') return { text: await init($) }

    await load($)
    await openPane($)

    return {}
  })

  // ------------------------------------------------------------- deciding

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const decided = await next(e)
    const command = field(e.input, 'command')

    if (command === '') return decided

    const branch = needsBranch(command) ? await currentBranch($) : null
    const finding = judgeBash(config, command, branch)

    if (finding === null) return decided

    await note($, e.tool_use_id, finding, command)

    // A rule only tightens: a call already refused stays refused.
    if (finding.mode === 'ask' && decided.decision === 'deny') return decided

    return { decision: finding.mode, reason: reasonOf(finding) }
  }).catch(($, e, next) => {
    // The hook failed: judge from what is in memory, the branch unknown.
    const finding = judgeBash(config, field(e.input, 'command'), null)

    return finding === null ? next(e) : { decision: finding.mode, reason: reasonOf(finding) }
  })

  on('tool.check', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const decided = await next(e)
    const path = relative(root, field(e.input, 'file_path'))

    if (path === '') return decided

    const text = `${field(e.input, 'old_string')}\n${field(e.input, 'new_string')}\n${field(e.input, 'content')}`
    const finding = judgeEdit(config, path, text)

    if (finding === null) return decided

    await note($, e.tool_use_id, finding, path)

    if (finding.mode === 'ask' && decided.decision === 'deny') return decided

    return { decision: finding.mode, reason: reasonOf(finding) }
  }).catch(($, e, next) => {
    const path = relative(root, field(e.input, 'file_path'))
    const text = `${field(e.input, 'old_string')}\n${field(e.input, 'new_string')}\n${field(e.input, 'content')}`
    const finding = judgeEdit(config, path, text)

    return finding === null ? next(e) : { decision: finding.mode, reason: reasonOf(finding) }
  })

  // How a call you were asked about ended: whether it ran or you refused it.
  on('tool.call', { tool: ['Bash', 'Edit', 'Write'] }, async ($, e, next) => {
    const ran = await next(e)

    if (!asked.has(e.tool_use_id)) return ran

    asked.delete(e.tool_use_id)

    const outcome = ran.deny === undefined ? 'ran' : 'refused'

    await update($, log, was =>
      was.map(entry =>
        entry.id === e.tool_use_id && entry.outcome === 'asked' ? { ...entry, outcome } : entry,
      ),
    )

    if (ran.deny === undefined && relative(root, 'file_path' in e ? e.file_path : '') === RULES_FILE) {
      await load($)
    }

    return ran
  })

  // -------------------------------------------------------------- drawing

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const entries = await read($, log)
    const shown = await read($, tab)
    const wrong = await read($, problem)
    const width = Math.max(24, e.props.bodyColumns - 10)

    const tabButton = (to: Tab, label: string, hotkey: string) => (
      <Button
        key={`tab-${to}`}
        label={label}
        hotkey={hotkey}
        plain
        dimColor={shown !== to}
        onPress={() => update($, tab, () => to)}
      />
    )

    const modeText = (mode: string) =>
      mode === 'deny' ? (
        <Text color="error">DENY</Text>
      ) : mode === 'ask' ? (
        <Text color="warning">ASK</Text>
      ) : (
        <Text dimColor>ALLOW</Text>
      )

    const rules = (
      <Box flexDirection="column" rowGap={1}>
        {wrong !== null && (
          <Text color="error">
            {RULES_FILE} is not usable ({wrong}). The default rules are in force.
          </Text>
        )}
        <Box flexDirection="column">
          {RULE_NAMES.map(name => (
            <Box flexDirection="row" columnGap={2}>
              <Box width={6} flexShrink={0}>
                {modeText(config.rules[name])}
              </Box>
              <Text>{LABELS[name]}</Text>
            </Box>
          ))}
          {config.custom.map(rule => (
            <Box flexDirection="row" columnGap={2}>
              <Box width={6} flexShrink={0}>
                {modeText(rule.mode)}
              </Box>
              <Text>{clip(rule.why, width)}</Text>
            </Box>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text dimColor>Protected branches: {clip(config.protectedBranches.join(', ') || 'none', width)}</Text>
          <Text dimColor>Protected paths: {clip(config.protectedPaths.join(', ') || 'none', width)}</Text>
        </Box>
        <Text dimColor>
          {hasFile
            ? `From ${RULES_FILE}. Claude must ask before changing it.`
            : `These are the defaults. /house-rules init writes ${RULES_FILE} so you can change them.`}
        </Text>
      </Box>
    )

    const history = (
      <Box flexDirection="column" rowGap={1}>
        {entries.length === 0 && <Text dimColor>No rule has stepped in this session.</Text>}
        {entries
          .slice(-10)
          .reverse()
          .map(entry => (
            <Box flexDirection="column">
              <Box flexDirection="row" columnGap={2}>
                {entry.outcome === 'blocked' ? (
                  <Text color="error">BLOCKED</Text>
                ) : entry.outcome === 'refused' ? (
                  <Text color="warning">REFUSED</Text>
                ) : entry.outcome === 'ran' ? (
                  <Text color="success">ALLOWED</Text>
                ) : (
                  <Text dimColor>ASKED</Text>
                )}
                <Text>{clip(entry.what, width)}</Text>
              </Box>
              <Text dimColor>{clip(entry.subject, width + 8)}</Text>
            </Box>
          ))}
      </Box>
    )

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="row" columnGap={3}>
          {tabButton('rules', 'Rules', '1')}
          {tabButton('log', `Log (${entries.length})`, '2')}
        </Box>
        {shown === 'rules' ? rules : history}
      </Box>
    )
  })
}
