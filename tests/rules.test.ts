import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { DEFAULTS, judgeBash, judgeEdit, needsBranch, parseConfig } from '../hooks/rules'

const ROOT = '/repo'

const rule = (command: string, branch: string | null = 'feature') =>
  judgeBash(DEFAULTS, command, branch)?.rule ?? null
const mode = (command: string, branch: string | null = 'feature') =>
  judgeBash(DEFAULTS, command, branch)?.mode ?? null

describe('pushes', () => {
  test('a push to a protected branch is asked about, however it is spelled', () => {
    expect(rule('git push origin main')).toBe('pushToProtectedBranch')
    expect(rule('git push origin HEAD:main')).toBe('pushToProtectedBranch')
    expect(rule('git push -u origin feature:refs/heads/master')).toBe('pushToProtectedBranch')
    expect(rule('git -C api push origin main')).toBe('pushToProtectedBranch')
    expect(rule('npm test && git push origin main')).toBe('pushToProtectedBranch')
    expect(mode('git push origin main')).toBe('ask')
  })

  test('a bare push follows the branch that is checked out', () => {
    expect(rule('git push', 'main')).toBe('pushToProtectedBranch')
    expect(rule('git push origin', 'main')).toBe('pushToProtectedBranch')
    expect(rule('git push', 'feature')).toBe(null)
    expect(rule('git push origin HEAD', 'main')).toBe('pushToProtectedBranch')
  })

  test('a branch that could not be read counts as protected', () => {
    expect(rule('git push', null)).toBe('pushToProtectedBranch')
  })

  test('a push elsewhere goes through', () => {
    expect(rule('git push origin feature')).toBe(null)
    expect(rule('git push -u origin fix/login')).toBe(null)
    expect(rule('git push --tags', 'main')).toBe(null)
    expect(rule('git push origin v1.2.0', 'main')).toBe(null)
    expect(rule('git status && git log --oneline')).toBe(null)
  })

  test('only a push with no named branch needs the current one', () => {
    expect(needsBranch('git push')).toBe(true)
    expect(needsBranch('git push origin HEAD')).toBe(true)
    expect(needsBranch('git push origin feature')).toBe(false)
    expect(needsBranch('git status')).toBe(false)
  })

  test('a force push is refused in every spelling, and wins over an ask', () => {
    expect(rule('git push --force origin feature')).toBe('forcePush')
    expect(rule('git push -f')).toBe('forcePush')
    expect(rule('git push -uf origin feature')).toBe('forcePush')
    expect(rule('git push --force-with-lease origin feature')).toBe('forcePush')
    expect(rule('git push origin +feature')).toBe('forcePush')
    expect(mode('git push --force origin main')).toBe('deny')
    expect(rule('git push --follow-tags origin feature')).toBe(null)
  })
})

describe('destructive commands', () => {
  test('commands that delete work are asked about', () => {
    expect(rule('rm -rf build')).toBe('destructiveCommands')
    expect(rule('rm -r -f node_modules')).toBe('destructiveCommands')
    expect(rule('sudo rm -fr /tmp/x')).toBe('destructiveCommands')
    expect(rule('git reset --hard HEAD~1')).toBe('destructiveCommands')
    expect(rule('git clean -fd')).toBe('destructiveCommands')
    expect(rule('git checkout -- .')).toBe('destructiveCommands')
    expect(rule('git branch -D old')).toBe('destructiveCommands')
    expect(rule('git push origin --delete old')).toBe('destructiveCommands')
    expect(rule('psql -c "DROP TABLE users"')).toBe('destructiveCommands')
  })

  test('their harmless neighbours go through', () => {
    expect(rule('rm notes.txt')).toBe(null)
    expect(rule('git reset HEAD file.txt')).toBe(null)
    expect(rule('git checkout feature')).toBe(null)
    expect(rule('git branch -d merged')).toBe(null)
    expect(rule('grep -rf patterns.txt src')).toBe(null)
  })
})

