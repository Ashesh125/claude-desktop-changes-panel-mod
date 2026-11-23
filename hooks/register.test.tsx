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
  on('command.register', () => ({ value: { command: 'changes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const args = e.argv.slice(3).join(' ')
    if (args.startsWith('rev-parse')) return answer('true\n')
    if (args.startsWith('status')) return answer(' M app/Foo.php\0?? new.txt\0')
    if (args.startsWith('branch')) return answer('main\n')
    if (args.startsWith('diff HEAD')) return answer(DIFF)
    return answer('', 1)
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    expect((await ui.find({ type: 'Text', text: /2 uncommitted files/ }))?.text).toBe(
      'main · 2 uncommitted files',
    )
    await ui.press({ key: 'file:app/Foo.php' })
    const code = await ui.find({ type: 'Code' })
    expect(code).toBeDefined()
    expect(code?.props?.source).toBe('@@ -1,2 +1,2 @@\n <?php\n-old line\n+new line')
    // A second click closes the diff again.
    await ui.press({ key: 'file:app/Foo.php' })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the graph opens a commit, and the terminal runs a command', async ($, on) => {
  const seen: string[] = []
  on('command.register', () => ({ value: { command: 'changes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const argv = e.argv
    if (argv[0] === 'zsh') {
      seen.push(argv[2] ?? '')
      return answer('hello\n')
    }
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

  await ui.input({ key: 'terminal', text: 'echo hello' })
  expect(seen).toEqual(['{ echo hello\n} 2>&1'])
  expect((await ui.find({ type: 'Text', text: /\$ echo hello/ }))?.text).toBe('$ echo hello')
  await ui.unmount()
})
