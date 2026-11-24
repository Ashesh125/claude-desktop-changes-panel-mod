// The GitLab pane: your GitLab projects, each one's issue board (its columns
// are the project's own board lists), its merge requests and pipelines, with
// issues moved and time spent recorded in GitLab. Everything goes through the
// `glab` CLI and its own login: this mod holds no GitLab token.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { GlColumn, GlData, GlIssue, GlMr, GlPage, GlPipeline, GlProject, GlSaved, GlStatus } from '../types'
import {
  MINUTE,
  avatarSvg,
  baseName,
  clockTime,
  commitEstimate,
  formatMinutes,
  laneDotSvg,
  parseDuration,
  startOfDay,
  startOfWeek,
  startSession,
} from './worklog'

export const GITLAB_PANE = 'changes-panel-gitlab'
export const GITLAB_TITLE = 'GitLab'
const STORE_KEY = 'gitlab-1'
const CACHE_KEY = 'gitlab-cache-1'
const GL_CONFIG = '$HOME/.config/changes-panel/gitlab.json'
const SYNC_EVERY = 15 * MINUTE
const CLOSED_DAYS = 14

const EMPTY_SAVED: GlSaved = { links: {}, pinned: [], timers: {}, entries: [] }
const EMPTY_DATA: GlData = {
  host: null,
  me: null,
  projects: [],
  assigned: [],
  mrs: [],
  columns: {},
  issues: {},
  projectMrs: {},
  pipelines: {},
}

const glData = atom({ plugin: 'changes-panel', key: 'glData' } as const, EMPTY_DATA, { shape: 'gl-data-1' })
const glSaved = atom({ plugin: 'changes-panel', key: 'glSaved' } as const, EMPTY_SAVED, { shape: 'gl-saved-1' })
const glPage = atom({ plugin: 'changes-panel', key: 'glPage' } as const, { name: 'projects' }, { shape: 'gl-page-1' })
const glForm = atom({ plugin: 'changes-panel', key: 'glForm' } as const, null, { shape: 'gl-form-1' })
const glExpanded = atom({ plugin: 'changes-panel', key: 'glExpanded' } as const, null, { shape: 'gl-expanded-1' })
const glMine = atom({ plugin: 'changes-panel', key: 'glMine' } as const, false, { shape: 'gl-mine-1' })
const glStatus = atom(
  { plugin: 'changes-panel', key: 'glStatus' } as const,
  { state: 'off', message: '', syncedAt: null },
  { shape: 'gl-status-1' },
)
// The running GitLab timer, for the band above the prompt.
const glRunning = atom({ plugin: 'changes-panel', key: 'glRunning' } as const, null, { shape: 'gl-running-1' })
// Search results for adding a project.
const glFound = atom({ plugin: 'changes-panel', key: 'glFound' } as const, [], { shape: 'gl-found-1' })
// "group/project" → the local folder whose origin remote points at it.
const glRemotes = atom({ plugin: 'changes-panel', key: 'glRemotes' } as const, {}, { shape: 'gl-remotes-1' })
// Shared with the other panes (same plugin and key, so the same values).
const minute = atom({ plugin: 'changes-panel', key: 'minute' } as const, 0, { shape: 'minute-1' })
const viewing = atom({ plugin: 'changes-panel', key: 'viewing' } as const, null, { shape: 'viewing-1' })

// ---- Small helpers -------------------------------------------------------------

const OPEN_COLUMN: GlColumn = { id: 'open', title: 'Open', label: null, color: '#8b949e' }
const CLOSED_COLUMN: GlColumn = { id: 'closed', title: 'Closed', label: null, color: '#2ea043' }

export const issueKey = (issue: { projectId: string; iid: number }) => `gl:${issue.projectId}:${issue.iid}`

// The column an issue sits in: Closed, else the last board list whose label
// it carries, else Open.
export const columnOf = (issue: GlIssue, columns: readonly GlColumn[]) => {
  if (issue.isClosed) return 'closed'
  let found = 'open'
  for (const column of columns) if (column.label && issue.labels.includes(column.label)) found = column.id
  return found
}

// git@host:group/project.git, ssh://git@host:22/group/project.git and
// https://host/group/project.git all give "group/project" when on `host`.
export const remotePath = (url: string, host: string) => {
  const ssh = /^(?:ssh:\/\/)?[^@\s]+@([^:/\s]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/.exec(url.trim())
  const web = /^https?:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(url.trim())
  const found = web ?? ssh
  if (!found || found[1] !== host) return null
  return found[2] ?? null
}

export const PIPELINE_COLORS: Record<string, string> = {
  success: '#2ea043',
  failed: '#da3633',
  running: '#1f6feb',
  pending: '#d29922',
  created: '#8b949e',
  waiting_for_resource: '#d29922',
  preparing: '#d29922',
  manual: '#8250df',
  scheduled: '#8250df',
  canceled: '#8b949e',
  skipped: '#8b949e',
}
const pipelineColor = (status: string) => PIPELINE_COLORS[status] ?? '#8b949e'

const ago = (iso: string, now: number) => {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / MINUTE))
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

const isoDaysAgo = (now: number, days: number) => new Date(now - days * 24 * 60 * MINUTE).toISOString()

// ---- Saving ------------------------------------------------------------------

async function saveGl($: EngineInterface, change: (saved: GlSaved) => GlSaved) {
  await update($, glSaved, change)
  await $.store.set(STORE_KEY, await read($, glSaved))
}

async function setGlData($: EngineInterface, change: (data: GlData) => GlData) {
  await update($, glData, change)
  await $.store.set(CACHE_KEY, await read($, glData))
}

// ---- glab ----------------------------------------------------------------------

// Module state: found once per load. The desktop app's PATH may lack /snap/bin,
// so ask a login shell, then try the snap's own path.
let glabBin: string | null = null

async function findGlab($: EngineInterface) {
  if (glabBin) return glabBin
  const found = await $.process.run(['sh', '-lc', 'command -v glab || ls /snap/bin/glab 2>/dev/null'])
  const path = found.stdout.trim().split('\n')[0] ?? ''
  if (found.exitCode !== 0 || path === '') throw new Error('glab is not installed, or not on your PATH.')
  glabBin = path
  return path
}

