import { expect, test } from 'claude-code/testing'

import { columnOf, matchProjects, remotePath } from './gitlab'

const GITLAB = {
  plugin: 'changes-panel',
  component: 'Pane',
  requestId: 'changes-panel-gitlab',
  props: {
    title: 'GitLab',
    isFocused: false,
    bodyColumns: 140,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
} as const

const ok = (stdout: string, exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

test('remotes and columns', () => {
  expect(remotePath('git@gl.example.test:web-apps/ims.git\n', 'gl.example.test')).toBe('web-apps/ims')
  expect(remotePath('https://gl.example.test/group/sub/app.git', 'gl.example.test')).toBe('group/sub/app')
  expect(remotePath('git@github.com:me/app.git', 'gl.example.test')).toBeNull()
  const columns = [
    { id: 'open', title: 'Open', label: null, color: '#888' },
    { id: 'label:TO DO', title: 'TO DO', label: 'TO DO', color: '#111' },
    { id: 'label:DOING', title: 'DOING', label: 'DOING', color: '#222' },
    { id: 'closed', title: 'Closed', label: null, color: '#2ea043' },
  ]
  const issue = { projectId: '1', iid: 1, title: 't', labels: ['BUG'], isClosed: false, assignees: [], isMine: false, spentSeconds: 0, url: '' }
  expect(columnOf(issue, columns)).toBe('open')
  expect(columnOf({ ...issue, labels: ['BUG', 'DOING'] }, columns)).toBe('label:DOING')
  expect(columnOf({ ...issue, labels: ['DOING'], isClosed: true }, columns)).toBe('closed')
  const all = [
    { name: 'Infrastructure Monitoring', path_with_namespace: 'web-apps/infrastructure-monitoring' },
    { name: 'IMS frontend', path_with_namespace: 'web-apps/infrastructure-monitoring-frontend' },
    { name: 'Helpdesk', path_with_namespace: 'web-apps/giz-helpdesk' },
  ]
  expect(matchProjects(all, 'monitoring front').map(p => p.name)).toEqual(['IMS frontend'])
  expect(matchProjects(all, 'WEB-APPS').length).toBe(3)
})

test('projects, the board, moving an issue and adding time in GitLab', async ($, on) => {
  let now = Date.UTC(2026, 10, 23, 4, 0)
  const stored: Record<string, unknown> = {}
  const calls: { method: string; path: string; fields: Record<string, string> }[] = []
  const me = { id: 340, username: 'me', name: 'Me Myself' }
  let issue = {
    project_id: 421,
    iid: 945,
    title: 'Fix the map colours',
    labels: ['BUG', 'TO DO'],
    state: 'opened',
    assignees: [{ username: 'me', name: 'Me Myself' }],
    time_stats: { total_time_spent: 0 },
    web_url: 'https://gl.example.test/web-apps/ims/-/issues/945',
  }
  const other = {
    ...issue,
    iid: 946,
    title: 'Dashboard is slow',
    labels: ['DOING'],
    assignees: [{ username: 'sita', name: 'Sita Rai' }],
    web_url: 'https://gl.example.test/web-apps/ims/-/issues/946',
  }
  const mr = {
    project_id: 421,
    iid: 711,
    title: 'Stop the shaking window',
    source_branch: '947-shaking',
    draft: false,
    detailed_merge_status: 'mergeable',
    author: { username: 'sita', name: 'Sita Rai' },
    reviewers: [{ id: 340 }],
    web_url: 'https://gl.example.test/web-apps/ims/-/merge_requests/711',
  }
  const project = {
    id: 421,
    name: 'ims',
    path_with_namespace: 'web-apps/ims',
    web_url: 'https://gl.example.test/web-apps/ims',
    default_branch: 'master',
    last_activity_at: '2026-11-23T03:00:00Z',
  }

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
  on('session.cwd', () => ({ value: '/home/me/laravel/other' }))
  on('session.repo', () => ({ value: null }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const argv = e.argv
    const line = argv.join(' ')
    if (line.includes('openproject.json') || line.includes('gitlab.json')) return ok('', 1)
    if (argv[0] === 'sh' && line.includes('command -v glab')) return ok('/snap/bin/glab\n')
    if (argv[0] === '/snap/bin/glab' && argv[1] === 'auth') return ok('', 0, '  ✓ Logged in to gl.example.test as me (config)\n')
    if (line.includes('rev-parse --show-toplevel')) return ok('/home/me/laravel/other\n')
    if (argv[0] === 'find') return ok('/home/me/laravel/ims/.git\n/home/me/laravel/other/.git\n')
    if (line.includes('remote get-url origin')) {
      return ok(argv[2] === '/home/me/laravel/ims' ? 'git@gl.example.test:web-apps/ims.git\n' : 'git@github.com:me/other.git\n')
    }
    if (argv[0] === '/snap/bin/glab' && argv[1] === 'api') {
      expect(argv.slice(2, 4)).toEqual(['--hostname', 'gl.example.test'])
      const method = argv[5] ?? 'GET'
      const path = argv[6] ?? ''
      const isList = argv.includes('--paginate')
      if (isList) expect(argv.slice(7)).toEqual(['--paginate', '--output', 'ndjson'])
      const fields: Record<string, string> = {}
      for (let i = 7; !isList && i < argv.length; i += 2) {
        const [k, ...v] = (argv[i + 1] ?? '').split('=')
        fields[k ?? ''] = v.join('=')
      }
      calls.push({ method, path, fields })
      // Lists come back one object per line, as `--output ndjson` prints them;
      // the assigned issues as two pages of arrays, as an older glab prints them.
      const json = (value: unknown) =>
        isList && Array.isArray(value)
          ? ok(path.startsWith('issues?') ? value.map(v => JSON.stringify([v])).join('\n') : value.map(v => JSON.stringify(v)).join('\n'))
          : ok(JSON.stringify(value))
      if (path === 'user') return json(me)
      if (path.startsWith('issues?scope=assigned_to_me')) return json([issue, { ...other, assignees: issue.assignees, iid: 950, title: 'Page two' }])
      if (path.startsWith('merge_requests?scope=created_by_me')) return json([])
      if (path.startsWith('merge_requests?scope=all')) return json([mr])
      if (path === 'projects/421') return json(project)
      if (path.startsWith('projects/421/pipelines?ref=master')) {
        return json([{ status: 'success', ref: 'master', web_url: 'https://gl.example.test/p/1', updated_at: '2026-11-23T02:00:00Z' }])
      }
      if (path.startsWith('projects?membership=true')) return json([project, { ...project, id: 999, name: 'npbmis', path_with_namespace: 'web-apps/npbmis' }])
      if (path === 'projects/999') return json({ ...project, id: 999, name: 'npbmis', path_with_namespace: 'web-apps/npbmis' })
      if (path.startsWith('projects/999/pipelines')) return json([])
      if (path.startsWith('projects/421/boards')) {
        return json([
          {
            lists: [
              { position: 1, label: { name: 'DOING', color: '#d29922' } },
              { position: 0, label: { name: 'TO DO', color: '#1f6feb' } },
            ],
          },
        ])
      }
      if (path.startsWith('projects/421/issues?state=opened')) return json([issue, other])
      if (path.startsWith('projects/421/issues?state=closed')) return json([])
      if (path.startsWith('projects/421/merge_requests')) return json([mr])
      if (path.startsWith('projects/421/pipelines')) return json([])
      if (path === 'projects/421/issues/945' && method === 'PUT') {
        const drop = (fields.remove_labels ?? '').split(',')
        issue = { ...issue, labels: [...issue.labels.filter(l => !drop.includes(l)), ...(fields.add_labels ? [fields.add_labels] : [])] }
        return json(issue)
      }
      if (path === 'projects/421/issues/945/add_spent_time') {
        issue = { ...issue, time_stats: { total_time_spent: 25 * 60 } }
        return json({ total_time_spent: 1500 })
      }
      if (path === 'projects/421/issues/945') return json(issue)
      return ok('', 1, 'glab: 404 Not Found')
    }
    return ok('', 1)
  })

  await $.session.start({ cwd: '/home/me/laravel/other', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...GITLAB, surface: 'desktop' })
  await ui.press({ key: 'gl-sync' })

  // Projects page: the project with your work, linked to its folder by remote.
  expect((await ui.find({ key: 'gl-board:421' }))?.text).toBe('ims')
  expect((stored['gitlab-1'] as { links: Record<string, string> }).links['421']).toBe('/home/me/laravel/ims')
  expect((await ui.find({ type: 'Text', text: /yours ·/ }))?.text).toBe('2 issues yours · 0 MRs · 1 to review')
  expect((await ui.find({ type: 'Text', text: /^master:/ }))?.text).toBe('master: success · 2h ago')

  // The board: columns from the project's board lists, in their order.
  await ui.press({ key: 'gl-open-board:421' })
  expect((await ui.find({ key: 'gl-right:gl:421:945' }))?.text).toBe('DOING ▶')
  expect((await ui.find({ key: 'gl-left:gl:421:945' }))?.text).toBe('◀ Open')
  expect((await ui.find({ key: 'gl-left:gl:421:946' }))?.text).toBe('◀ TO DO')
  expect((await ui.find({ type: 'Text', text: /Needs your review/ }))?.text).toBe('Needs your review')
  await ui.press({ key: 'gl-filter-mine' })
  expect(await ui.find({ key: 'gl-left:gl:421:946' })).toBeUndefined()
  await ui.press({ key: 'gl-filter-all' })

  // Moving #945 right swaps its board label in GitLab.
  await ui.press({ key: 'gl-right:gl:421:945' })
  const put = calls.find(c => c.method === 'PUT')
  expect(put).toEqual({
    method: 'PUT',
    path: 'projects/421/issues/945',
    fields: { remove_labels: 'TO DO', add_labels: 'DOING' },
  })
  expect((await ui.find({ key: 'gl-left:gl:421:945' }))?.text).toBe('◀ TO DO')

  // Time it for 25 minutes and add it to the issue in GitLab.
  await ui.press({ key: 'gl-start:gl:421:945' })
  now += 25 * 60_000
  await ui.press({ key: 'gl-stop:gl:421:945' })
  await ui.press({ key: 'gl-book:gl:421:945' })
  expect(calls.find(c => c.path.endsWith('add_spent_time'))?.fields).toEqual({ duration: '25m' })
  expect((await ui.find({ type: 'Text', text: /25m spent/ }))?.text).toBe('25m spent')
  expect((await ui.find({ type: 'Text', text: /^Today/ }))?.text).toBe('Today 25m · Week 25m')

  // Claude can read your GitLab work.
  const listed = await $.tool.run({ tool: 'mcp__changes-panel__list_gitlab_work', tool_use_id: 't1' } as never)
  expect(String((listed as { result?: unknown }).result)).toContain('!711 Stop the shaking window [by Sita Rai, waiting for your review')

  await ui.press({ key: 'gl-crumb' })
  expect(await ui.find({ key: 'gl-open-board:421' })).toBeDefined()

  // Search runs over every project you are a member of, and adds one.
  await ui.input({ key: 'gl-search', text: 'npbmis', kind: 'submit' })
  await ui.press({ key: 'gl-add:999' })
  expect((await ui.find({ key: 'gl-board:999' }))?.text).toBe('npbmis')
  await ui.unmount()
})
