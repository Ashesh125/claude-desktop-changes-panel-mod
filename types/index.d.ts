export type ChangedFile = { status: string; path: string; isUntracked: boolean }
export type Mode = 'working' | 'commit' | 'graph'
export type Listing = { files: ChangedFile[]; error: string | null; summary: string }
export type Shown = { path: string; diff: string } | null
export type GraphRow = {
  hash: string
  short: string
  refs: string[]
  subject: string
  author: string
  when: string
  isMerge: boolean
  svg: string
  text: string
}
export type Run = { id: number; command: string; output: string; exitCode: number | null }

declare module 'claude-code' {
  interface PluginState {
    'changes-panel': {
      listing: Shaped<Listing>
      mode: Shaped<Mode>
      shown: Shaped<Shown>
      rev: Shaped<string>
      graph: Shaped<GraphRow[]>
      graphLimit: Shaped<number>
      runs: Shaped<Run[]>
    }
  }
}
