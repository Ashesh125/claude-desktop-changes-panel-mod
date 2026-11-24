// The OpenProject pane: your OpenProject projects, each one's work on a board,
// moved and timed from here. The URL and API key live on this machine only,
// in ~/.config/changes-panel/openproject.json: {"url": "https://…", "apiKey": "…"}.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { Activity, Lane, LocalTask, OpData, OpStatus, OpStatusDef, Page, WorkItem, Worklog } from '../types'

export const PROJECTS_PANE = 'changes-panel-projects'
export const PROJECTS_TITLE = 'OpenProject'
export const MINUTE = 60_000
const STORE_KEY = 'worklog-2'
const CACHE_KEY = 'op-cache'
const OP_CONFIG = '$HOME/.config/changes-panel/openproject.json'
const OP_SYNC_EVERY = 15 * MINUTE

const EMPTY_LOG: Worklog = { links: {}, local: [], timers: {}, entries: [] }
const EMPTY_DATA: OpData = { me: null, projects: [], statuses: [], items: [] }

const worklog = atom({ plugin: 'changes-panel', key: 'worklog' } as const, EMPTY_LOG, { shape: 'worklog-2' })
const opData = atom({ plugin: 'changes-panel', key: 'opData' } as const, EMPTY_DATA, { shape: 'op-data-1' })
const page = atom({ plugin: 'changes-panel', key: 'page' } as const, { name: 'projects' }, { shape: 'page-1' })
const logForm = atom({ plugin: 'changes-panel', key: 'logForm' } as const, null, { shape: 'log-form-1' })
const expanded = atom({ plugin: 'changes-panel', key: 'expanded' } as const, null, { shape: 'expanded-1' })
const onlyMine = atom({ plugin: 'changes-panel', key: 'onlyMine' } as const, false, { shape: 'only-mine-1' })
// Git repositories beside the current project, for linking folders.
const repos = atom({ plugin: 'changes-panel', key: 'repos' } as const, [], { shape: 'repos-1' })
// Bumped each minute while a timer runs, so its elapsed time redraws.
const minute = atom({ plugin: 'changes-panel', key: 'minute' } as const, 0, { shape: 'minute-1' })
const opStatus = atom(
  { plugin: 'changes-panel', key: 'opStatus' } as const,
  { state: 'off', message: '', syncedAt: null },
  { shape: 'op-status-1' },
)
// The running timer, for the band above the prompt.
const running = atom({ plugin: 'changes-panel', key: 'running' } as const, null, { shape: 'running-1' })
// The folder the Changes pane shows instead of the session's (hooks/register.tsx
// reads it): the linked folder of the board you opened last.
const viewing = atom({ plugin: 'changes-panel', key: 'viewing' } as const, null, { shape: 'viewing-1' })

// ---- Lanes -------------------------------------------------------------------

export const LANES: { id: Lane; title: string; color: string; target: string }[] = [
  { id: 'todo', title: 'To do', color: '#8b949e', target: 'New' },
  { id: 'doing', title: 'Doing', color: '#d29922', target: 'In progress' },
  { id: 'review', title: 'Review', color: '#8250df', target: 'In testing' },
  { id: 'done', title: 'Done', color: '#2ea043', target: 'Closed' },
]
const DOING = ['in progress', 'test failed']
const REVIEW = ['developed', 'in testing', 'tested', 'in review', 'review']

export const laneOf = (status: string, isClosed: boolean): Lane => {
  if (isClosed) return 'done'
  const name = status.toLowerCase()
  if (DOING.includes(name)) return 'doing'
  if (REVIEW.includes(name)) return 'review'
  return 'todo'
}

// ---- Small helpers -------------------------------------------------------------

export const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? path

