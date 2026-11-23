import { expect, test } from 'claude-code/testing'

import { formatMinutes, isoDuration, isoMinutes, laneOf, matchFolder, parseDuration } from './worklog'

const PROJECTS = {
  plugin: 'changes-panel',
  component: 'Pane',
  requestId: 'changes-panel-projects',
  props: {
    title: 'Projects',
    isFocused: false,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
} as const

const ok = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

test('times, columns and folders read the way people expect', () => {
  expect(parseDuration('1h 20m')).toBe(80)
  expect(parseDuration('1.5h')).toBe(90)
  expect(parseDuration('1:30')).toBe(90)
  expect(parseDuration('45')).toBe(45)
  expect(parseDuration('soon')).toBeNull()
  expect(formatMinutes(80)).toBe('1h 20m')
  expect(isoMinutes('PT1H15M')).toBe(75)
  expect(isoDuration(25)).toBe('PT0H25M')
  expect(laneOf('New', false)).toBe('todo')
  expect(laneOf('In progress', false)).toBe('doing')
  expect(laneOf('In testing', false)).toBe('review')
  expect(laneOf('Rejected', true)).toBe('done')
  expect(matchFolder('IATI Publisher Support', ['/l/agri-ims', '/l/iatipublisher'])).toBe('/l/iatipublisher')
  expect(matchFolder('Internal Ops', ['/l/agri-ims'])).toBeNull()
})

const STATUSES = [
  { id: 1, name: 'New', isClosed: false },
  { id: 7, name: 'In progress', isClosed: false },
  { id: 9, name: 'In testing', isClosed: false },
  { id: 12, name: 'Closed', isClosed: true },
]
const wp = (id: number, subject: string, status: number, assignee: number | null, lockVersion = 1, spent = 'PT1H15M') => ({
  id,
  subject,
  spentTime: spent,
  lockVersion,
  _links: {
    project: { href: '/api/v3/projects/45', title: 'IATI Publisher Support' },
    status: { href: `/api/v3/statuses/${status}`, title: STATUSES.find(s => s.id === status)?.name },
    type: { title: 'Task' },
    assignee: assignee === null ? { href: null } : { href: `/api/v3/users/${assignee}`, title: assignee === 54 ? 'Ashesh Shakya' : 'Sita Rai' },
  },
})

test('projects, the board, moving a card and booking time', async ($, on) => {
  let now = Date.UTC(2026, 10, 23, 4, 0)
  const stored: Record<string, unknown> = {}
  const sent: { method: string; path: string; body?: unknown; auth: string }[] = []
  let mine = wp(411, 'Check the XLSX download', 1, 54)

  on('clock.now', () => ({ value: now }))
  on('clock.every', () => ({ value: undefined }))
  on('store.get', (_, e) => ({ value: stored[(e as { key: string }).key] }))
  on('store.set', (_, e) => {
    const { key, value } = e as { key: string; value: unknown }
    stored[key] = value
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'x' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__changes-panel__x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/home/me/laravel/infrastructure-monitoring' }))
  on('session.repo', () => ({ value: null }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const argv = e.argv.join(' ')
    if (argv.includes('openproject.json')) return ok(JSON.stringify({ url: 'https://pm.example.test', apiKey: 'opapi-test' }))
    if (argv.includes('rev-parse --show-toplevel')) return ok('/home/me/laravel/infrastructure-monitoring\n')
    if (argv.startsWith('find')) {
      return ok('/home/me/laravel/iatipublisher/.git\n/home/me/laravel/infrastructure-monitoring/.git\n')
    }
    return ok('', 1)
  })
  on('http.fetch', (_, e) => {
    const { url, init } = e as { url: string; init?: { method?: string; body?: string; headers?: Record<string, string> } }
    const path = url.replace('https://pm.example.test', '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    sent.push({ method, path, body, auth: init?.headers?.Authorization ?? '' })
    const answer = (json: unknown, status = 200) => ({
      value: { status, ok: status < 400, headers: {}, text: JSON.stringify(json) },
    })
    if (path === '/api/v3/users/me') return answer({ id: 54 })
    if (path.startsWith('/api/v3/memberships')) {
      return answer({ _embedded: { elements: [{ _links: { project: { href: '/api/v3/projects/45', title: 'IATI Publisher Support' } } }] } })
    }
    if (path === '/api/v3/statuses') return answer({ _embedded: { elements: STATUSES } })
    if (path.startsWith('/api/v3/projects/45/work_packages')) {
      const isClosedQuery = decodeURIComponent(path).includes('"operator":"c"')
      return answer({
        _embedded: {
          elements: isClosedQuery ? [wp(399, 'Old fix', 12, 54)] : [mine, wp(500, 'Fix the importer', 7, 61)],
        },
      })
    }
    if (path === '/api/v3/work_packages/411' && method === 'PATCH') {
      const status = Number(String((body as { _links: { status: { href: string } } })._links.status.href).split('/').pop())
      mine = wp(411, 'Check the XLSX download', status, 54, mine.lockVersion + 1)
      return answer(mine)
    }
    if (path === '/api/v3/time_entries/form') {
      return answer({
        _embedded: {
          schema: {
            activity: {
              _embedded: {
                allowedValues: [
                  { id: 3, name: 'Development' },
                  { id: 5, name: 'Support' },
                ],
              },
            },
          },
        },
      })
    }
    if (path === '/api/v3/time_entries' && method === 'POST') {
      mine = { ...mine, spentTime: 'PT1H40M' }
      return answer({ id: 1 }, 201)
    }
    if (path === '/api/v3/work_packages/411') return answer(mine)
    return answer({ message: 'not found' }, 404)
  })

  await $.session.start({ cwd: '/home/me/laravel/infrastructure-monitoring', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PROJECTS, surface: 'desktop' })
  await ui.press({ key: 'op-sync' })

  // Projects page: only your OpenProject project, linked to its folder.
  expect((await ui.find({ key: 'board:45' }))?.text).toBe('IATI Publisher Support')
  expect(await ui.find({ type: 'Text', text: /infrastructure-monitoring/ })).toBeUndefined()
  expect((stored['worklog-2'] as { links: Record<string, string> }).links['45']).toBe('/home/me/laravel/iatipublisher')
  expect((await ui.find({ type: 'Text', text: /open · / }))?.text).toBe('2 open · 1 yours')
  expect(sent.every(s => s.auth === `Basic ${btoa('apikey:opapi-test')}` && !s.path.includes('opapi'))).toBe(true)

  // The board: one card per work package, in its column.
  await ui.press({ key: 'open-board:45' })
  expect((await ui.find({ key: 'right:wp:411' }))?.text).toBe('Doing ▶')
  expect((await ui.find({ key: 'left:wp:500' }))?.text).toBe('◀ To do')
  expect((await ui.find({ key: 'left:wp:399' }))?.text).toBe('◀ Review')
  await ui.press({ key: 'filter-mine' })
  expect(await ui.find({ key: 'left:wp:500' })).toBeUndefined()
  await ui.press({ key: 'filter-all' })

  // Moving #411 right sets it to In progress in OpenProject, with its lock version.
  await ui.press({ key: 'right:wp:411' })
  const patch = sent.find(s => s.method === 'PATCH')
  expect(patch?.path).toBe('/api/v3/work_packages/411')
  expect(patch?.body).toEqual({ lockVersion: 1, _links: { status: { href: '/api/v3/statuses/7' } } })
  expect((await ui.find({ key: 'left:wp:411' }))?.text).toBe('◀ To do')

  // Time it for 25 minutes, stop, and book it: Support, on #411, today.
  await ui.press({ key: 'start:wp:411' })
  now += 25 * 60_000
  await ui.press({ key: 'stop:wp:411' })
  expect((await ui.find({ type: 'Text', text: /From your timer/ }))?.text).toContain('From your timer, started at')
  await ui.press({ key: 'book:wp:411' })
  const booking = sent.find(s => s.method === 'POST' && s.path === '/api/v3/time_entries')
  expect(booking?.body).toMatchObject({
    hours: 'PT0H25M',
    spentOn: '2026-11-23',
    _links: {
      workPackage: { href: '/api/v3/work_packages/411' },
      activity: { href: '/api/v3/time_entries/activities/5' },
    },
  })
  expect((await ui.find({ type: 'Text', text: /^Today/ }))?.text).toBe('Today 25m · Week 25m')
  expect((await ui.find({ type: 'Text', text: /1h 40m booked/ }))?.text).toBe('1h 40m booked')

  // Claude can add a task of your own to the board.
  const made = await $.tool.run({
    tool: 'mcp__changes-panel__create_task',
    tool_use_id: 't1',
    project: 'IATI Publisher Support',
    title: 'Write the reply to Zendesk',
  } as never)
  expect((made as { result?: unknown }).result).toBe(`Added "Write the reply to Zendesk" to IATI Publisher Support's board (To do).`)
  expect((await ui.find({ type: 'Text', text: /added by Claude/ }))?.text).toBe('Your own task · added by Claude')

  // Back to the projects page.
  await ui.press({ key: 'crumb-projects' })
  expect(await ui.find({ key: 'open-board:45' })).toBeDefined()
  await ui.unmount()
})
