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

// One line of a file's diff, numbered on each side it exists on.
export type DiffLine = { kind: 'add' | 'del' | 'ctx'; old: number | null; new: number | null; text: string }
// The one file the Changes pane shows a diff of, in place of the file list.
export type DiffView = {
  path: string
  lines: DiffLine[]
  isBinary: boolean
  isLoading: boolean
  error: string | null
  // The whole file, or only the changes with their context.
  full: boolean
  // Folded ranges the person opened, [from, to) by line index.
  revealed: [number, number][]
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

// ---- GitLab pane
export type GlPipeline = { status: string; ref: string; url: string; updatedAt: string }
export type GlProject = {
  id: string
  path: string
  name: string
  url: string
  defaultBranch: string
  lastActivity: string
  pipeline: GlPipeline | null
}
// A board column: an issue-board list's label, or Open / Closed (label null).
export type GlColumn = { id: string; title: string; label: string | null; color: string }
export type GlIssue = {
  projectId: string
  iid: number
  title: string
  labels: string[]
  isClosed: boolean
  assignees: string[]
  isMine: boolean
  spentSeconds: number
  url: string
}
export type GlMr = {
  projectId: string
  iid: number
  title: string
  branch: string
  isDraft: boolean
  mergeStatus: string
  author: string
  isMine: boolean
  needsMyReview: boolean
  url: string
}
export type GlData = {
  host: string | null
  me: { id: number; username: string; name: string } | null
  projects: GlProject[]
  // Your open issues, MRs and review requests across GitLab.
  assigned: GlIssue[]
  mrs: GlMr[]
  // Per project, loaded when its board opens.
  columns: Record<string, GlColumn[]>
  issues: Record<string, GlIssue[]>
  projectMrs: Record<string, GlMr[]>
  pipelines: Record<string, GlPipeline[]>
}
export type GlSaved = {
  // GitLab project id → local folder.
  links: Record<string, string | null>
  // Projects you added by search, shown even without work assigned.
  pinned: string[]
  timers: Record<string, number>
  entries: Entry[]
}
export type GlPage = { name: 'projects' } | { name: 'board'; projectId: string }
export type GlStatus = { state: 'off' | 'syncing' | 'ok' | 'error'; message: string; syncedAt: number | null }

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
      folder: Shaped<string>
      viewing: Shaped<string | null>
      diff: Shaped<DiffView>
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
      glData: Shaped<GlData>
      glSaved: Shaped<GlSaved>
      glPage: Shaped<GlPage>
      glForm: Shaped<LogForm>
      glExpanded: Shaped<string | null>
      glMine: Shaped<boolean>
      glStatus: Shaped<GlStatus>
      glRunning: Shaped<Running>
      glFound: Shaped<GlProject[]>
      glRemotes: Shaped<Record<string, string>>
    }
  }
}