// The GitLab host: ~/.config/changes-panel/gitlab.json {"host": "…"} if you set
// one, else the first host glab is logged in to.
async function findHost($: EngineInterface) {
  const config = await $.process.run(['sh', '-c', `cat "${GL_CONFIG}" 2>/dev/null`])
  if (config.exitCode === 0) {
    try {
      const parsed = JSON.parse(config.stdout) as { host?: unknown }
      if (typeof parsed.host === 'string' && parsed.host !== '') return parsed.host
    } catch {
      // Fall through to glab's login.
    }
  }
  const status = await $.process.run([await findGlab($), 'auth', 'status'])
  const found = /Logged in to (\S+) as /.exec(`${status.stdout}\n${status.stderr}`)
  if (!found?.[1]) throw new Error('glab is not logged in: run `glab auth login`.')
  return found[1]
}

// One GitLab API call through glab. `fields` go as form fields (-f).
async function gl(
  $: EngineInterface,
  host: string,
  path: string,
  method = 'GET',
  fields: Record<string, string> = {},
): Promise<unknown> {
  const argv = [await findGlab($), 'api', '--hostname', host, '-X', method, path]
  for (const [k, v] of Object.entries(fields)) argv.push('-f', `${k}=${v}`)
  const ran = await $.process.run(argv, { timeoutMs: 30000 })
  if (ran.exitCode !== 0) {
    const words = `${ran.stderr}\n${ran.stdout}`.trim().split('\n').filter(Boolean).pop() ?? ''
    throw new Error(words || `glab exited with ${ran.exitCode}`)
  }
  try {
    return JSON.parse(ran.stdout)
  } catch {
    return null
  }
}

// Every page of a list, through glab's own pagination: one object per line.
async function glList<T>($: EngineInterface, host: string, path: string): Promise<T[]> {
  const argv = [await findGlab($), 'api', '--hostname', host, '-X', 'GET', path, '--paginate', '--output', 'ndjson']
  const ran = await $.process.run(argv, { timeoutMs: 120000 })
  if (ran.exitCode !== 0) {
    const words = `${ran.stderr}\n${ran.stdout}`.trim().split('\n').filter(Boolean).pop() ?? ''
    throw new Error(words || `glab exited with ${ran.exitCode}`)
  }
  if (ran.isStdoutTruncated) throw new Error('GitLab sent more than the pane can read at once.')
  const items: T[] = []
  for (const line of ran.stdout.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    const parsed = JSON.parse(text) as T | T[]
    // An older glab prints each page as one array.
    if (Array.isArray(parsed)) items.push(...parsed)
    else items.push(parsed)
  }
  return items
}

type RawIssue = {
  project_id: number
  iid: number
  title: string
  labels: string[]
  state: string
  assignees: { username: string; name: string }[]
  time_stats?: { total_time_spent?: number }
  web_url: string
}
type RawMr = {
  project_id: number
  iid: number
  title: string
  source_branch: string
  draft?: boolean
  work_in_progress?: boolean
  detailed_merge_status?: string
  merge_status?: string
  author: { username: string; name: string }
  reviewers?: { id: number }[]
  web_url: string
}
type RawProject = {
  id: number
  name: string
  path_with_namespace: string
  web_url: string
  default_branch?: string | null
  last_activity_at: string
}
type RawPipeline = { status: string; ref: string; web_url: string; updated_at: string }

const toIssue = (raw: RawIssue, me: GlData['me']): GlIssue => ({
  projectId: String(raw.project_id),
  iid: raw.iid,
  title: raw.title,
  labels: raw.labels ?? [],
  isClosed: raw.state === 'closed',
  assignees: (raw.assignees ?? []).map(a => a.name || a.username),
  isMine: me !== null && (raw.assignees ?? []).some(a => a.username === me.username),
  spentSeconds: raw.time_stats?.total_time_spent ?? 0,
  url: raw.web_url,
})

const toMr = (raw: RawMr, me: GlData['me']): GlMr => ({
  projectId: String(raw.project_id),
  iid: raw.iid,
  title: raw.title,
  branch: raw.source_branch,
  isDraft: Boolean(raw.draft ?? raw.work_in_progress),
  mergeStatus: raw.detailed_merge_status ?? raw.merge_status ?? '',
  author: raw.author.name || raw.author.username,
  isMine: me !== null && raw.author.username === me.username,
  needsMyReview: me !== null && (raw.reviewers ?? []).some(r => r.id === me.id),
  url: raw.web_url,
})

const toPipeline = (raw: RawPipeline): GlPipeline => ({
  status: raw.status,
  ref: raw.ref,
  url: raw.web_url,
  updatedAt: raw.updated_at,
})

async function toProject($: EngineInterface, host: string, raw: RawProject): Promise<GlProject> {
  let pipeline: GlPipeline | null = null
  if (raw.default_branch) {
    try {
      const list = (await gl(
        $,
        host,
        `projects/${raw.id}/pipelines?ref=${encodeURIComponent(raw.default_branch)}&per_page=1`,
      )) as RawPipeline[]
      pipeline = list[0] ? toPipeline(list[0]) : null
    } catch {
      pipeline = null
    }
  }
  return {
    id: String(raw.id),
    path: raw.path_with_namespace,
    name: raw.name,
    url: raw.web_url,
    defaultBranch: raw.default_branch ?? '',
    lastActivity: raw.last_activity_at,
    pipeline,
  }
}

// Git folders beside the session's project, mapped by their origin remote.
async function findRemotes($: EngineInterface, host: string) {
  const cwd = await $.session.cwd()
  const top = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'])
  const here = top.exitCode === 0 ? top.stdout.trim() : cwd
  const parent = here.slice(0, here.lastIndexOf('/')) || '/'
  const found = await $.process.run(['find', parent, '-mindepth', '2', '-maxdepth', '2', '-name', '.git'])
  const folders = found.stdout
    .split('\n')
    .map(line => line.replace(/\/\.git$/, ''))
    .filter(Boolean)
  const map: Record<string, string> = {}
  for (const folder of folders) {
    const url = await $.process.run(['git', '-C', folder, 'remote', 'get-url', 'origin'])
    if (url.exitCode !== 0) continue
    const path = remotePath(url.stdout, host)
    if (path && !(path in map)) map[path] = folder
  }
  await update($, glRemotes, () => map)
  return { map, here }
}

