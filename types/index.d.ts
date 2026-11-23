export type ChangedFile = {
  status: string
  path: string
  isUntracked: boolean
  added: number
  removed: number
  isBinary: boolean
}
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
export type Footer = { project: string; branch: string; model: string }
export type ContextInfo = {
  percent: number
  tokens: number
  window: number
  categories: { name: string; tokens: number; color: string }[]
} | null

declare module 'claude-code' {
  interface PluginState {
    'changes-panel': {
      listing: Shaped<Listing>
      mode: Shaped<Mode>
      shown: Shaped<Shown>
      rev: Shaped<string>
      graph: Shaped<GraphRow[]>
      graphLimit: Shaped<number>
      footer: Shaped<Footer>
      context: Shaped<ContextInfo>
      contextOpen: Shaped<boolean>
    }
  }
}