export const formatMinutes = (minutes: number) => {
  const m = Math.max(0, Math.round(minutes))
  const h = Math.floor(m / 60)
  return h === 0 ? `${m}m` : m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`
}

// "1h 20m", "1.5h", "90m", "1:30" and a bare "45" (minutes) all read.
export const parseDuration = (text: string): number | null => {
  const t = text.trim().toLowerCase()
  if (t === '') return null
  const clock = /^(\d+):(\d{1,2})$/.exec(t)
  if (clock) return Number(clock[1]) * 60 + Number(clock[2])
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t))
  const hours = /(\d+(?:\.\d+)?)\s*h/.exec(t)
  const mins = /(\d+)\s*m/.exec(t)
  if (!hours && !mins) return null
  return Math.round((hours ? Number(hours[1]) * 60 : 0) + (mins ? Number(mins[1]) : 0))
}

// "PT1H15M" → 75
export const isoMinutes = (iso: string | null) => {
  if (!iso) return 0
  const found = /^P(?:(\d+)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+)M)?/.exec(iso)
  if (!found) return 0
  return Math.round(Number(found[1] ?? 0) * 24 * 60 + Number(found[2] ?? 0) * 60 + Number(found[3] ?? 0))
}
export const isoDuration = (minutes: number) => `PT${Math.floor(minutes / 60)}H${minutes % 60}M`

export const startOfDay = (now: number) => {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
export const startOfWeek = (now: number) => {
  const d = new Date(startOfDay(now))
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}
const localDate = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export const clockTime = (ms: number) => new Date(ms).toTimeString().slice(0, 5)

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '')

// "IATI Publisher Support" finds ~/laravel/iatipublisher: the folder whose
// name, letters and digits only, sits inside the project's title (or the
// other way round), the longest such name winning.
export const matchFolder = (title: string, folders: readonly string[]) => {
  const want = squash(title)
  let best: string | null = null
  for (const path of folders) {
    const name = squash(baseName(path))
    if (name.length < 4) continue
    if ((want.includes(name) || name.includes(want)) && (best === null || name.length > squash(baseName(best)).length)) {
      best = path
    }
  }
  return best
}

const keyOf = (item: WorkItem) => `wp:${item.id}`
const localKey = (task: LocalTask) => `local:${task.id}`

// ---- Saving ------------------------------------------------------------------

async function save($: EngineInterface, change: (log: Worklog) => Worklog) {
  await update($, worklog, change)
  await $.store.set(STORE_KEY, await read($, worklog))
}

async function setData($: EngineInterface, change: (data: OpData) => OpData) {
  await update($, opData, change)
  await $.store.set(CACHE_KEY, await read($, opData))
}

async function newId($: EngineInterface) {
  return `${(await $.clock.now()).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
}

// ---- OpenProject ---------------------------------------------------------------

type OpConfig = { url: string; apiKey: string }

async function readOpConfig($: EngineInterface): Promise<OpConfig | null> {
  const ran = await $.process.run(['sh', '-c', `cat "${OP_CONFIG}" 2>/dev/null`])
  if (ran.exitCode !== 0) return null
  try {
    const parsed = JSON.parse(ran.stdout) as Partial<OpConfig>
    if (typeof parsed.url !== 'string' || typeof parsed.apiKey !== 'string') return null
    return { url: parsed.url.replace(/\/+$/, ''), apiKey: parsed.apiKey }
  } catch {
    return null
  }
}

// One request: the key goes as basic auth, never in the URL. Rejects with
// OpenProject's own message when it refuses.
async function op($: EngineInterface, config: OpConfig, path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const response = await $.http.fetch(`${config.url}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${btoa(`apikey:${config.apiKey}`)}`,
      Accept: 'application/hal+json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let parsed: unknown = null
  try {
    parsed = JSON.parse(response.text)
  } catch {
    parsed = null
  }
  if (!response.ok) {
    const message =
      typeof parsed === 'object' && parsed !== null && 'message' in parsed && typeof parsed.message === 'string'
        ? parsed.message
        : `OpenProject answered ${response.status}`
    throw new Error(message)
  }
  return parsed
}

type HalElement = {
  id: number
  subject: string
  spentTime?: string | null
  lockVersion: number
  _links: {
    project: { href: string; title: string }
    status: { href: string; title: string }
    type: { title: string }
    assignee?: { href: string | null; title?: string }
  }
}

const idOf = (href: unknown) => (typeof href === 'string' ? href.split('/').pop() ?? '' : '')

const toItem = (wp: HalElement, me: string | null, url: string): WorkItem => {
  const assigneeId = idOf(wp._links.assignee?.href ?? null)
  return {
    id: wp.id,
    projectId: idOf(wp._links.project.href),
    subject: wp.subject,
    statusId: idOf(wp._links.status.href),
    status: wp._links.status.title,
    type: wp._links.type.title,
    assignee: wp._links.assignee?.title ?? null,
    isMine: me !== null && assigneeId === me,
    spent: wp.spentTime ?? null,
    lockVersion: wp.lockVersion,
    url: `${url}/work_packages/${wp.id}`,
  }
}

const filterParam = (filters: unknown) => encodeURIComponent(JSON.stringify(filters))

async function findRepos($: EngineInterface) {
  const cwd = await $.session.cwd()
  const top = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'])
  const here = top.exitCode === 0 ? top.stdout.trim() : cwd
  const parent = here.slice(0, here.lastIndexOf('/')) || '/'
  const found = await $.process.run(['find', parent, '-mindepth', '2', '-maxdepth', '2', '-name', '.git', '-type', 'd'])
  const list = found.stdout
    .split('\n')
    .map(line => line.replace(/\/\.git$/, ''))
    .filter(Boolean)
    .sort()
  await update($, repos, () => list)
}

// Your projects (the ones you are a member of), the statuses, and each
// project's open work plus what closed in the last fortnight.
async function syncOpenProject($: EngineInterface) {
  const config = await readOpConfig($)
  if (!config) {
    await update($, opStatus, (): OpStatus => ({ state: 'off', message: '', syncedAt: null }))
    return
  }
  await update($, opStatus, (current): OpStatus => ({ ...current, state: 'syncing' }))
  try {
    const user = (await op($, config, '/api/v3/users/me')) as { id: number }
    const me = String(user.id)
    const memberships = (await op(
      $,
      config,
      `/api/v3/memberships?filters=${filterParam([{ principal: { operator: '=', values: [me] } }])}&pageSize=200`,
    )) as { _embedded?: { elements?: { _links: { project: { href: string; title: string } } }[] } }
    const projects = (memberships._embedded?.elements ?? []).map(m => ({
      id: idOf(m._links.project.href),
      title: m._links.project.title,
    }))
    const statusList = (await op($, config, '/api/v3/statuses')) as {
      _embedded?: { elements?: { id: number; name: string; isClosed: boolean }[] }
    }
    const statuses: OpStatusDef[] = (statusList._embedded?.elements ?? []).map(s => ({
      id: String(s.id),
      name: s.name,
      isClosed: s.isClosed,
    }))
    const items: WorkItem[] = []
    for (const project of projects) {
      for (const filters of [
        [{ status: { operator: 'o', values: [] } }],
        [{ status: { operator: 'c', values: [] } }, { updatedAt: { operator: '>t-', values: ['14'] } }],
      ]) {
        const found = (await op(
          $,
          config,
          `/api/v3/projects/${project.id}/work_packages?filters=${filterParam(filters)}&pageSize=200`,
        )) as { _embedded?: { elements?: HalElement[] } }
        for (const wp of found._embedded?.elements ?? []) items.push(toItem(wp, me, config.url))
      }
    }
    await setData($, () => ({ me, projects, statuses, items }))

    // Link each new project to the folder whose name matches it.
    const folders = await read($, repos)
    await save($, log => {
      const links = { ...log.links }
      for (const project of projects) {
        if (!(project.id in links)) links[project.id] = matchFolder(project.title, folders)
      }
      return { ...log, links }
    })
    const mine = items.filter(i => i.isMine && !statuses.find(s => s.id === i.statusId)?.isClosed).length
    const syncedAt = await $.clock.now()
    await update($, opStatus, (): OpStatus => ({
      state: 'ok',
      message: `${mine} open and assigned to you`,
      syncedAt,
    }))
  } catch (err) {
    await update($, opStatus, (current): OpStatus => ({
      ...current,
      state: 'error',
      message: err instanceof Error ? err.message : String(err),
    }))
  }
}

async function replaceItem($: EngineInterface, item: WorkItem) {
  await setData($, data => ({ ...data, items: data.items.map(i => (i.id === item.id ? item : i)) }))
}

// Sets a work package's status in OpenProject.
async function setStatus($: EngineInterface, item: WorkItem, statusId: string) {
  const config = await readOpConfig($)
  if (!config) return
  const data = await read($, opData)
  const name = data.statuses.find(s => s.id === statusId)?.name ?? statusId
  try {
    const updated = (await op($, config, `/api/v3/work_packages/${item.id}`, 'PATCH', {
      lockVersion: item.lockVersion,
      _links: { status: { href: `/api/v3/statuses/${statusId}` } },
    })) as HalElement
    await replaceItem($, toItem(updated, data.me, config.url))
    $.ui.toast(`#${item.id} moved to ${name}.`)
  } catch (err) {
    $.ui.toast(`Could not move #${item.id}: ${err instanceof Error ? err.message : String(err)}`)
    // Someone else may have changed it: fetch it again so the next move works.
    try {
      const fresh = (await op($, config, `/api/v3/work_packages/${item.id}`)) as HalElement
      await replaceItem($, toItem(fresh, data.me, config.url))
    } catch {
      // Keep what is shown.
    }
  }
}

async function moveItem($: EngineInterface, item: WorkItem, lane: Lane) {
  const data = await read($, opData)
  const target = LANES.find(l => l.id === lane)?.target.toLowerCase()
  const status =
    data.statuses.find(s => s.name.toLowerCase() === target) ??
    data.statuses.find(s => laneOf(s.name, s.isClosed) === lane)
  if (status) await setStatus($, item, status.id)
}

async function loadActivities($: EngineInterface, item: WorkItem): Promise<Activity[]> {
  const config = await readOpConfig($)
  if (!config) return []
  const form = (await op($, config, '/api/v3/time_entries/form', 'POST', {
    _links: { workPackage: { href: `/api/v3/work_packages/${item.id}` } },
  })) as {
    _embedded?: { schema?: { activity?: { _embedded?: { allowedValues?: { id: number; name: string }[] } } } }
  }
  return (form._embedded?.schema?.activity?._embedded?.allowedValues ?? []).map(a => ({
    id: String(a.id),
    name: a.name,
  }))
}

// Books time on a work package in OpenProject.
async function bookTime($: EngineInterface, item: WorkItem, minutes: number, activityId: string | null) {
  const config = await readOpConfig($)
  if (!config) return false
  try {
    await op($, config, '/api/v3/time_entries', 'POST', {
      hours: isoDuration(minutes),
      spentOn: localDate(await $.clock.now()),
      comment: { raw: '' },
      _links: {
        workPackage: { href: `/api/v3/work_packages/${item.id}` },
        ...(activityId ? { activity: { href: `/api/v3/time_entries/activities/${activityId}` } } : {}),
      },
    })
    const data = await read($, opData)
    const fresh = (await op($, config, `/api/v3/work_packages/${item.id}`)) as HalElement
    await replaceItem($, toItem(fresh, data.me, config.url))
    return true
  } catch (err) {
    $.ui.toast(`Could not book time on #${item.id}: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

// ---- Claude Code sessions -----------------------------------------------------

export async function startSession(
  $: EngineInterface,
  folder: string,
  title: string,
  task: string | null,
  source = 'OpenProject',
) {
  const prompt = task
    ? `${task}\n\nThis is tracked on the board in the ${source} pane, and its timer is running.`
    : `I opened this project from the ${source} pane. Say hello in one line, then wait for my instructions.`
  const background =
    `The user started this session from the ${source} pane of their changes-panel mod, which shows their ` +
    `${source} work. Project folder: ${folder}.` +
    (task ? ' Work on the task in the prompt; ask before anything large or destructive.' : ' There is no task yet.')
  try {
    const ran = await $.mcp.call('ccd_session', 'start_session', {
      initiation: 'user_asked',
      title: title.slice(0, 59),
      prompt,
      background,
      cwd: folder,
      use_worktree: false,
    })
    $.ui.toast(ran.isError ? 'Could not start a session: the app refused.' : `Started a session in ${baseName(folder)}.`)
    return !ran.isError
  } catch (err) {
    $.ui.toast(`Could not start a session: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

// ---- Timers and time ----------------------------------------------------------

async function refreshRunning($: EngineInterface) {
  const log = await read($, worklog)
  const data = await read($, opData)
  const entry = Object.entries(log.timers)[0]
  if (!entry) {
    await update($, running, () => null)
    return
  }
  const [key, startedAt] = entry
  const label = key.startsWith('wp:')
    ? `#${key.slice(3)} ${data.items.find(i => keyOf(i) === key)?.subject ?? ''}`.trim()
    : (log.local.find(t => localKey(t) === key)?.title ?? 'Task')
  await update($, running, () => ({ label, startedAt }))
}

// One timer at a time: starting one stops any other, keeping its time for logging.
async function startTimer($: EngineInterface, key: string) {
  const now = await $.clock.now()
  const log = await read($, worklog)
  for (const other of Object.keys(log.timers)) if (other !== key) await stopTimer($, other)
  await save($, l => ({ ...l, timers: { ...l.timers, [key]: l.timers[key] ?? now } }))
  await refreshRunning($)
}

// Stopping opens the card's time form with the timer's minutes in it.
async function stopTimer($: EngineInterface, key: string) {
  const now = await $.clock.now()
  const log = await read($, worklog)
  const since = log.timers[key]
  if (since === undefined) return
  await save($, l => {
    const timers = { ...l.timers }
    delete timers[key]
    return { ...l, timers }
  })
  await refreshRunning($)
  const minutes = Math.max(1, Math.round((now - since) / MINUTE))
  await openForm($, key, minutes, `From your timer, started at ${clockTime(since)}.`)
}

// Estimates the time spent from your commits in the project's folder since you
// last logged time on this card (or since today began), as the git-hours method
// does: gaps of up to two hours count as work, plus half an hour before each run.
async function estimateFromGit($: EngineInterface, key: string, folder: string | null) {
  const log = await read($, worklog)
  const last = log.entries.filter(e => e.key === key).reduce((max, e) => Math.max(max, e.at), 0)
  return commitEstimate($, folder, last)
}

// The git-hours estimate of your commits in a folder since `last` (or since
// today began, whichever is later). Shared with the GitLab pane.
export async function commitEstimate($: EngineInterface, folder: string | null, last: number) {
  if (!folder) return { minutes: null, reason: 'Link this project to a folder to get an estimate from your commits.' }
  const now = await $.clock.now()
  const since = Math.max(last, startOfDay(now))
  const email = await $.process.run(['git', '-C', folder, 'config', 'user.email'])
  const args = ['git', '-C', folder, 'log', '--all', `--since=@${Math.floor(since / 1000)}`, '--format=%ct']
  if (email.exitCode === 0 && email.stdout.trim() !== '') args.push(`--author=${email.stdout.trim()}`)
  const times = (await $.process.run(args)).stdout
    .split('\n')
    .map(Number)
    .filter(n => n > 0)
    .sort((a, b) => a - b)
  if (times.length === 0) {
    return { minutes: null, reason: 'No commits of yours here since you last logged time, so no estimate: enter the time.' }
  }
  const MAX_GAP = 2 * 60 * 60
  const FIRST = 30 * 60
  let seconds = FIRST
  for (let i = 1; i < times.length; i++) {
    const gap = (times[i] ?? 0) - (times[i - 1] ?? 0)
    seconds += gap <= MAX_GAP ? gap : FIRST
  }
  return {
    minutes: Math.round(seconds / 60),
    reason: `Estimated from ${times.length} commit${times.length === 1 ? '' : 's'} of yours between ${clockTime((times[0] ?? 0) * 1000)} and ${clockTime((times[times.length - 1] ?? 0) * 1000)}.`,
  }
}

async function openForm($: EngineInterface, key: string, minutes: number | null, reason: string) {
  const data = await read($, opData)
  const item = key.startsWith('wp:') ? data.items.find(i => keyOf(i) === key) : undefined
  await update($, logForm, () => ({ key, minutes, reason, activities: [], activityId: null }))
  if (!item) return
  try {
    const activities = await loadActivities($, item)
    const project = data.projects.find(p => p.id === item.projectId)
    const preferred = /support/i.test(project?.title ?? '') ? 'support' : 'development'
    const pick = activities.find(a => a.name.toLowerCase() === preferred) ?? activities[0]
    await update($, logForm, form => (form?.key === key ? { ...form, activities, activityId: pick?.id ?? null } : form))
  } catch {
    // Book without an activity; OpenProject uses its default.
  }
}

async function openLog($: EngineInterface, key: string, folder: string | null) {
  const log = await read($, worklog)
  if (log.timers[key] !== undefined) {
    await stopTimer($, key)
    return
  }
  await openForm($, key, null, 'Estimating…')
  const estimate = await estimateFromGit($, key, folder)
  await update($, logForm, form => (form?.key === key ? { ...form, ...estimate } : form))
}

async function logTime($: EngineInterface, key: string, minutes: number) {
  const form = await read($, logForm)
  const data = await read($, opData)
  const item = key.startsWith('wp:') ? data.items.find(i => keyOf(i) === key) : undefined
  const booked = item ? await bookTime($, item, minutes, form?.activityId ?? null) : false
  if (item && !booked) return
  const at = await $.clock.now()
  await save($, l => ({ ...l, entries: [...l.entries, { key, minutes, at, booked }] }))
  await update($, logForm, () => null)
  $.ui.toast(item ? `Booked ${formatMinutes(minutes)} on #${item.id} in OpenProject.` : `Logged ${formatMinutes(minutes)}.`)
}

async function addLocalTask($: EngineInterface, projectId: string, title: string, createdBy: 'you' | 'claude') {
  const clean = title.trim()
  if (clean === '') return null
  const task: LocalTask = { id: await newId($), projectId, title: clean, lane: 'todo', createdBy, createdAt: await $.clock.now() }
  await save($, log => ({ ...log, local: [...log.local, task] }))
  return task
}

// ---- Session start (called from the module's one session.start hook) --------------

export async function startWorklog($: EngineInterface) {
  await $.command.register({ name: 'open-project', description: 'Open the OpenProject pane: your OpenProject boards and time' })
  await $.tool.register({
    name: 'create_task',
    description:
      "Adds a task of the user's own to one of their projects on the OpenProject pane's board (kept in the pane, " +
      'not sent to OpenProject). Use it when the user asks you to add or note down a task. `project` is the ' +
      'OpenProject project title (e.g. "IATI Publisher Support").',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project title as OpenProject shows it' },
        title: { type: 'string', description: 'Short task title, as the user would write it' },
      },
      required: ['project', 'title'],
    },
  })
  await $.tool.register({
    name: 'list_tasks',
    description:
      "Lists the user's OpenProject projects with each one's work packages by board column (To do, Doing, " +
      'Review, Done), who has them and the time booked, plus their own tasks, so you can say what they are working on.',
    inputSchema: { type: 'object', properties: {} },
  })

  const stored = await $.store.get(STORE_KEY)
  if (typeof stored === 'object' && stored !== null && 'timers' in stored) await update($, worklog, () => stored as Worklog)
  const cache = await $.store.get(CACHE_KEY)
  if (typeof cache === 'object' && cache !== null && 'items' in cache) await update($, opData, () => cache as OpData)
  await refreshRunning($)
  await findRepos($).catch(() => undefined)
  void syncOpenProject($).catch(() => undefined)
  $.clock.every(OP_SYNC_EVERY, () => syncOpenProject($).catch(() => undefined))
  $.clock.every(MINUTE, async () => {
    if (Object.keys((await read($, worklog)).timers).length > 0) await update($, minute, n => n + 1)
  })
}

// ---- Drawing helpers ---------------------------------------------------------------

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? '')
    .join('')

const hue = (name: string) => [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)

export const avatarSvg = (name: string | null) => {
  const text = name ? initials(name) : '–'
  const fill = name ? `hsl(${hue(name)} 45% 45%)` : '#8b949e'
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">` +
    `<circle cx="10" cy="10" r="9.5" fill="${fill}"/>` +
    `<text x="10" y="13.6" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8.5" font-weight="700" fill="#fff">${text}</text></svg>`
  )
}

export const laneDotSvg = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="${color}"/></svg>`

// How a project's work splits across the four columns.
const laneStripSvg = (counts: number[], width = 220) => {
  const total = counts.reduce((a, b) => a + b, 0)
  let x = 0
  const segs = counts
    .map((n, i) => {
      if (n === 0 || total === 0) return ''
      const w = (width * n) / total
      const seg = `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="8" fill="${LANES[i]?.color ?? '#888'}"/>`
      x += w
      return seg
    })
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="8" viewBox="0 0 ${width} 8">` +
    `<defs><clipPath id="s"><rect width="${width}" height="8" rx="4"/></clipPath></defs>` +
    `<rect width="${width}" height="8" rx="4" fill="#8b949e" opacity="0.18"/><g clip-path="url(#s)">${segs}</g></svg>`
  )
}