// Who you are, your open issues, MRs and review requests, and the projects
// they are in (plus the ones you pinned, and the session's own repository).
async function syncGitlab($: EngineInterface) {
  await update($, glStatus, (current): GlStatus => ({ ...current, state: 'syncing' }))
  try {
    const host = await findHost($)
    const user = (await gl($, host, 'user')) as { id: number; username: string; name: string }
    const me = { id: user.id, username: user.username, name: user.name }
    const assigned = (await glList<RawIssue>($, host, 'issues?scope=assigned_to_me&state=opened&per_page=100')).map(i =>
      toIssue(i, me),
    )
    const created = await glList<RawMr>($, host, 'merge_requests?scope=created_by_me&state=opened&per_page=100')
    const reviews = await glList<RawMr>($, host, `merge_requests?scope=all&state=opened&reviewer_id=${me.id}&per_page=100`)
    const mrs = [...created, ...reviews.filter(r => !created.some(c => c.project_id === r.project_id && c.iid === r.iid))].map(m =>
      toMr(m, me),
    )

    const { map: remotes, here } = await findRemotes($, host)
    const saved = await read($, glSaved)
    const ids = new Set<string>([...assigned.map(i => i.projectId), ...mrs.map(m => m.projectId), ...saved.pinned])
    const raws: RawProject[] = []
    for (const id of ids) {
      try {
        raws.push((await gl($, host, `projects/${id}`)) as RawProject)
      } catch {
        // A project you lost access to: leave it out.
      }
    }
    // The session's own repository, when it is on this GitLab.
    const herePath = Object.entries(remotes).find(([, folder]) => folder === here)?.[0]
    if (herePath && !raws.some(r => r.path_with_namespace === herePath)) {
      try {
        raws.push((await gl($, host, `projects/${encodeURIComponent(herePath)}`)) as RawProject)
      } catch {
        // Not reachable: leave it out.
      }
    }
    const projects: GlProject[] = []
    for (const raw of raws) projects.push(await toProject($, host, raw))
    projects.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))

    await setGlData($, data => ({ ...data, host, me, projects, assigned, mrs }))
    await saveGl($, s => {
      const links = { ...s.links }
      for (const p of projects) if (!(p.id in links)) links[p.id] = remotes[p.path] ?? null
      return { ...s, links }
    })
    const reviewCount = mrs.filter(m => m.needsMyReview).length
    const syncedAt = await $.clock.now()
    await update($, glStatus, (): GlStatus => ({
      state: 'ok',
      message: `${assigned.length} issue${assigned.length === 1 ? '' : 's'} · ${mrs.filter(m => m.isMine).length} MR${mrs.filter(m => m.isMine).length === 1 ? '' : 's'} · ${reviewCount} review${reviewCount === 1 ? '' : 's'}`,
      syncedAt,
    }))
  } catch (err) {
    await update($, glStatus, (current): GlStatus => ({
      ...current,
      state: 'error',
      message: err instanceof Error ? err.message : String(err),
    }))
  }
}

