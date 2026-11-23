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

// ---- Projects pane: OpenProject work, timers and time --------------------------

export type Lane = 'todo' | 'doing' | 'review' | 'done'
export type OpStatusDef = { id: string; name: string; isClosed: boolean }
export type OpProject = { id: string; title: string }
// One work package, as the board shows it.
export type WorkItem = {
  id: number
  projectId: string
  subject: string
  statusId: string
  status: string
  type: string
  assignee: string | null
  isMine: boolean
  // Time booked on it in OpenProject, ISO 8601 ("PT1H15M").
  spent: string | null
  lockVersion: number
  url: string
}
export type OpData = {
  me: string | null
  projects: OpProject[]
  statuses: OpStatusDef[]
  items: WorkItem[]
}
// A task of your own, kept in the pane and never sent to OpenProject.
export type LocalTask = {
  id: string
  projectId: string
  title: string
  lane: Lane
  createdBy: 'you' | 'claude'
  createdAt: number
}
// Time logged here; `booked` when it also went to OpenProject.
export type Entry = { key: string; minutes: number; at: number; booked: boolean }
export type Worklog = {
  // OpenProject project id → the local folder its work happens in.
  links: Record<string, string | null>
  local: LocalTask[]
  // Item key ("wp:411", "local:abc") → when its timer started, in ms.
  timers: Record<string, number>
  entries: Entry[]
}
export type Page = { name: 'projects' } | { name: 'board'; projectId: string }
export type Activity = { id: string; name: string }
// The time form open on a card, with the estimate it offers.
export type LogForm = {
  key: string
  minutes: number | null
  reason: string
  activities: Activity[]
  activityId: string | null
} | null
export type OpStatus = { state: 'off' | 'ok' | 'error' | 'syncing'; message: string; syncedAt: number | null }
export type Running = { label: string; startedAt: number } | null

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
      worklog: Shaped<Worklog>
      opData: Shaped<OpData>
      page: Shaped<Page>
      logForm: Shaped<LogForm>
      expanded: Shaped<string | null>
      onlyMine: Shaped<boolean>
      repos: Shaped<string[]>
      minute: Shaped<number>
      opStatus: Shaped<OpStatus>
      running: Shaped<Running>
    }
  }
}
