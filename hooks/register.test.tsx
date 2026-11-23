import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'changes-panel',
  component: 'Pane',
  requestId: 'changes-panel',
  props: {
    title: 'Changes',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'changes-panel',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const DIFF = [
  'diff --git a/app/Foo.php b/app/Foo.php',
  'index 111..222 100644',
  '--- a/app/Foo.php',
  '+++ b/app/Foo.php',
  '@@ -1,2 +1,2 @@',
  ' <?php',
  '-old line',
  '+new line',
  '',
].join('\n')

const answer = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

test('lists changed files and shows a diff on click', async ($, on) => {
  on('session.cwd', () => ({ value: '/home/me/my-app' }))
  on('session.repo', () => ({ value: null }))
  on('command.register', () => ({ value: { command: 'changes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const args = e.argv.slice(3).join(' ')
    if (args.startsWith('rev-parse')) return answer('true\n')
    if (args.startsWith('status')) return answer(' M app/Foo.php\0?? new.txt\0')
    if (args.startsWith('branch')) return answer('main\n')
    if (args.startsWith('diff HEAD --numstat')) return answer('2\t1\tapp/Foo.php\0')
    if (args.startsWith('diff HEAD')) return answer(DIFF)
    return answer('', 1)
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    expect((await ui.find({ type: 'Text', text: /2 uncommitted files/ }))?.text).toBe(
      '2 uncommitted files',
    )
    // The branch sits beside the view buttons.
    expect((await ui.find({ type: 'Text', text: /⎇/ }))?.text).toBe('⎇ main')
    await ui.press({ key: 'file:app/Foo.php' })
    const code = await ui.find({ type: 'Code' })
    expect(code).toBeDefined()
    expect(code?.props?.source).toBe('@@ -1,2 +1,2 @@\n <?php\n-old line\n+new line')
    // Only the picked file is shown, with where it sits in the list.
    expect((await ui.find({ type: 'Text', text: /of 2/ }))?.text).toBe('2 of 2')
    expect(await ui.find({ key: 'file-prev' })).toBeDefined()
    expect(await ui.find({ key: 'file-next' })).toBeUndefined()
    expect(await ui.find({ key: 'file:new.txt' })).toBeUndefined()
    await ui.press({ key: 'back-files' })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    // Files sit under their folder, with their line counts.
    expect((await ui.find({ type: 'Text', text: /^app\// }))?.text).toBe('app/')
    expect((await ui.find({ type: 'Text', text: /^2 files$/ }))?.text).toBe('2 files')
    expect((await ui.find({ type: 'Text', text: /^\+2 −1$/ }))?.text).toBe('+2 −1')
    await ui.unmount()
  }
})

test('the graph opens a commit', async ($, on) => {
  on('command.register', () => ({ value: { command: 'changes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const argv = e.argv
    const args = argv.slice(3).join(' ')
    if (args.startsWith('rev-parse')) return answer('true\n')
    if (args.startsWith('log --all')) {
      const rec = (h: string, p: string, refs: string, subject: string) =>
        [h, p, h.slice(0, 7), refs, subject, 'Ash', '2 hours ago'].join('\x1f') + '\x1e\n'
      return answer(
        rec('a'.repeat(40), `${'b'.repeat(40)} ${'c'.repeat(40)}`, 'HEAD -> main', 'Merge feature') +
          rec('c'.repeat(40), 'b'.repeat(40), 'feature', 'Add feature') +
          rec('b'.repeat(40), '', 'tag: v1', 'Initial'),
      )
    }
    if (args.startsWith('show --name-status')) return answer('M\0app/Foo.php\0')
    if (args.startsWith('log -1')) return answer('def5678 Add feature\n')
    if (args.startsWith('status')) return answer('')
    if (args.startsWith('branch')) return answer('main\n')
    return answer('', 1)
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'mode-graph' })
  // Each row draws its slice of the lanes; the merge row holds two lanes.
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /\[HEAD -> main\]/ }))?.text).toBe('aaaaaaa [HEAD -> main] Merge feature · Ash, 2 hours ago')
  await ui.press({ key: `commit:${'c'.repeat(40)}` })
  expect((await ui.find({ type: 'Text', text: /Add feature/ }))?.text).toBe('def5678 Add feature')
  expect(await ui.find({ key: 'file:app/Foo.php' })).toBeDefined()

  await ui.unmount()
})

test('the band shows the project, and Context expands', async ($, on) => {
  on('command.register', () => ({ value: { command: 'changes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/home/me/my-app' }))
  on('session.repo', () => ({ value: null }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: [],
      context: {
        tokens: 42000,
        window: 200000,
        percent: 21,
        breakdown: {
          categories: [
            { name: 'Messages', tokens: 30000, color: '#5a8dee', isDeferred: false, kind: 'used' },
            { name: 'System prompt', tokens: 12000, color: '#888888', isDeferred: false, kind: 'used' },
          ],
          // Only what the pane reads; the engine's breakdown holds more.
        } as never,
      },
    },
  }))
  on('process.run', (_, e) =>
    e.argv.includes('--show-current') ? answer('main\n') : answer('', 1),
  )

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // The project line lives in the band above the prompt, not in the pane.
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /Messages/ })).toBeUndefined()
  await ui.press({ key: 'context-toggle' })
  // Just the project: the branch is in the pane, the model is not shown.
  expect((await ui.find({ type: 'Text', text: /my-app/ }))?.text).toBe('my-app')
  expect((await ui.find({ key: 'context-toggle' }))?.text).toBe('Context 21% ▾')
  expect((await ui.find({ type: 'Text', text: /Messages/ }))?.text).toBe('■ Messages')
  await ui.unmount()
})