describe('dependencies', () => {
  test('installing a named package is asked about', () => {
    expect(rule('npm install left-pad')).toBe('newDependencies')
    expect(rule('npm i -D vitest')).toBe('newDependencies')
    expect(rule('pnpm add zod')).toBe('newDependencies')
    expect(rule('yarn add react')).toBe('newDependencies')
    expect(rule('pip install requests')).toBe('newDependencies')
    expect(rule('python -m pip install numpy')).toBe('newDependencies')
    expect(rule('uv add httpx')).toBe('newDependencies')
    expect(rule('cargo add serde')).toBe('newDependencies')
    expect(rule('go get github.com/pkg/errors')).toBe('newDependencies')
    expect(judgeBash(DEFAULTS, 'npm install left-pad', 'x')?.what).toBe('installs left-pad')
  })

  test('installing what is already declared goes through', () => {
    expect(rule('npm install')).toBe(null)
    expect(rule('npm ci')).toBe(null)
    expect(rule('pnpm install --frozen-lockfile')).toBe(null)
    expect(rule('pip install -r requirements.txt')).toBe(null)
    expect(rule('pip install -e .')).toBe(null)
    expect(rule('npm run build')).toBe(null)
    expect(rule('cargo build')).toBe(null)
  })

  test('an edit that changes a manifest is asked about', () => {
    expect(judgeEdit(DEFAULTS, 'package.json', '"zod": "^3.23.0"')?.rule).toBe('newDependencies')
    expect(judgeEdit(DEFAULTS, 'requirements.txt', 'requests')?.rule).toBe('newDependencies')
    expect(judgeEdit(DEFAULTS, 'api/Cargo.toml', 'serde = "1"')?.rule).toBe('newDependencies')
    expect(judgeEdit(DEFAULTS, 'pyproject.toml', '"numpy>=1.26"')?.rule).toBe('newDependencies')
  })

  test('an edit to the rest of a manifest goes through', () => {
    expect(judgeEdit(DEFAULTS, 'package.json', '"version": "1.0.1"')).toBe(null)
    expect(judgeEdit(DEFAULTS, 'package.json', '"test": "vitest run"')).toBe(null)
    expect(judgeEdit(DEFAULTS, 'pyproject.toml', 'line-length = 100')).toBe(null)
    expect(judgeEdit(DEFAULTS, 'src/app.ts', 'import zod')).toBe(null)
  })
})

describe('protected paths and the rules file', () => {
  test('writing a protected path is asked about', () => {
    expect(judgeEdit(DEFAULTS, '.env', 'KEY=1')?.rule).toBe('protectedPaths')
    expect(judgeEdit(DEFAULTS, 'config/.env.production', 'KEY=1')?.rule).toBe('protectedPaths')
    expect(judgeEdit(DEFAULTS, 'certs/server.pem', 'x')?.rule).toBe('protectedPaths')
    expect(rule('echo KEY=1 >> .env')).toBe('protectedPaths')
    expect(rule('cp .env.example .env')).toBe('protectedPaths')
  })

  test('reading one, or writing its neighbour, goes through', () => {
    expect(rule('cat .env')).toBe(null)
    expect(judgeEdit(DEFAULTS, 'src/env.ts', 'x')).toBe(null)
    expect(judgeEdit(DEFAULTS, 'README.md', '.env')).toBe(null)
  })

  test('the rules file is always asked about, whatever the rules say', () => {
    const open = parseConfig('{"rules":{"protectedPaths":"allow"}}')

    expect(typeof open).toBe('object')
    if (typeof open === 'string') return

    expect(judgeEdit(open, '.house-rules.json', '{}')?.rule).toBe('rulesFile')
    expect(judgeBash(open, 'echo "{}" > .house-rules.json', 'x')?.rule).toBe('rulesFile')
    expect(judgeEdit(open, '.env', 'KEY=1')).toBe(null)
  })
})

describe('the config', () => {
  test('a rule can be turned off, tightened, or added', () => {
    const config = parseConfig(
      JSON.stringify({
        protectedBranches: ['release'],
        rules: { forcePush: 'ask', newDependencies: 'allow', pushToProtectedBranch: 'deny' },
        custom: [{ match: 'terraform apply', mode: 'deny', why: 'applies infrastructure changes' }],
      }),
    )

    if (typeof config === 'string') throw new Error(config)

    expect(judgeBash(config, 'git push -f origin feature', 'x')?.mode).toBe('ask')
    expect(judgeBash(config, 'npm install left-pad', 'x')).toBe(null)
    expect(judgeBash(config, 'git push origin main', 'x')).toBe(null)
    expect(judgeBash(config, 'git push origin release', 'x')?.mode).toBe('deny')
    expect(judgeBash(config, 'terraform apply -auto-approve', 'x')?.rule).toBe('custom')
  })

  test('a config that is wrong says how', () => {
    expect(parseConfig('{')).toBe('not valid JSON')
    expect(parseConfig('{"rules":{"forcePush":"maybe"}}')).toBe(
      'rule forcePush must be "allow", "ask" or "deny"',
    )
    expect(parseConfig('{"rules":{"noSuchRule":"ask"}}')).toBe('"noSuchRule" is not a rule')
  })
})

// --------------------------------------------------------- through the engine

type World = { branch: string; verdict: 'allow' | 'ask' | 'deny'; refuse: boolean; toasts: string[] }

