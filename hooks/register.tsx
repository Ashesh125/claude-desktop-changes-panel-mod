import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ChangedFile, Listing, Mode } from '../types'
import { layout, parseLog } from './graph'

const PANE = 'changes-panel'
const TITLE = 'Changes'
// The Code element draws at most 100000 characters; keep room for the rest.
const MAX_DIFF = 60000
const MAX_OUTPUT = 20000
const GRAPH_PAGE = 100
const EDITING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash'])

const listing = atom(
  { plugin: 'changes-panel', key: 'listing' } as const,
  { files: [], error: null, summary: '' },
  { shape: 'listing-1' },
)
const mode = atom({ plugin: 'changes-panel', key: 'mode' } as const, 'working', {
  shape: 'mode-2',
})
const shown = atom({ plugin: 'changes-panel', key: 'shown' } as const, null, {
  shape: 'shown-1',
})
// The commit the "commit" mode shows: HEAD, or one picked in the graph.
const rev = atom({ plugin: 'changes-panel', key: 'rev' } as const, 'HEAD', {
  shape: 'rev-1',
})
const graph = atom({ plugin: 'changes-panel', key: 'graph' } as const, [], {
  shape: 'graph-2',
})
const graphLimit = atom({ plugin: 'changes-panel', key: 'graphLimit' } as const, GRAPH_PAGE, {
  shape: 'graph-limit-1',
})
const runs = atom({ plugin: 'changes-panel', key: 'runs' } as const, [], {
  shape: 'runs-1',
})

const git = async ($: EngineInterface, args: string[]) =>
  $.process.run(['git', '-c', 'core.quotepath=off', ...args], { timeoutMs: 20000 })

// `git status --porcelain=v1 -z`: "XY path\0", renames add "\0orig".
const parseStatus = (out: string): ChangedFile[] => {
  const parts = out.split('\0')
  const files: ChangedFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? ''
    if (entry.length < 4) continue
    const x = entry.charAt(0)
    const y = entry.charAt(1)
    const path = entry.slice(3)
    if (x === 'R' || x === 'C') i++
    const isUntracked = x === '?' && y === '?'
    const status = isUntracked ? 'U' : x !== ' ' ? x : y
    files.push({ status, path, isUntracked })
  }
  return files
}

// `git show --name-status -z --format=`: "M\0path\0", renames "R100\0old\0new\0".
const parseNameStatus = (out: string): ChangedFile[] => {
  const parts = out.replace(/^\n+/, '').split('\0')
  const files: ChangedFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const code = (parts[i] ?? '').trim().charAt(0)
    if (!code) continue
    if (code === 'R' || code === 'C') {
      files.push({ status: code, path: parts[i + 2] ?? '', isUntracked: false })
      i += 2
    } else {
      files.push({ status: code, path: parts[i + 1] ?? '', isUntracked: false })
      i += 1
    }
  }
  return files.filter(f => f.path)
}

