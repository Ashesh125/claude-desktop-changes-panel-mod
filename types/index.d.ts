export type ChangedFile = {
  status: string
  path: string
  isUntracked: boolean
  added: number
  removed: number
  isBinary: boolean
}
export type Mode = 'working' | 'commit' | 'graph'
export type CommitHead = { hash: string; subject: string; author: string; when: string }
export type Listing = {
  files: ChangedFile[]
  error: string | null
  summary: string
  head: CommitHead | null
}
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
export type Footer = { project: string; branch: string }
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
      picked: Shaped<string | null>
      rev: Shaped<string>
      graph: Shaped<GraphRow[]>
      graphLimit: Shaped<number>
      footer: Shaped<Footer>
      context: Shaped<ContextInfo>
      contextOpen: Shaped<boolean>
      collapsed: Shaped<string[]>
    }
  }
}