function world(on: On, config: string | null = null): World {
  const state: World = { branch: 'feature', verdict: 'allow', refuse: false, toasts: [] }

  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.exists', ($, e) => ({ value: config !== null && e.path === `${ROOT}/.house-rules.json` }))
  on('fs.read', () => ({ value: config ?? '' }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: `${state.branch}\n`,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  // What the permission rules decided before any mod spoke.
  on('tool.check', () => ({ decision: state.verdict }))
  on('tool.call', () => (state.refuse ? { deny: 'The user refused.' } : { result: {} }))

  return state
}

const START = { cwd: ROOT, surface: 'terminal', isInteractive: true } as const

const PANE = {
  component: 'Pane',
  requestId: 'house-rules',
  props: {
    title: 'House Rules',
    isFocused: true,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

describe('at the permission check', () => {
  test('an allowed call a rule covers is put to the person, with the reason', async ($, on) => {
    world(on)
    await $.session.start(START)

    const check = await $.tool.check({ tool: 'Bash', input: { command: 'git push origin main' } })

    expect(check.decision).toBe('ask')
    expect(check.reason).toBe('House Rules: this pushes to main, a protected branch.')
  })

  test('a denied rule refuses and tells Claude what to do instead', async ($, on) => {
    const state = world(on)

    await $.session.start(START)

    const check = await $.tool.check({ tool: 'Bash', input: { command: 'git push -f origin fix' } })

    expect(check.decision).toBe('deny')
    expect(check.reason).toMatch(/force push.*Push to a new branch instead/)
    expect(state.toasts).toEqual(['Blocked: this is a force push.'])
  })

  test('a bare push reads the branch from git', async ($, on) => {
    const state = world(on)

    await $.session.start(START)
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'git push' } })).decision).toBe('allow')

    state.branch = 'main'
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'git push' } })).decision).toBe('ask')
  })

  test('a rule never loosens what was already refused', async ($, on) => {
    const state = world(on)

    state.verdict = 'deny'
    await $.session.start(START)

    const check = await $.tool.check({ tool: 'Bash', input: { command: 'git push origin main' } })

    expect(check.decision).toBe('deny')
  })

  test('an ordinary call keeps the verdict it had', async ($, on) => {
    world(on)
    await $.session.start(START)

    expect((await $.tool.check({ tool: 'Bash', input: { command: 'npm test' } })).decision).toBe('allow')
    expect(
      (await $.tool.check({ tool: 'Edit', input: { file_path: `${ROOT}/src/a.ts`, old_string: 'a', new_string: 'b' } }))
        .decision,
    ).toBe('allow')
  })

  test('an edit to a protected path is asked about', async ($, on) => {
    world(on)
    await $.session.start(START)

    const check = await $.tool.check({
      tool: 'Write',
      input: { file_path: `${ROOT}/.env`, content: 'KEY=1' },
    })

    expect(check.decision).toBe('ask')
    expect(check.reason).toBe('House Rules: this writes .env, a protected path.')
  })

  test('the project file changes the rules, and a broken one changes nothing', async ($, on) => {
    world(on, '{"rules":{"forcePush":"ask"}}')
    await $.session.start(START)

    const check = await $.tool.check({ tool: 'Bash', input: { command: 'git push -f origin fix' } })

    expect(check.decision).toBe('ask')
  })

  test('a file that does not parse leaves the defaults in force', async ($, on) => {
    world(on, '{"rules":')
    await $.session.start(START)

    const check = await $.tool.check({ tool: 'Bash', input: { command: 'git push -f origin fix' } })

    expect(check.decision).toBe('deny')
  })
})

describe('the pane', () => {
  test('it lists the rules and what happened to each call a rule touched', async ($, on) => {
    const state = world(on)

    await $.session.start(START)
    await $.tool.check({ tool: 'Bash', input: { command: 'git push -f origin fix' }, tool_use_id: 'a' })
    await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'b' })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b', command: 'rm -rf build' })
    await $.tool.check({ tool: 'Bash', input: { command: 'npm install left-pad' }, tool_use_id: 'c' })
    state.refuse = true
    await $.tool.call({ tool: 'Bash', tool_use_id: 'c', command: 'npm install left-pad' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'house-rules-guard', surface, ...PANE })

      await ui.press({ key: 'tab-rules' })
      expect(await ui.find({ type: 'Text', text: 'Force push' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'DENY' })).toBeDefined()

      await ui.press({ key: 'tab-log' })
      expect(await ui.find({ type: 'Text', text: 'BLOCKED' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'ALLOWED' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'REFUSED' })).toBeDefined()
      await ui.unmount()
    }
  })
})