const loadListing = async (
  $: EngineInterface,
  which: Mode,
  commit: string,
): Promise<Listing> => {
  const inside = await git($, ['rev-parse', '--is-inside-work-tree'])
  if (inside.exitCode !== 0) {
    return { files: [], error: 'This folder is not a git repository.', summary: '' }
  }
  if (which === 'working') {
    const ran = await git($, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (ran.exitCode !== 0) return { files: [], error: ran.stderr.trim(), summary: '' }
    const branch = await git($, ['branch', '--show-current'])
    const files = parseStatus(ran.stdout)
    return {
      files,
      error: null,
      summary: `${branch.stdout.trim() || 'detached HEAD'} · ${files.length} uncommitted file${files.length === 1 ? '' : 's'}`,
    }
  }
  if (which === 'graph') return { files: [], error: null, summary: '' }
  const ran = await git($, ['show', '--name-status', '-z', '-M', '--format=', commit])
  if (ran.exitCode !== 0) return { files: [], error: 'No such commit.', summary: '' }
  const head = await git($, ['log', '-1', '--format=%h %s (%an, %ar)', commit])
  return { files: parseNameStatus(ran.stdout), error: null, summary: head.stdout.trim() }
}

const loadGraph = async ($: EngineInterface, limit: number) => {
  const ran = await git($, [
    'log',
    '--all',
    '--topo-order',
    `-n${limit}`,
    '--format=%H%x1f%P%x1f%h%x1f%D%x1f%s%x1f%an%x1f%ar%x1e',
  ])
  return ran.exitCode === 0 ? layout(parseLog(ran.stdout)) : []
}

const hunksOnly = (diff: string): string => {
  const start = diff.startsWith('@@') ? 0 : diff.indexOf('\n@@') + 1
  if (start <= 0 && !diff.startsWith('@@')) return ''
  let body = diff.slice(start)
  if (body.length > MAX_DIFF) {
    const cut = body.lastIndexOf('\n@@', MAX_DIFF)
    body = body.slice(0, cut > 0 ? cut : MAX_DIFF)
  }
  return body.replace(/\n$/, '')
}

const loadDiff = async ($: EngineInterface, which: Mode, commit: string, file: ChangedFile) => {
  let out = ''
  if (which === 'commit') {
    out = (await git($, ['show', '--format=', '-M', commit, '--', file.path])).stdout
  } else if (file.isUntracked) {
    out = (await git($, ['diff', '--no-index', '--', '/dev/null', file.path])).stdout
  } else {
    const ran = await git($, ['diff', 'HEAD', '--', file.path])
    // A repository with no commit yet has no HEAD: show the staged diff.
    out =
      ran.exitCode === 0
        ? ran.stdout
        : (await git($, ['diff', '--cached', '--', file.path])).stdout
  }
  const hunks = hunksOnly(out)
  if (hunks) return hunks
  if (/Binary files/.test(out)) return 'Binary file changed.'
  return file.status === 'D' ? 'File deleted.' : 'No textual changes.'
}

const refresh = async ($: EngineInterface) => {
  const which = await read($, mode)
  const commit = await read($, rev)
  if (which === 'graph') {
    const lines = await loadGraph($, await read($, graphLimit))
    await update($, graph, () => lines)
    return
  }
  const next = await loadListing($, which, commit)
  await update($, listing, () => next)
  const current = await read($, shown)
  if (!current) return
  const file = next.files.find(f => f.path === current.path)
  if (!file) {
    await update($, shown, () => null)
    return
  }
  const diff = await loadDiff($, which, commit, file)
  await update($, shown, () => ({ path: file.path, diff }))
}

const cap = (text: string) =>
  text.length > MAX_OUTPUT ? `… (earlier output cut)\n${text.slice(-MAX_OUTPUT)}` : text

const runCommand = async ($: EngineInterface, command: string) => {
  if (!command.trim()) return
  const id = Date.now()
  await update($, runs, list => [...list, { id, command, output: '', exitCode: null }].slice(-5))
  let output: string
  let exitCode: number
  try {
    const ran = await $.process.run(['bash', '-lc', `${command} 2>&1`], {
      timeoutMs: 120000,
    })
    output = cap(ran.stdout.replace(/\n$/, ''))
    exitCode = ran.exitCode
  } catch (err) {
    output = `Could not run: ${err instanceof Error ? err.message : String(err)}`
    exitCode = 1
  }
  await update($, runs, list =>
    list.map(run => (run.id === id ? { ...run, output, exitCode } : run)),
  )
  await refresh($)
}

const statusColor = (status: string) =>
  status === 'A' || status === 'U'
    ? 'diffAdded'
    : status === 'D'
      ? 'diffRemoved'
      : status === 'R' || status === 'C'
        ? 'suggestion'
        : 'warning'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'changes',
      description: 'Open the Changes pane: changed files, diffs, git graph and a terminal',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    void refresh($)

    return started
  })

  on('command.run', { command: 'changes' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await refresh($)

    return { text: 'Changes pane opened.' }
  })

  // Keep the list current as Claude edits files or runs commands.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (EDITING_TOOLS.has(e.tool)) void refresh($)

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Code, Input } = ui
    const Svg = 'Svg' in ui ? ui.Svg : null
    const list = await read($, listing)
    const which = await read($, mode)
    const commit = await read($, rev)
    const open = await read($, shown)
    const lines = await read($, graph)
    const history = await read($, runs)

    if (e.props.placement === 'widget') {
      return <Text>{list.files.length} changed</Text>
    }

    const switchTo = (to: Mode, toRev = 'HEAD') => async () => {
      await update($, mode, () => to)
      await update($, rev, () => toRev)
      await update($, shown, () => null)
      await refresh($)
    }
    const pick = (file: ChangedFile) => async () => {
      if (open?.path === file.path) {
        await update($, shown, () => null)
        return
      }
      const diff = await loadDiff($, which, commit, file)
      await update($, shown, () => ({ path: file.path, diff }))
    }
    const isLastCommit = which === 'commit' && commit === 'HEAD'

    const files = (
      <Box flexDirection="column" gap={1}>
        {list.summary !== '' && <Text dimColor>{list.summary}</Text>}
        {list.error !== null && <Text color="error">{list.error}</Text>}
        {list.error === null && list.files.length === 0 && (
          <Text dimColor>No changes.</Text>
        )}
        <Box flexDirection="column">
          {list.files.map(file => (
            <Button
              key={`file:${file.path}`}
              plain
              dimColor={open !== null && open.path !== file.path}
              onPress={pick(file)}
            >
              <Text color={statusColor(file.status)} mono>
                {file.status}
              </Text>{' '}
              {open?.path === file.path ? `▾ ${file.path}` : file.path}
            </Button>
          ))}
        </Box>
        {open !== null && (
          <Box flexDirection="column" gap={1}>
            <Text bold>{open.path}</Text>
            {open.diff.startsWith('@@') ? (
              <Code source={open.diff} format="diff" path={open.path} />
            ) : (
              <Text dimColor>{open.diff}</Text>
            )}
          </Box>
        )}
      </Box>
    )

    const limit = await read($, graphLimit)
    const refColor = (ref: string) =>
      ref.startsWith('HEAD') ? 'success' : ref.startsWith('tag: ') ? 'merged' : ref.includes('/') ? 'suggestion' : 'warning'
    const graphView = (
      <Box flexDirection="column">
        {lines.length === 0 && <Text dimColor>No commits.</Text>}
        {lines.map(row => (
          <Box key={`row:${row.hash}`} flexDirection="row" alignItems="center" gap={1}>
            <Box flexShrink={0}>
              {Svg ? (
                <Svg source={row.svg} alt={row.isMerge ? 'merge commit' : 'commit'} />
              ) : (
                <Text mono color="suggestion">
                  {row.text}
                </Text>
              )}
            </Box>
            <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              <Button key={`commit:${row.hash}`} plain onPress={switchTo('commit', row.hash)}>
                <Text wrap="truncate-end" maxLines={1}>
                  <Text mono color="warning">
                    {row.short}
                  </Text>{' '}
                  {row.refs.map(ref => (
                    <Text color={refColor(ref)} bold>
                      [{ref.replace(/^tag: /, '🏷 ')}]{' '}
                    </Text>
                  ))}
                  {row.subject}
                  <Text dimColor>
                    {' '}· {row.author}, {row.when}
                  </Text>
                </Text>
              </Button>
            </Box>
          </Box>
        ))}
        {lines.length >= limit && (
          <Button
            key="graph-more"
            onPress={async () => {
              await update($, graphLimit, n => n + GRAPH_PAGE)
              await refresh($)
            }}
          >
            Load more commits
          </Button>
        )}
      </Box>
    )

    const terminal = (
      <Box flexDirection="column" gap={1}>
        <Text bold>Terminal</Text>
        {history.map(run => (
          <Box flexDirection="column">
            <Text mono color={run.exitCode === null ? 'subtle' : run.exitCode === 0 ? 'success' : 'error'}>
              $ {run.command}
              {run.exitCode === null ? '  (running…)' : run.exitCode === 0 ? '' : `  (exit ${run.exitCode})`}
            </Text>
            {run.output !== '' && <Code source={run.output} language="text" />}
          </Box>
        ))}
        <Box flexDirection="row" gap={1}>
          <Box flexGrow={1}>
            <Input
              key="terminal"
              placeholder="Run a command in the project, e.g. git add -A"
              value=""
              submitLabel="run"
              onSubmit={value => runCommand($, value)}
            />
          </Box>
          {history.length > 0 && (
            <Button key="terminal-clear" onPress={() => update($, runs, () => [])}>
              Clear
            </Button>
          )}
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button
            key="mode-working"
            variant={which === 'working' ? 'primary' : 'secondary'}
            onPress={switchTo('working')}
          >
            Uncommitted
          </Button>
          <Button
            key="mode-commit"
            variant={isLastCommit ? 'primary' : 'secondary'}
            onPress={switchTo('commit')}
          >
            Last commit
          </Button>
          <Button
            key="mode-graph"
            variant={which === 'graph' ? 'primary' : 'secondary'}
            onPress={switchTo('graph')}
          >
            Graph
          </Button>
          {which === 'commit' && !isLastCommit && (
            <Button key="back-graph" onPress={switchTo('graph')}>
              ← Back to graph
            </Button>
          )}
          <Button key="refresh" onPress={() => refresh($)}>
            Refresh
          </Button>
        </Box>
        {which === 'graph' ? graphView : files}
        {terminal}
      </Box>
    )
  })
}