// ---- Hooks ---------------------------------------------------------------------------

export const registerWorklog = (on: On) => {
  on('command.run', { command: 'open-project' }, async $ => {
    await $.ui.open({ id: PROJECTS_PANE, title: PROJECTS_TITLE })
    void syncOpenProject($).catch(() => undefined)
    return { text: 'OpenProject pane opened.' }
  })

  on('tool.run', { tool: 'mcp__changes-panel__create_task' }, async ($, e) => {
    const input = e as unknown as { project?: string; title?: string }
    const data = await read($, opData)
    const wanted = (input.project ?? '').trim().toLowerCase()
    const project =
      data.projects.find(p => p.title.toLowerCase() === wanted) ??
      data.projects.find(p => p.title.toLowerCase().includes(wanted) && wanted !== '')
    if (!project) {
      const names = data.projects.map(p => p.title).join(', ') || 'none synced yet'
      return { result: `No project called "${input.project ?? ''}". Projects: ${names}.` }
    }
    const task = await addLocalTask($, project.id, input.title ?? '', 'claude')
    return { result: task ? `Added "${task.title}" to ${project.title}'s board (To do).` : 'The task needs a title.' }
  })

  on('tool.run', { tool: 'mcp__changes-panel__list_tasks' }, async $ => {
    const data = await read($, opData)
    const log = await read($, worklog)
    if (data.projects.length === 0) return { result: 'No OpenProject projects synced yet.' }
    const lines = data.projects.map(p => {
      const rows = LANES.map(lane => {
        const items = data.items.filter(
          i => i.projectId === p.id && laneOf(i.status, data.statuses.find(s => s.id === i.statusId)?.isClosed ?? false) === lane.id,
        )
        const local = log.local.filter(t => t.projectId === p.id && t.lane === lane.id)
        const all = [
          ...items.map(
            i => `#${i.id} ${i.subject} [${i.status}${i.assignee ? `, ${i.assignee}${i.isMine ? ' (you)' : ''}` : ', unassigned'}, ${formatMinutes(isoMinutes(i.spent))} booked]`,
          ),
          ...local.map(t => `${t.title} [your own task]`),
        ]
        return all.length > 0 ? `  ${lane.title}:\n${all.map(a => `    - ${a}`).join('\n')}` : ''
      }).filter(Boolean)
      return [`${p.title}`, ...rows].join('\n')
    })
    return { result: lines.join('\n') }
  })

  on('ui.render', { component: 'Pane', requestId: PROJECTS_PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Input, Select, Link } = ui
    const Svg = 'Svg' in ui ? ui.Svg : null
    const log = await read($, worklog)
    const data = await read($, opData)
    const at = await read($, page)
    const form = await read($, logForm)
    const open = await read($, expanded)
    const mineOnly = await read($, onlyMine)
    const folders = await read($, repos)
    const sync = await read($, opStatus)
    await read($, minute)
    const now = await $.clock.now()

    const timerKey = Object.keys(log.timers)[0] ?? null
    const elapsed = (key: string) => {
      const since = log.timers[key]
      return since === undefined ? 0 : Math.max(0, Math.round((now - since) / MINUTE))
    }
    const minutesSince = (since: number, keys?: Set<string>) =>
      log.entries.filter(en => en.at >= since && (!keys || keys.has(en.key))).reduce((s, en) => s + en.minutes, 0)
    const isClosed = (item: WorkItem) => data.statuses.find(s => s.id === item.statusId)?.isClosed ?? false
    const laneOfItem = (item: WorkItem) => laneOf(item.status, isClosed(item))

    if (e.props.placement === 'widget') {
      return timerKey ? (
        <Text>
          <Text color="success">●</Text> {formatMinutes(elapsed(timerKey))}
        </Text>
      ) : (
        <Text dimColor>No timer running</Text>
      )
    }

    const project = at.name === 'board' ? data.projects.find(p => p.id === at.projectId) : undefined
    const go = (next: Page) => async () => {
      if (next.name === 'board') {
        const linked = (await read($, worklog)).links[next.projectId]
        if (linked) await update($, viewing, () => linked)
      }
      await update($, page, () => next)
      await update($, logForm, () => null)
      await update($, expanded, () => null)
    }

    // ---- Top bar: where you are, your time, sync and the running timer
    const topBar = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} flexWrap="wrap">
          <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1} minWidth={0}>
            {project && (
              <Button key="crumb-projects" plain dimColor onPress={go({ name: 'projects' })}>
                ← Projects
              </Button>
            )}
            <Text bold size="heading" wrap="truncate-end">
              {project ? project.title : 'OpenProject'}
            </Text>
          </Box>
          <Text dimColor tabular>
            Today {formatMinutes(minutesSince(startOfDay(now)))} · Week {formatMinutes(minutesSince(startOfWeek(now)))}
          </Text>
        </Box>
        <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
          {timerKey && (
            <Box flexDirection="row" alignItems="center" gap={1} borderStyle="round" borderColor="success" paddingX={1}>
              <Text color="success">●</Text>
              <Text wrap="truncate-end">
                {timerKey.startsWith('wp:')
                  ? `#${timerKey.slice(3)}`
                  : (log.local.find(t => localKey(t) === timerKey)?.title ?? 'Task')}
              </Text>
              <Text tabular color="success">
                {formatMinutes(elapsed(timerKey))}
              </Text>
              <Button key="top-stop" plain onPress={() => stopTimer($, timerKey)}>
                ■ Stop
              </Button>
            </Box>
          )}
          <Text dimColor color={sync.state === 'error' ? 'error' : undefined} wrap="truncate-end">
            {sync.state === 'off'
              ? 'OpenProject is not connected: add ~/.config/changes-panel/openproject.json.'
              : sync.state === 'syncing'
                ? 'Syncing with OpenProject…'
                : sync.state === 'error'
                  ? `Could not sync: ${sync.message}`
                  : `${sync.message}${sync.syncedAt ? ` · synced ${clockTime(sync.syncedAt)}` : ''}`}
          </Text>
          {sync.state !== 'off' && (
            <Button key="op-sync" plain dimColor onPress={() => syncOpenProject($)}>
              Sync
            </Button>
          )}
        </Box>
      </Box>
    )

    // ---- Projects page: a card per OpenProject project you are a member of
    if (!project) {
      const cards = data.projects.map(p => {
        const items = data.items.filter(i => i.projectId === p.id)
        const local = log.local.filter(t => t.projectId === p.id)
        const counts = LANES.map(
          lane => items.filter(i => laneOfItem(i) === lane.id).length + local.filter(t => t.lane === lane.id).length,
        )
        const openCount = items.filter(i => !isClosed(i)).length
        const mine = items.filter(i => i.isMine && !isClosed(i)).length
        const keys = new Set([...items.map(keyOf), ...local.map(localKey)])
        const folder = log.links[p.id] ?? null
        return (
          <Box key={`project:${p.id}`} flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={2} paddingY={1} minWidth={30} flexGrow={1}>
            <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
              <Button key={`board:${p.id}`} plain onPress={go({ name: 'board', projectId: p.id })}>
                <Text bold size="heading" wrap="truncate-end">
                  {p.title}
                </Text>
              </Button>
              <Text dimColor tabular>
                {formatMinutes(minutesSince(startOfWeek(now), keys))} this week
              </Text>
            </Box>
            <Text>
              <Text bold>{openCount}</Text>
              <Text dimColor> open · </Text>
              <Text bold color="suggestion">
                {mine}
              </Text>
              <Text dimColor> yours</Text>
            </Text>
            {Svg && <Svg source={laneStripSvg(counts)} alt="Work by column" />}
            <Box flexDirection="row" gap={2} flexWrap="wrap">
              {LANES.map((lane, i) => (
                <Text>
                  <Text color={lane.color}>●</Text> <Text dimColor>{lane.title}</Text> <Text tabular>{counts[i]}</Text>
                </Text>
              ))}
            </Box>
            <Select
              key={`folder:${p.id}`}
              label="Folder"
              value={folder ?? ''}
              options={[{ value: '', label: 'Not linked' }, ...folders.map(f => ({ value: f, label: baseName(f) }))]}
              onSelect={async value => {
                const was = (await read($, worklog)).links[p.id] ?? null
                await save($, l => ({ ...l, links: { ...l.links, [p.id]: value === '' ? null : value } }))
                // The Changes pane showing this project's folder moves with it.
                if (was !== null && (await read($, viewing)) === was) await update($, viewing, () => (value === '' ? null : value))
              }}
            />
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Button key={`open-board:${p.id}`} variant="primary" onPress={go({ name: 'board', projectId: p.id })}>
                Open board
              </Button>
              {folder && (
                <Button key={`open-claude:${p.id}`} onPress={() => startSession($, folder, `Work on ${p.title}`, null)}>
                  Open in Claude Code
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
                {sync.state === 'off'
                  ? 'Connect OpenProject to see your projects here.'
                  : 'No OpenProject projects yet. You see the ones you are a member of.'}
              </Text>
            </Box>
          ) : (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {cards}
            </Box>
          )}
        </Box>
      )
    }

    // ---- Board page
    const folder = log.links[project.id] ?? null
    const items = data.items.filter(i => i.projectId === project.id && (!mineOnly || i.isMine))
    const local = log.local.filter(t => t.projectId === project.id)

    const timeForm = (key: string, label: string) =>
      form?.key === key && (
        <Box flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={1}>
          <Text dimColor>{form.reason}</Text>
          <Input
            key={`time:${key}`}
            label="Time"
            placeholder="1h 20m, 90m or 1:30"
            value={form.minutes === null ? '' : formatMinutes(form.minutes)}
            submitLabel={key.startsWith('wp:') ? 'book' : 'log'}
            autoFocus
            onSubmit={async value => {
              const minutes = parseDuration(value)
              if (minutes === null || minutes <= 0) {
                $.ui.toast('Enter a time like 1h 20m, 90m or 1:30.')
                return
              }
              await logTime($, key, minutes)
            }}
          />
          {form.activities.length > 0 && (
            <Select
              key={`activity:${key}`}
              label="Activity"
              value={form.activityId ?? ''}
              options={form.activities.map(a => ({ value: a.id, label: a.name }))}
              onSelect={value => update($, logForm, f => (f ? { ...f, activityId: value } : f))}
            />
          )}
          <Box flexDirection="row" gap={1}>
            {form.minutes !== null && (
              <Button
                key={`book:${key}`}
                variant="primary"
                onPress={() => (form.minutes === null ? undefined : logTime($, key, form.minutes))}
              >
                {`${key.startsWith('wp:') ? 'Book' : 'Log'} ${formatMinutes(form.minutes)}${label}`}
              </Button>
            )}
            <Button key={`cancel:${key}`} plain dimColor onPress={() => update($, logForm, () => null)}>
              Cancel
            </Button>
          </Box>
        </Box>
      )

    const timerButton = (key: string) =>
      log.timers[key] !== undefined ? (
        <Button key={`stop:${key}`} variant="primary" onPress={() => stopTimer($, key)}>
          {`■ ${formatMinutes(elapsed(key))}`}
        </Button>
      ) : (
        <Button key={`start:${key}`} onPress={() => startTimer($, key)}>
          ▶ Timer
        </Button>
      )

    const laneIndex = (lane: Lane) => LANES.findIndex(l => l.id === lane)

    const itemCard = (item: WorkItem) => {
      const key = keyOf(item)
      const lane = laneOfItem(item)
      const color = LANES[laneIndex(lane)]?.color ?? '#8b949e'
      const left = LANES[laneIndex(lane) - 1]
      const right = LANES[laneIndex(lane) + 1]
      const isOpen = open === key
      return (
        <Box key={`card:${key}`} flexDirection="column" gap={1} borderStyle="round" borderColor={color} paddingX={1}>
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Text mono color="suggestion">
              #{item.id}
            </Text>
            <Text dimColor size="caption">
              {item.type} · {item.status}
            </Text>
          </Box>
          <Text bold={item.isMine}>{item.subject}</Text>
          <Box flexDirection="row" alignItems="center" gap={1}>
            {Svg && <Svg source={avatarSvg(item.assignee)} alt={item.assignee ?? 'Unassigned'} />}
            <Text dimColor wrap="truncate-end">
              {item.assignee ? (item.isMine ? 'You' : item.assignee) : 'Unassigned'}
            </Text>
            <Box flexGrow={1} />
            <Text dimColor tabular>
              {formatMinutes(isoMinutes(item.spent))} booked
            </Text>
          </Box>
          <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
            {left && (
              <Button key={`left:${key}`} plain onPress={() => moveItem($, item, left.id)}>
                {`◀ ${left.title}`}
              </Button>
            )}
            {right && (
              <Button key={`right:${key}`} plain onPress={() => moveItem($, item, right.id)}>
                {`${right.title} ▶`}
              </Button>
            )}
            <Box flexGrow={1} />
            {timerButton(key)}
            <Button key={`log:${key}`} onPress={() => openLog($, key, folder)}>
              Log time
            </Button>
            <Button key={`more:${key}`} plain dimColor onPress={() => update($, expanded, cur => (cur === key ? null : key))}>
              {isOpen ? '⌃' : '⋯'}
            </Button>
          </Box>
          {isOpen && (
            <Box flexDirection="column" gap={1}>
              <Select
                key={`status:${key}`}
                label="Status"
                value={item.statusId}
                options={data.statuses.map(s => ({ value: s.id, label: s.name }))}
                onSelect={value => (value === item.statusId ? undefined : setStatus($, item, value))}
              />
              <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
                <Link href={item.url} label="Open in OpenProject" />
                {folder && (
                  <Button
                    key={`claude:${key}`}
                    plain
                    onPress={async () => {
                      if (await startSession($, folder, `#${item.id} ${item.subject}`, `Work package #${item.id}: ${item.subject}\n${item.url}`)) {
                        await startTimer($, key)
                      }
                    }}
                  >
                    Start in Claude Code
                  </Button>
                )}
              </Box>
            </Box>
          )}
          {timeForm(key, ` on #${item.id}`)}
        </Box>
      )
    }

    const localCard = (task: LocalTask) => {
      const key = localKey(task)
      const color = LANES[laneIndex(task.lane)]?.color ?? '#8b949e'
      const left = LANES[laneIndex(task.lane) - 1]
      const right = LANES[laneIndex(task.lane) + 1]
      const move = (lane: Lane) => () =>
        save($, l => ({ ...l, local: l.local.map(t => (t.id === task.id ? { ...t, lane } : t)) }))
      return (
        <Box key={`card:${key}`} flexDirection="column" gap={1} borderStyle="round" borderColor={color} borderDimColor paddingX={1}>
          <Text dimColor size="caption">
            Your own task{task.createdBy === 'claude' ? ' · added by Claude' : ''}
          </Text>
          <Text>{task.title}</Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
            {left && (
              <Button key={`left:${key}`} plain onPress={move(left.id)}>
                {`◀ ${left.title}`}
              </Button>
            )}
            {right && (
              <Button key={`right:${key}`} plain onPress={move(right.id)}>
                {`${right.title} ▶`}
              </Button>
            )}
            <Box flexGrow={1} />
            {timerButton(key)}
            <Button key={`log:${key}`} onPress={() => openLog($, key, folder)}>
              Log time
            </Button>
            <Button
              key={`remove:${key}`}
              plain
              dimColor
              onPress={() => save($, l => ({ ...l, local: l.local.filter(t => t.id !== task.id) }))}
            >
              Remove
            </Button>
          </Box>
          {timeForm(key, '')}
        </Box>
      )
    }

    const columns = LANES.map(lane => {
      const inLane = items.filter(i => laneOfItem(i) === lane.id)
      const own = local.filter(t => t.lane === lane.id)
      return (
        <Box key={`lane:${lane.id}`} flexDirection="column" gap={1} minWidth={28} flexGrow={1}>
          <Box flexDirection="row" alignItems="center" gap={1}>
            {Svg ? <Svg source={laneDotSvg(lane.color)} alt="" /> : <Text color={lane.color}>●</Text>}
            <Text bold>{lane.title}</Text>
            <Text dimColor tabular>
              {inLane.length + own.length}
            </Text>
          </Box>
          {inLane.map(itemCard)}
          {own.map(localCard)}
          {inLane.length + own.length === 0 && (
            <Box borderStyle="round" borderDimColor paddingX={1}>
              <Text dimColor size="caption">
                {lane.id === 'done' ? 'Nothing closed in the last two weeks.' : 'Nothing here.'}
              </Text>
            </Box>
          )}
        </Box>
      )
    })

    return (
      <Box flexDirection="column" gap={1}>
        {topBar}
        <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
          <Button key="filter-all" variant={mineOnly ? 'secondary' : 'primary'} onPress={() => update($, onlyMine, () => false)}>
            All
          </Button>
          <Button key="filter-mine" variant={mineOnly ? 'primary' : 'secondary'} onPress={() => update($, onlyMine, () => true)}>
            Mine
          </Button>
          <Box flexGrow={1} />
          {folder && (
            <Button key="board-claude" plain dimColor onPress={() => startSession($, folder, `Work on ${project.title}`, null)}>
              Open in Claude Code
            </Button>
          )}
        </Box>
        <Box flexDirection="row" gap={2} flexWrap="wrap" alignItems="flex-start">
          {columns}
        </Box>
        <Input
          key={`new:${project.id}`}
          placeholder={`Add a task of your own to ${project.title}`}
          value=""
          submitLabel="add"
          onSubmit={value => addLocalTask($, project.id, value, 'you')}
        />
      </Box>
    )
  })
}
