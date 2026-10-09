/** One time a rule stepped in, and how it ended. */
export type Entry = {
  /** The tool call's id. */
  id: string
  rule: string
  mode: 'ask' | 'deny'
  /** What the call does, completing "this ...". */
  what: string
  /** The command or the path, cut short. */
  subject: string
  /** `asked` until the call settles, then whether it ran. */
  outcome: 'blocked' | 'asked' | 'ran' | 'refused'
}

export type Tab = 'rules' | 'log'

declare module 'claude-code' {
  interface PluginState {
    'house-rules-guard': { log: Entry[]; tab: Tab; problem: string | null }
  }
}