// A project's board: its first issue board's lists as columns (between Open and
// Closed), its open issues and those closed in the last fortnight, its open MRs
// and latest pipelines.
async function loadBoard($: EngineInterface, projectId: string) {
  const data = await read($, glData)
  const host = data.host
  if (!host) return
  try {
    const boards = await glList<{
      lists: { position: number; label?: { name: string; color: string } | null }[]
    }>($, host, `projects/${projectId}/boards?per_page=100`)
    const board = [...boards].sort((a, b) => b.lists.length - a.lists.length)[0]
    const lists = [...(board?.lists ?? [])]
      .filter(l => l.label)
      .sort((a, b) => a.position - b.position)
      .map((l): GlColumn => ({
        id: `label:${l.label?.name ?? ''}`,
        title: l.label?.name ?? '',
        label: l.label?.name ?? null,
        color: l.label?.color ?? '#8b949e',
      }))
    const columns = [OPEN_COLUMN, ...lists, CLOSED_COLUMN]
    const now = await $.clock.now()
    const open = await glList<RawIssue>($, host, `projects/${projectId}/issues?state=opened&per_page=100`)
    const closed = await glList<RawIssue>(
      $,
      host,
      `projects/${projectId}/issues?state=closed&updated_after=${encodeURIComponent(isoDaysAgo(now, CLOSED_DAYS))}&per_page=100`,
    )
    const mrs = await glList<RawMr>($, host, `projects/${projectId}/merge_requests?state=opened&per_page=100`)
    const pipelines = (await gl($, host, `projects/${projectId}/pipelines?per_page=6`)) as RawPipeline[]
    await setGlData($, d => ({
      ...d,
      columns: { ...d.columns, [projectId]: columns },
      issues: { ...d.issues, [projectId]: [...open, ...closed].map(i => toIssue(i, d.me)) },
      projectMrs: { ...d.projectMrs, [projectId]: mrs.map(m => toMr(m, d.me)) },
      pipelines: { ...d.pipelines, [projectId]: pipelines.map(toPipeline) },
    }))
  } catch (err) {
    $.ui.toast(`Could not load the board: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function replaceIssue($: EngineInterface, issue: GlIssue) {
  await setGlData($, d => ({
    ...d,
    issues: {
      ...d.issues,
      [issue.projectId]: (d.issues[issue.projectId] ?? []).map(i => (i.iid === issue.iid ? issue : i)),
    },
    assigned: issue.isMine && !issue.isClosed
      ? d.assigned.some(i => i.projectId === issue.projectId && i.iid === issue.iid)
        ? d.assigned.map(i => (i.projectId === issue.projectId && i.iid === issue.iid ? issue : i))
        : [...d.assigned, issue]
      : d.assigned.filter(i => !(i.projectId === issue.projectId && i.iid === issue.iid)),
  }))
}

// Moves an issue to a column: swaps the board-list label, and closes or
// reopens it for Closed.
async function moveIssue($: EngineInterface, issue: GlIssue, targetId: string) {
  const data = await read($, glData)
  const host = data.host
  const columns = data.columns[issue.projectId] ?? [OPEN_COLUMN, CLOSED_COLUMN]
  const from = columns.find(c => c.id === columnOf(issue, columns))
  const to = columns.find(c => c.id === targetId)
  if (!host || !to || from?.id === to.id) return
  const fields: Record<string, string> = {}
  if (to.id === 'closed') fields.state_event = 'close'
  else if (issue.isClosed) fields.state_event = 'reopen'
  if (to.id !== 'closed') {
    // Any board-list label goes; the target's comes on.
    const drop = columns.filter(c => c.label && c.id !== to.id && issue.labels.includes(c.label)).map(c => c.label ?? '')
    if (drop.length > 0) fields.remove_labels = drop.join(',')
    if (to.label) fields.add_labels = to.label
  }
  try {
    const raw = (await gl($, host, `projects/${issue.projectId}/issues/${issue.iid}`, 'PUT', fields)) as RawIssue
    await replaceIssue($, toIssue(raw, data.me))
    $.ui.toast(`#${issue.iid} moved to ${to.title}.`)
  } catch (err) {
    $.ui.toast(`Could not move #${issue.iid}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// Records time spent on an issue in GitLab.
async function addSpent($: EngineInterface, issue: GlIssue, minutes: number) {
  const data = await read($, glData)
  if (!data.host) return false
  try {
    await gl($, data.host, `projects/${issue.projectId}/issues/${issue.iid}/add_spent_time`, 'POST', {
      duration: `${minutes}m`,
    })
    const raw = (await gl($, data.host, `projects/${issue.projectId}/issues/${issue.iid}`)) as RawIssue
    await replaceIssue($, toIssue(raw, data.me))
    return true
  } catch (err) {
    $.ui.toast(`Could not add time to #${issue.iid}: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

// All the projects you are a member of, every page, read once per load.
let allProjects: RawProject[] | null = null

export const matchProjects = <P extends { name: string; path_with_namespace: string }>(all: readonly P[], text: string, limit = 12) => {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return all.filter(p => words.every(w => `${p.path_with_namespace} ${p.name}`.toLowerCase().includes(w))).slice(0, limit)
}

async function searchProjects($: EngineInterface, text: string) {
  const data = await read($, glData)
  if (!data.host || text.trim() === '') {
    await update($, glFound, () => [])
    return
  }
  try {
    if (!allProjects) {
      allProjects = await glList<RawProject>($, data.host, 'projects?membership=true&simple=true&order_by=last_activity_at&per_page=100')
    }
    const raws = matchProjects(allProjects, text)
    const found = raws.map(
      (raw): GlProject => ({
        id: String(raw.id),
        path: raw.path_with_namespace,
        name: raw.name,
        url: raw.web_url,
        defaultBranch: raw.default_branch ?? '',
        lastActivity: raw.last_activity_at,
        pipeline: null,
      }),
    )
    await update($, glFound, () => found)
    if (found.length === 0) $.ui.toast(`None of your projects match "${text.trim()}".`)
  } catch (err) {
    $.ui.toast(`Could not search: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---- Timers and time ----------------------------------------------------------

const findIssue = (data: GlData, key: string) => {
  for (const list of [...Object.values(data.issues), data.assigned]) {
    const hit = list.find(i => issueKey(i) === key)
    if (hit) return hit
  }
  return undefined
}

async function refreshGlRunning($: EngineInterface) {
  const saved = await read($, glSaved)
  const data = await read($, glData)
  const entry = Object.entries(saved.timers)[0]
  if (!entry) {
    await update($, glRunning, () => null)
    return
  }
  const [key, startedAt] = entry
  const issue = findIssue(data, key)
  await update($, glRunning, () => ({ label: `#${key.split(':').pop()} ${issue?.title ?? ''}`.trim(), startedAt }))
}

async function startGlTimer($: EngineInterface, key: string) {
  const now = await $.clock.now()
  const saved = await read($, glSaved)
  for (const other of Object.keys(saved.timers)) if (other !== key) await stopGlTimer($, other)
  await saveGl($, s => ({ ...s, timers: { ...s.timers, [key]: s.timers[key] ?? now } }))
  await refreshGlRunning($)
}

async function stopGlTimer($: EngineInterface, key: string) {
  const now = await $.clock.now()
  const since = (await read($, glSaved)).timers[key]
  if (since === undefined) return
  await saveGl($, s => {
    const timers = { ...s.timers }
    delete timers[key]
    return { ...s, timers }
  })
  await refreshGlRunning($)
  const minutes = Math.max(1, Math.round((now - since) / MINUTE))
  await update($, glForm, () => ({
    key,
    minutes,
    reason: `From your timer, started at ${clockTime(since)}.`,
    activities: [],
    activityId: null,
  }))
}

async function openGlLog($: EngineInterface, key: string, folder: string | null) {
  if ((await read($, glSaved)).timers[key] !== undefined) {
    await stopGlTimer($, key)
    return
  }
  await update($, glForm, () => ({ key, minutes: null, reason: 'Estimating…', activities: [], activityId: null }))
  const last = (await read($, glSaved)).entries.filter(e => e.key === key).reduce((max, e) => Math.max(max, e.at), 0)
  const estimate = await commitEstimate($, folder, last)
  await update($, glForm, form => (form?.key === key ? { ...form, ...estimate } : form))
}

async function logGlTime($: EngineInterface, key: string, minutes: number) {
  const issue = findIssue(await read($, glData), key)
  if (!issue) return
  if (!(await addSpent($, issue, minutes))) return
  const at = await $.clock.now()
  await saveGl($, s => ({ ...s, entries: [...s.entries, { key, minutes, at, booked: true }] }))
  await update($, glForm, () => null)
  $.ui.toast(`Added ${formatMinutes(minutes)} to #${issue.iid} in GitLab.`)
}

// ---- Session start (called from the module's one session.start hook) --------------

export async function startGitlab($: EngineInterface) {
  await $.command.register({
    name: 'gitlab-projects',
    description: 'Open the GitLab pane: your GitLab projects, issue boards, merge requests and pipelines',
  })
  await $.tool.register({
    name: 'list_gitlab_work',
    description:
      "Lists the user's open GitLab work: issues assigned to them (with labels and time spent), their open merge " +
      'requests and the merge requests waiting for their review, by project. Use it to say what they are working on in GitLab.',
    inputSchema: { type: 'object', properties: {} },
  })
  const stored = await $.store.get(STORE_KEY)
  if (typeof stored === 'object' && stored !== null && 'timers' in stored) await update($, glSaved, () => stored as GlSaved)
  const cache = await $.store.get(CACHE_KEY)
  if (typeof cache === 'object' && cache !== null && 'projects' in cache) await update($, glData, () => cache as GlData)
  await refreshGlRunning($)
  void syncGitlab($).catch(() => undefined)
  $.clock.every(SYNC_EVERY, () => syncGitlab($).catch(() => undefined))
  $.clock.every(MINUTE, async () => {
    if (Object.keys((await read($, glSaved)).timers).length > 0) await update($, minute, n => n + 1)
  })
}

// ---- Drawing helpers ---------------------------------------------------------------

const pipelineSvg = (status: string) => {
  const color = pipelineColor(status)
  const mark =
    status === 'success'
      ? `<path d="M4.5 8.2l2.3 2.3 4.7-4.9" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
      : status === 'failed'
        ? `<path d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>`
        : status === 'running'
          ? `<circle cx="8" cy="8" r="3" fill="none" stroke="#fff" stroke-width="1.8" stroke-dasharray="12 7"/>`
          : status === 'manual'
            ? `<path d="M6.5 5v6l4.5-3z" fill="#fff"/>`
            : `<circle cx="8" cy="8" r="2.2" fill="#fff"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
    `<circle cx="8" cy="8" r="7.5" fill="${color}"/>${mark}</svg>`
  )
}

// A project's columns as one strip, sized by the issues in each.
const columnStripSvg = (parts: { color: string; count: number }[], width = 220) => {
  const total = parts.reduce((a, p) => a + p.count, 0)
  let x = 0
  const segs = parts
    .map(p => {
      if (p.count === 0 || total === 0) return ''
      const w = (width * p.count) / total
      const seg = `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="8" fill="${p.color}"/>`
      x += w
      return seg
    })
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="8" viewBox="0 0 ${width} 8">` +
    `<defs><clipPath id="g"><rect width="${width}" height="8" rx="4"/></clipPath></defs>` +
    `<rect width="${width}" height="8" rx="4" fill="#8b949e" opacity="0.18"/><g clip-path="url(#g)">${segs}</g></svg>`
  )
}

const MERGE_WORDS: Record<string, string> = {
  mergeable: 'Ready to merge',
  draft_status: 'Draft',
  not_approved: 'Needs approval',
  ci_still_running: 'Pipeline running',
  ci_must_pass: 'Pipeline must pass',
  discussions_not_resolved: 'Open threads',
  conflict: 'Has conflicts',
  need_rebase: 'Needs rebase',
  checking: 'Checking',
  unchecked: 'Not checked yet',
  blocked_status: 'Blocked',
  not_open: 'Not open',
}

// ---- Hooks ---------------------------------------------------------------------------

export const registerGitlab = (on: On) => {
  on('command.run', { command: 'gitlab-projects' }, async $ => {
    await $.ui.open({ id: GITLAB_PANE, title: GITLAB_TITLE })
    void syncGitlab($).catch(() => undefined)
    return { text: 'GitLab pane opened.' }
  })

  on('tool.run', { tool: 'mcp__changes-panel__list_gitlab_work' }, async $ => {
    const data = await read($, glData)
    if (!data.me) return { result: 'GitLab is not synced yet (glab must be installed and logged in).' }
    const name = (id: string) => data.projects.find(p => p.id === id)?.path ?? `project ${id}`
    const ids = [...new Set([...data.assigned.map(i => i.projectId), ...data.mrs.map(m => m.projectId)])]
    const lines = ids.map(id => {
      const issues = data.assigned
        .filter(i => i.projectId === id)
        .map(i => `    - #${i.iid} ${i.title} [${i.labels.join(', ') || 'no labels'}; ${formatMinutes(i.spentSeconds / 60)} spent] ${i.url}`)
      const mrs = data.mrs
        .filter(m => m.projectId === id)
        .map(m => `    - !${m.iid} ${m.title} [${m.isMine ? 'yours' : `by ${m.author}, waiting for your review`}; ${MERGE_WORDS[m.mergeStatus] ?? m.mergeStatus}] ${m.url}`)
      return [
        name(id),
        ...(issues.length ? ['  Issues assigned to you:', ...issues] : []),
        ...(mrs.length ? ['  Merge requests:', ...mrs] : []),
      ].join('\n')
    })
    return { result: lines.length ? lines.join('\n') : 'Nothing open is assigned to you or waiting for your review.' }
  })

  on('ui.render', { component: 'Pane', requestId: GITLAB_PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Input, Select, Link } = ui
    const Svg = 'Svg' in ui ? ui.Svg : null
    const data = await read($, glData)
    const saved = await read($, glSaved)
    const at = await read($, glPage)
    const form = await read($, glForm)
    const open = await read($, glExpanded)
    const mineOnly = await read($, glMine)
    const sync = await read($, glStatus)
    const found = await read($, glFound)
    const remotes = await read($, glRemotes)
    await read($, minute)
    const now = await $.clock.now()

    const timerKey = Object.keys(saved.timers)[0] ?? null
    const elapsed = (key: string) => {
      const since = saved.timers[key]
      return since === undefined ? 0 : Math.max(0, Math.round((now - since) / MINUTE))
    }
    const minutesSince = (since: number, projectId?: string) =>
      saved.entries
        .filter(en => en.at >= since && (!projectId || en.key.startsWith(`gl:${projectId}:`)))
        .reduce((s, en) => s + en.minutes, 0)

    if (e.props.placement === 'widget') {
      return timerKey ? (
        <Text>
          <Text color="success">●</Text> {formatMinutes(elapsed(timerKey))}
        </Text>
      ) : (
        <Text dimColor>{sync.message || 'GitLab'}</Text>
      )
    }

    const project = at.name === 'board' ? data.projects.find(p => p.id === at.projectId) : undefined
    const go = (next: GlPage) => async () => {
      await update($, glPage, () => next)
      await update($, glForm, () => null)
      await update($, glExpanded, () => null)
      if (next.name === 'board') {
        const linked = (await read($, glSaved)).links[next.projectId]
        if (linked) await update($, viewing, () => linked)
        await loadBoard($, next.projectId)
      }
    }
    const folderOptions = [
      { value: '', label: 'Not linked' },
      ...[...new Set(Object.values(remotes))].sort().map(f => ({ value: f, label: baseName(f) })),
    ]

    // ---- Top bar
    const topBar = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} flexWrap="wrap">
          <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1} minWidth={0}>
            {project && (
              <Button key="gl-crumb" plain dimColor onPress={go({ name: 'projects' })}>
                ← Projects
              </Button>
            )}
            <Text bold size="heading" wrap="truncate-end">
              {project ? project.name : 'GitLab'}
            </Text>
            {project && (
              <Text dimColor wrap="truncate-end">
                {project.path}
              </Text>
            )}
          </Box>
          <Text dimColor tabular>
            Today {formatMinutes(minutesSince(startOfDay(now)))} · Week {formatMinutes(minutesSince(startOfWeek(now)))}
          </Text>
        </Box>
        <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
          {timerKey && (
            <Box flexDirection="row" alignItems="center" gap={1} borderStyle="round" borderColor="success" paddingX={1}>
              <Text color="success">●</Text>
              <Text wrap="truncate-end">#{timerKey.split(':').pop()}</Text>
              <Text tabular color="success">
                {formatMinutes(elapsed(timerKey))}
              </Text>
              <Button key="gl-top-stop" plain onPress={() => stopGlTimer($, timerKey)}>
                ■ Stop
              </Button>
            </Box>
          )}
          <Text dimColor color={sync.state === 'error' ? 'error' : undefined} wrap="truncate-end">
            {sync.state === 'off'
              ? 'Not synced yet.'
              : sync.state === 'syncing'
                ? 'Syncing with GitLab…'
                : sync.state === 'error'
                  ? `Could not sync: ${sync.message}`
                  : `${data.host ?? ''} · ${sync.message}${sync.syncedAt ? ` · synced ${clockTime(sync.syncedAt)}` : ''}`}
          </Text>
          <Button
            key="gl-sync"
            plain
            dimColor
            onPress={async () => {
              await syncGitlab($)
              if (project) await loadBoard($, project.id)
            }}
          >
            Sync
          </Button>
        </Box>
      </Box>
    )

    // ---- Projects page
    if (!project) {
      const cards = data.projects.map(p => {
        const issues = data.assigned.filter(i => i.projectId === p.id)
        const mine = data.mrs.filter(m => m.projectId === p.id && m.isMine)
        const reviews = data.mrs.filter(m => m.projectId === p.id && m.needsMyReview)
        const folder = saved.links[p.id] ?? null
        const columns = data.columns[p.id]
        const boardIssues = data.issues[p.id]
        const isPinned = saved.pinned.includes(p.id)
        return (
          <Box key={`gl-project:${p.id}`} flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={2} paddingY={1} minWidth={30} flexGrow={1}>
            <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
              <Box flexDirection="column" flexShrink={1} minWidth={0}>
                <Button key={`gl-board:${p.id}`} plain onPress={go({ name: 'board', projectId: p.id })}>
                  <Text bold size="heading" wrap="truncate-end">
                    {p.name}
                  </Text>
                </Button>
                <Text dimColor size="caption" wrap="truncate-end">
                  {p.path} · active {ago(p.lastActivity, now)}
                </Text>
              </Box>
              <Text dimColor tabular>
                {formatMinutes(minutesSince(startOfWeek(now), p.id))} this week
              </Text>
            </Box>
            <Text>
              <Text bold color="suggestion">
                {issues.length}
              </Text>
              <Text dimColor> issue{issues.length === 1 ? '' : 's'} yours · </Text>
              <Text bold>{mine.length}</Text>
              <Text dimColor> MR{mine.length === 1 ? '' : 's'} · </Text>
              <Text bold color={reviews.length > 0 ? 'warning' : undefined}>
                {reviews.length}
              </Text>
              <Text dimColor> to review</Text>
            </Text>
            {Svg && columns && boardIssues && (
              <Svg
                source={columnStripSvg(
                  columns.map(c => ({ color: c.color, count: boardIssues.filter(i => columnOf(i, columns) === c.id).length })),
                )}
                alt="Issues by column"
              />
            )}
            {p.pipeline && (
              <Box flexDirection="row" alignItems="center" gap={1}>
                {Svg ? <Svg source={pipelineSvg(p.pipeline.status)} alt={p.pipeline.status} /> : <Text color={pipelineColor(p.pipeline.status)}>●</Text>}
                <Text dimColor wrap="truncate-end">
                  {p.pipeline.ref}: {p.pipeline.status} · {ago(p.pipeline.updatedAt, now)}
                </Text>
              </Box>
            )}
            <Select
              key={`gl-folder:${p.id}`}
              label="Folder"
              value={folder ?? ''}
              options={folder && !folderOptions.some(o => o.value === folder) ? [...folderOptions, { value: folder, label: baseName(folder) }] : folderOptions}
              onSelect={async value => {
                const was = (await read($, glSaved)).links[p.id] ?? null
                await saveGl($, s => ({ ...s, links: { ...s.links, [p.id]: value === '' ? null : value } }))
                if (was !== null && (await read($, viewing)) === was) await update($, viewing, () => (value === '' ? null : value))
              }}
            />
            <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
              <Button key={`gl-open-board:${p.id}`} variant="primary" onPress={go({ name: 'board', projectId: p.id })}>
                Open board
              </Button>
              {folder && (
                <Button key={`gl-claude:${p.id}`} onPress={() => startSession($, folder, `Work on ${p.name}`, null, 'GitLab')}>
                  Open in Claude Code
                </Button>
              )}
              <Link href={p.url} label="Open in GitLab" />
              {isPinned && (
                <Button
                  key={`gl-unpin:${p.id}`}
                  plain
                  dimColor
                  onPress={async () => {
                    await saveGl($, s => ({ ...s, pinned: s.pinned.filter(id => id !== p.id) }))
                    await syncGitlab($)
                  }}
                >
                  Remove
                </Button>
              )}
            </Box>
          </Box>
        )
      })
      return (
        <Box flexDirection="column" gap={1}>
          {topBar}
          {data.projects.length === 0 ? (
            <Box borderStyle="round" borderDimColor paddingX={2} paddingY={1}>
              <Text dimColor>
                {sync.state === 'error'
                  ? 'GitLab could not be reached. Check that `glab auth status` shows you logged in, then press Sync.'
                  : 'No GitLab projects with work for you yet. Find one below to add it.'}
              </Text>
            </Box>
          ) : (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {cards}
            </Box>
          )}
          <Input
            key="gl-search"
            placeholder="Find another of your GitLab projects to add"
            value=""
            submitLabel="search"
            onSubmit={value => searchProjects($, value)}
          />
          {found.map(p => (
            <Box key={`gl-found:${p.id}`} flexDirection="row" alignItems="center" gap={1}>
              <Text wrap="truncate-end">{p.path}</Text>
              <Box flexGrow={1} />
              {data.projects.some(q => q.id === p.id) ? (
                <Text dimColor>Added</Text>
              ) : (
                <Button
                  key={`gl-add:${p.id}`}
                  onPress={async () => {
                    await saveGl($, s => ({ ...s, pinned: [...new Set([...s.pinned, p.id])] }))
                    await update($, glFound, () => [])
                    await syncGitlab($)
                  }}
                >
                  Add
                </Button>
              )}
            </Box>
          ))}
        </Box>
      )
    }

    // ---- Board page
    const folder = saved.links[project.id] ?? null
    const columns = data.columns[project.id] ?? [OPEN_COLUMN, CLOSED_COLUMN]
    const issues = (data.issues[project.id] ?? []).filter(i => !mineOnly || i.isMine)
    const columnIndex = (id: string) => columns.findIndex(c => c.id === id)

    const timeForm = (key: string, iid: number) =>
      form?.key === key && (
        <Box flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={1}>
          <Text dimColor>{form.reason}</Text>
          <Input
            key={`gl-time:${key}`}
            label="Time"
            placeholder="1h 20m, 90m or 1:30"
            value={form.minutes === null ? '' : formatMinutes(form.minutes)}
            submitLabel="add"
            autoFocus
            onSubmit={async value => {
              const minutes = parseDuration(value)
              if (minutes === null || minutes <= 0) {
                $.ui.toast('Enter a time like 1h 20m, 90m or 1:30.')
                return
              }
              await logGlTime($, key, minutes)
            }}
          />
          <Box flexDirection="row" gap={1}>
            {form.minutes !== null && (
              <Button
                key={`gl-book:${key}`}
                variant="primary"
                onPress={() => (form.minutes === null ? undefined : logGlTime($, key, form.minutes))}
              >
                {`Add ${formatMinutes(form.minutes)} to #${iid}`}
              </Button>
            )}
            <Button key={`gl-cancel:${key}`} plain dimColor onPress={() => update($, glForm, () => null)}>
              Cancel
            </Button>
          </Box>
        </Box>
      )

    const issueCard = (issue: GlIssue) => {
      const key = issueKey(issue)
      const here = columnOf(issue, columns)
      const index = columnIndex(here)
      const column = columns[index]
      const left = columns[index - 1]
      const right = columns[index + 1]
      const isOpen = open === key
      const extra = issue.labels.filter(l => !columns.some(c => c.label === l))
      const who = issue.assignees[0] ?? null
      return (
        <Box key={`gl-card:${key}`} flexDirection="column" gap={1} borderStyle="round" borderColor={column?.color ?? '#8b949e'} paddingX={1}>
          <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
            <Text mono color="suggestion">
              #{issue.iid}
            </Text>
            {extra.length > 0 && (
              <Text dimColor size="caption" wrap="truncate-end">
                {extra.join(' · ')}
              </Text>
            )}
          </Box>
          <Text bold={issue.isMine}>{issue.title}</Text>
          <Box flexDirection="row" alignItems="center" gap={1}>
            {Svg && <Svg source={avatarSvg(who)} alt={who ?? 'Unassigned'} />}
            <Text dimColor wrap="truncate-end">
              {issue.isMine ? 'You' : (who ?? 'Unassigned')}
              {issue.assignees.length > 1 ? ` +${issue.assignees.length - 1}` : ''}
            </Text>
            <Box flexGrow={1} />
            <Text dimColor tabular>
              {formatMinutes(issue.spentSeconds / 60)} spent
            </Text>
          </Box>
          <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
            {left && (
              <Button key={`gl-left:${key}`} plain onPress={() => moveIssue($, issue, left.id)}>
                {`◀ ${left.title}`}
              </Button>
            )}
            {right && (
              <Button key={`gl-right:${key}`} plain onPress={() => moveIssue($, issue, right.id)}>
                {`${right.title} ▶`}
              </Button>
            )}
            <Box flexGrow={1} />
            {saved.timers[key] !== undefined ? (
              <Button key={`gl-stop:${key}`} variant="primary" onPress={() => stopGlTimer($, key)}>
                {`■ ${formatMinutes(elapsed(key))}`}
              </Button>
            ) : (
              <Button key={`gl-start:${key}`} onPress={() => startGlTimer($, key)}>
                ▶ Timer
              </Button>
            )}
            <Button key={`gl-log:${key}`} onPress={() => openGlLog($, key, folder)}>
              Log time
            </Button>
            <Button key={`gl-more:${key}`} plain dimColor onPress={() => update($, glExpanded, cur => (cur === key ? null : key))}>
              {isOpen ? '⌃' : '⋯'}
            </Button>
          </Box>
          {isOpen && (
            <Box flexDirection="column" gap={1}>
              <Select
                key={`gl-column:${key}`}
                label="Column"
                value={here}
                options={columns.map(c => ({ value: c.id, label: c.title }))}
                onSelect={value => moveIssue($, issue, value)}
              />
              <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
                <Link href={issue.url} label="Open in GitLab" />
                {folder && (
                  <Button
                    key={`gl-work:${key}`}
                    plain
                    onPress={async () => {
                      const task = `GitLab issue #${issue.iid} in ${project.path}: ${issue.title}\n${issue.url}\nRead it with \`glab issue view ${issue.iid}\`.`
                      if (await startSession($, folder, `#${issue.iid} ${issue.title}`, task, 'GitLab')) await startGlTimer($, key)
                    }}
                  >
                    Start in Claude Code
                  </Button>
                )}
              </Box>
            </Box>
          )}
          {timeForm(key, issue.iid)}
        </Box>
      )
    }

    const columnViews = columns.map(column => {
      const inColumn = issues.filter(i => columnOf(i, columns) === column.id)
      return (
        <Box key={`gl-lane:${column.id}`} flexDirection="column" gap={1} minWidth={28} flexGrow={1}>
          <Box flexDirection="row" alignItems="center" gap={1}>
            {Svg ? <Svg source={laneDotSvg(column.color)} alt="" /> : <Text color={column.color}>●</Text>}
            <Text bold>{column.title}</Text>
            <Text dimColor tabular>
              {inColumn.length}
            </Text>
          </Box>
          {inColumn.map(issueCard)}
          {inColumn.length === 0 && (
            <Box borderStyle="round" borderDimColor paddingX={1}>
              <Text dimColor size="caption">
                {column.id === 'closed' ? `Nothing closed in the last ${CLOSED_DAYS} days.` : 'Nothing here.'}
              </Text>
            </Box>
          )}
        </Box>
      )
    })

    const mrs = (data.projectMrs[project.id] ?? []).filter(m => !mineOnly || m.isMine || m.needsMyReview)
    const mrCards = mrs.map(mr => (
      <Box key={`gl-mr:${mr.iid}`} flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={1} minWidth={30} flexGrow={1}>
        <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
          <Text mono color="suggestion">
            !{mr.iid}
          </Text>
          {mr.isDraft && <Text color="warning">Draft</Text>}
          {mr.needsMyReview && <Text color="warning">Needs your review</Text>}
          {mr.isMine && <Text color="success">Yours</Text>}
          <Text dimColor size="caption">
            {MERGE_WORDS[mr.mergeStatus] ?? mr.mergeStatus}
          </Text>
        </Box>
        <Text bold={mr.isMine || mr.needsMyReview}>{mr.title}</Text>
        <Text dimColor size="caption" wrap="truncate-end">
          {mr.author} · {mr.branch}
        </Text>
        <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
          <Link href={mr.url} label="Open in GitLab" />
          {folder && (
            <Button
              key={`gl-review:${mr.iid}`}
              plain
              onPress={() =>
                startSession(
                  $,
                  folder,
                  `Review !${mr.iid} ${mr.title}`,
                  `Review GitLab merge request !${mr.iid} in ${project.path}: ${mr.title}\n${mr.url}\nRead it with \`glab mr view ${mr.iid}\` and \`glab mr diff ${mr.iid}\`. Report findings to me; do not post comments or approve unless I ask.`,
                  'GitLab',
                )
              }
            >
              {mr.isMine ? 'Continue in Claude Code' : 'Review in Claude Code'}
            </Button>
          )}
        </Box>
      </Box>
    ))

    const pipelines = data.pipelines[project.id] ?? []

    return (
      <Box flexDirection="column" gap={1}>
        {topBar}
        <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
          <Button key="gl-filter-all" variant={mineOnly ? 'secondary' : 'primary'} onPress={() => update($, glMine, () => false)}>
            All
          </Button>
          <Button key="gl-filter-mine" variant={mineOnly ? 'primary' : 'secondary'} onPress={() => update($, glMine, () => true)}>
            Mine
          </Button>
          <Box flexGrow={1} />
          <Link href={project.url} label="Open in GitLab" />
          {folder && (
            <Button key="gl-board-claude" plain dimColor onPress={() => startSession($, folder, `Work on ${project.name}`, null, 'GitLab')}>
              Open in Claude Code
            </Button>
          )}
        </Box>
        {data.issues[project.id] === undefined ? (
          <Text dimColor>Loading the board…</Text>
        ) : (
          <Box flexDirection="row" gap={2} flexWrap="wrap" alignItems="flex-start">
            {columnViews}
          </Box>
        )}
        <Text bold size="heading">
          Merge requests <Text dimColor>{mrs.length}</Text>
        </Text>
        {mrCards.length > 0 ? (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {mrCards}
          </Box>
        ) : (
          <Text dimColor>{mineOnly ? 'No open merge requests of yours or for your review.' : 'No open merge requests.'}</Text>
        )}
        {pipelines.length > 0 && (
          <Box flexDirection="column" gap={0}>
            <Text bold size="heading">
              Pipelines
            </Text>
            {pipelines.map((pl, i) => (
              <Box key={`gl-pipeline:${i}`} flexDirection="row" alignItems="center" gap={1}>
                {Svg ? <Svg source={pipelineSvg(pl.status)} alt={pl.status} /> : <Text color={pipelineColor(pl.status)}>●</Text>}
                <Text mono wrap="truncate-end">
                  {pl.ref}
                </Text>
                <Text dimColor>
                  {pl.status} · {ago(pl.updatedAt, now)}
                </Text>
                <Box flexGrow={1} />
                <Link href={pl.url} label="Open" />
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
