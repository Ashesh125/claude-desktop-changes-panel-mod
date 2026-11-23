import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ChangedFile, ContextInfo, Listing, Mode } from '../types'
import { layout, parseLog } from './graph'
import { MINUTE, PROJECTS_PANE, PROJECTS_TITLE, formatMinutes, registerWorklog, startWorklog } from './worklog'
import {
  STATUS_WORDS,
  buildTree,
  chipSvg,
  churnSvg,
  compositionSvg,
  legend,
  rowSvg,
  rowText,
  statusHex,
} from './tree'

const PANE = 'changes-panel'
const TITLE = 'Changes'
const GRAPH_PAGE = 100
const EDITING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash'])

const listing = atom(
  { plugin: 'changes-panel', key: 'listing' } as const,
  { files: [], error: null, summary: '', head: null },
  { shape: 'listing-3' },
)
const mode = atom({ plugin: 'changes-panel', key: 'mode' } as const, 'working', {
  shape: 'mode-2',
})
// The file last opened in the app's diff pane, marked in the tree.
const picked = atom({ plugin: 'changes-panel', key: 'picked' } as const, null, {
  shape: 'picked-1',
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
const footer = atom(
  { plugin: 'changes-panel', key: 'footer' } as const,
  { project: '', branch: '' },
  { shape: 'footer-2' },
)
const context = atom({ plugin: 'changes-panel', key: 'context' } as const, null, {
  shape: 'context-1',
})
const contextOpen = atom({ plugin: 'changes-panel', key: 'contextOpen' } as const, false, {
  shape: 'context-open-1',
})
// The Projects pane's running timer (hooks/worklog.tsx writes it), read here
// for the band: same plugin and key, so the same values.
const running = atom({ plugin: 'changes-panel', key: 'running' } as const, null, { shape: 'running-1' })
const minute = atom({ plugin: 'changes-panel', key: 'minute' } as const, 0, { shape: 'minute-1' })
// Folders the person folded in the tree, by path.
const collapsed = atom({ plugin: 'changes-panel', key: 'collapsed' } as const, [], {
  shape: 'collapsed-1',
})
// The folder the pane last showed: when the session's root moves, the pane
// starts over in the new one.
const folder = atom({ plugin: 'changes-panel', key: 'folder' } as const, '', { shape: 'folder-1' })
const FOLDER_CHECK = 3000
// Set by the Projects pane (hooks/worklog.tsx) when a board opens.
const viewing = atom({ plugin: 'changes-panel', key: 'viewing' } as const, null, { shape: 'viewing-1' })

// Git runs in the session's project root, which moves when the folder is
// changed in the app (or with /cd), not where the session started.
const git = async ($: EngineInterface, args: string[]) =>
  $.process.run(['git', '-c', 'core.quotepath=off', ...args], {
    cwd: (await shownFolder($)) || undefined,
    timeoutMs: 20000,
  })

// The folder the pane shows: the linked folder of the project board opened
// last in the Projects pane, else the session's project root.
const shownFolder = async ($: EngineInterface) =>
  (await read($, viewing)) ?? (await $.session.root().catch(() => ''))

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
    files.push({ status, path, isUntracked, added: 0, removed: 0, isBinary: false })
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
      files.push({ status: code, path: parts[i + 2] ?? '', isUntracked: false, added: 0, removed: 0, isBinary: false })
      i += 2
    } else {
      files.push({ status: code, path: parts[i + 1] ?? '', isUntracked: false, added: 0, removed: 0, isBinary: false })
      i += 1
    }
  }
  return files.filter(f => f.path)
}

type Counts = { added: number; removed: number; isBinary: boolean }

// `--numstat -z`: "a\tr\tpath\0", renames "a\tr\t\0old\0new\0", binary "-\t-\t".
const parseNumstat = (out: string): Map<string, Counts> => {
  const parts = out.replace(/^\n+/, '').split('\0')
  const counts = new Map<string, Counts>()
  for (let i = 0; i < parts.length; i++) {
    const head = (parts[i] ?? '').replace(/^\n+/, '')
    const found = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(head)
    if (!found) continue
    const [, a = '0', d = '0', inline = ''] = found
    let path = inline
    if (inline === '') {
      path = parts[i + 2] ?? ''
      i += 2
    }
    counts.set(path, {
      added: a === '-' ? 0 : Number(a),
      removed: d === '-' ? 0 : Number(d),
      isBinary: a === '-',
    })
  }
  return counts
}

const withCounts = (files: ChangedFile[], counts: Map<string, Counts>) =>
  files.map(file => ({ ...file, ...(counts.get(file.path) ?? {}) }))

// Untracked files have no diff against HEAD: count each against nothing.
const MAX_UNTRACKED_COUNTED = 40
const countUntracked = async ($: EngineInterface, files: ChangedFile[]) => {
  const counts = new Map<string, Counts>()
  const untracked = files.filter(f => f.isUntracked).slice(0, MAX_UNTRACKED_COUNTED)
  await Promise.all(
    untracked.map(async file => {
      const ran = await git($, ['diff', '--no-index', '--numstat', '--', '/dev/null', file.path])
      const found = /^(-|\d+)\t(-|\d+)/.exec(ran.stdout)
      if (!found) return
      counts.set(file.path, {
        added: found[1] === '-' ? 0 : Number(found[1]),
        removed: 0,
        isBinary: found[1] === '-',
      })
    }),
  )
  return counts
}

const byFolder = (a: ChangedFile, b: ChangedFile) => {
  const dirA = a.path.includes('/') ? a.path.slice(0, a.path.lastIndexOf('/')) : ''
  const dirB = b.path.includes('/') ? b.path.slice(0, b.path.lastIndexOf('/')) : ''
  return dirA === dirB ? a.path.localeCompare(b.path) : dirA.localeCompare(dirB)
}

const loadListing = async (
  $: EngineInterface,
  which: Mode,
  commit: string,
): Promise<Listing> => {
  const inside = await git($, ['rev-parse', '--is-inside-work-tree'])
  if (inside.exitCode !== 0) {
    return { files: [], error: 'This folder is not a git repository.', summary: '', head: null }
  }
  if (which === 'working') {
    const ran = await git($, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (ran.exitCode !== 0) return { files: [], error: ran.stderr.trim(), summary: '', head: null }
    const tracked = await git($, ['diff', 'HEAD', '--numstat', '-z', '-M'])
    const found = parseStatus(ran.stdout)
    const counts = parseNumstat(
      tracked.exitCode === 0
        ? tracked.stdout
        : (await git($, ['diff', '--cached', '--numstat', '-z', '-M'])).stdout,
    )
    for (const [path, count] of await countUntracked($, found)) counts.set(path, count)
    const files = withCounts(found, counts).sort(byFolder)
    return {
      files,
      error: null,
      summary: `${files.length} uncommitted file${files.length === 1 ? '' : 's'}`,
      head: null,
    }
  }
  if (which === 'graph') return { files: [], error: null, summary: '', head: null }
  const ran = await git($, ['show', '--name-status', '-z', '-M', '--format=', commit])
  if (ran.exitCode !== 0) return { files: [], error: 'No such commit.', summary: '', head: null }
  const [head, stat] = await Promise.all([
    git($, ['log', '-1', '--format=%h%x1f%s%x1f%an%x1f%ar', commit]),
    git($, ['show', '--numstat', '-z', '-M', '--format=', commit]),
  ])
  const files = withCounts(parseNameStatus(ran.stdout), parseNumstat(stat.stdout)).sort(byFolder)
  const [hash = '', subject = '', author = '', when = ''] = head.stdout.trim().split('\x1f')
  return {
    files,
    error: null,
    summary: `${hash} ${subject} (${author}, ${when})`,
    head: { hash, subject, author, when },
  }
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

// Starts the pane over when the session has moved to another folder.
// Returns whether it did.
const followFolder = async ($: EngineInterface) => {
  const root = await shownFolder($)
  if (!root || root === (await read($, folder))) return false
  const isFirst = (await read($, folder)) === ''
  await update($, folder, () => root)
  if (isFirst) return false
  await update($, rev, () => 'HEAD')
  await update($, picked, () => null)
  await update($, collapsed, () => [])
  await update($, graphLimit, () => GRAPH_PAGE)
  await update($, mode, which => (which === 'commit' ? 'working' : which))
  await refresh($)
  return true
}

const refresh = async ($: EngineInterface) => {
  void loadFooter($)
  const which = await read($, mode)
  const commit = await read($, rev)
  if (which === 'graph') {
    const lines = await loadGraph($, await read($, graphLimit))
    await update($, graph, () => lines)
    return
  }
  const next = await loadListing($, which, commit)
  await update($, listing, () => next)
}

// Never throws: the footer is a nicety, and must not break what called it.
const loadFooter = async ($: EngineInterface) => {
  try {
    await loadFooterOrThrow($)
  } catch {
    // Leave the footer as it was.
  }
}

const loadFooterOrThrow = async ($: EngineInterface) => {
  const [root, branch] = await Promise.all([
    shownFolder($).then(f => f || $.session.cwd()),
    git($, ['branch', '--show-current']).catch(() => null),
  ])
  const project = root.split('/').filter(Boolean).pop() ?? root
  const next = { project, branch: branch?.stdout.trim() ?? '' }
  await update($, footer, () => next)
}

// "summary" is counted locally from the last response, so it costs no request.
const loadContext = async ($: EngineInterface) => {
  const { context: used } = await $.session.usage({ breakdown: 'summary' })
  const breakdown = used.breakdown
  const next: ContextInfo = {
    percent: Math.round(used.percent ?? breakdown?.percentage ?? 0),
    tokens: used.tokens ?? breakdown?.totalTokens ?? 0,
    window: used.window,
    categories: (breakdown?.categories ?? [])
      .filter(c => c.tokens > 0 && !c.isDeferred)
      .map(c => ({ name: c.name, tokens: c.tokens, color: c.color })),
  }
  await update($, context, () => next)
}

const compact = (n: number) =>
  n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

// Opens the app's own diff pane at this file: the uncommitted change, or
// the change the commit made. The pane is the desktop app's, reached through
// its view tool; a surface without it says so in a toast.
const openInApp = async ($: EngineInterface, which: Mode, commit: string, file: ChangedFile) => {
  await update($, picked, () => file.path)
  try {
    const [top, sha] = await Promise.all([
      git($, ['rev-parse', '--show-toplevel']),
      which === 'commit' ? git($, ['rev-parse', commit]) : Promise.resolve(null),
    ])
    const root = top.stdout.trim()
    const result = await $.mcp.call('ccd_view', 'show_pane', {
      pane: 'diff',
      path: root ? `${root}/${file.path}` : file.path,
      diff_scope: sha ? sha.stdout.trim() : 'uncommitted',
    })
    if (result.isError) {
      const words = result.content
        .map(block => ('text' in block && typeof block.text === 'string' ? block.text : ''))
        .join(' ')
        .trim()
      $.ui.toast(`Could not open the diff pane${words ? `: ${words}` : '.'}`)
    }
  } catch (err) {
    $.ui.toast(`Could not open the diff pane: ${err instanceof Error ? err.message : String(err)}`)
  }
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
  registerWorklog(on)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'changes',
      description: 'Open the Changes pane: changed files, diffs and the git graph',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    await followFolder($).catch(() => false)
    void refresh($)
    $.clock.every(FOLDER_CHECK, () => followFolder($).catch(() => false))
    void loadFooter($)
    await startWorklog($).catch(() => undefined)
    void loadContext($).catch(() => undefined)

    return started
  })

  // Context use and the branch change as the conversation goes on.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    void loadContext($).catch(() => undefined)
    if (!(await followFolder($).catch(() => false))) void loadFooter($)

    return done
  })

  on('command.run', { command: 'changes' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    if (!(await followFolder($).catch(() => false))) await refresh($)

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
    const { Box, Text, Button } = ui
    const Svg = 'Svg' in ui ? ui.Svg : null
    const list = await read($, listing)
    const which = await read($, mode)
    const commit = await read($, rev)
    const current = await read($, picked)
    const lines = await read($, graph)
    const env = await read($, footer)

    if (e.props.placement === 'widget') {
      return <Text>{list.files.length} changed</Text>
    }

    const switchTo = (to: Mode, toRev = 'HEAD') => async () => {
      await update($, mode, () => to)
      await update($, rev, () => toRev)
      await update($, picked, () => null)
      await refresh($)
    }
    const pick = (file: ChangedFile) => () => openInApp($, which, commit, file)
    const isLastCommit = which === 'commit' && commit === 'HEAD'
    // Showing a project's folder rather than the session's: a way back.
    const sessionRoot = await $.session.root().catch(() => '')
    const shown = await read($, viewing)
    const away = shown !== null && shown !== sessionRoot ? sessionRoot.split('/').filter(Boolean).pop() ?? '' : ''
    const backToSession = async () => {
      await update($, viewing, () => null)
      await followFolder($)
    }

    const biggest = Math.max(0, ...list.files.map(f => f.added + f.removed))
    const totalAdded = list.files.reduce((sum, f) => sum + f.added, 0)
    const totalRemoved = list.files.reduce((sum, f) => sum + f.removed, 0)
    const counts = (added: number, removed: number) => (
      <Text tabular>
        <Text color="diffAdded">+{added}</Text> <Text color="diffRemoved">−{removed}</Text>
      </Text>
    )

    const folded = await read($, collapsed)
    const tree = buildTree(list.files, folded)
    const toggle = (path: string) => () =>
      update($, collapsed, paths => (paths.includes(path) ? paths.filter(p => p !== path) : [...paths, path]))

    const treeRows = tree.map(row => (
      <Box key={`tree:${row.kind}:${row.path}`} flexDirection="row" alignItems="center" gap={1}>
        <Box flexShrink={0}>
          {Svg ? (
            <Svg source={rowSvg(row)} alt={row.kind === 'dir' ? 'folder' : 'file'} />
          ) : (
            <Text dimColor mono>
              {rowText(row)}
            </Text>
          )}
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {row.kind === 'dir' ? (
            <Button key={`dir:${row.path}`} plain onPress={toggle(row.path)}>
              <Text bold wrap="truncate-end">
                {row.name}
              </Text>
            </Button>
          ) : (
            <Button key={`file:${row.path}`} plain onPress={pick(row.file as ChangedFile)}>
              <Text wrap="truncate-end" bold={current === row.path} underline={current === row.path}>
                {row.name}
              </Text>
            </Button>
          )}
        </Box>
        {row.kind === 'dir' ? (
          <Text dimColor tabular>
            {row.fileCount} · +{row.added} −{row.removed}
          </Text>
        ) : row.file?.isBinary ? (
          <Text dimColor>binary</Text>
        ) : (
          counts(row.added, row.removed)
        )}
        {row.kind === 'file' && Svg && (
          <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
            <Svg source={churnSvg(row.added, row.removed, biggest)} alt={`${row.added} added, ${row.removed} removed`} />
            <Svg source={chipSvg(row.file?.status ?? 'M')} alt={STATUS_WORDS[row.file?.status ?? 'M'] ?? 'changed'} />
          </Box>
        )}
        {row.kind === 'file' && !Svg && (
          <Text mono bold color={statusColor(row.file?.status ?? 'M')}>
            {row.file?.status}
          </Text>
        )}
      </Box>
    ))

    const parts = legend(list.files)
    const summaryCard = list.files.length > 0 && (
      <Box flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={2} paddingY={1}>
        {list.head ? (
          <Box flexDirection="column">
            <Text>
              <Text mono color="warning">
                {list.head.hash}
              </Text>{' '}
              <Text bold>{list.head.subject}</Text>
            </Text>
            <Text dimColor>
              {list.head.author} · {list.head.when}
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text bold>Working tree</Text>
            <Text dimColor>Changes not yet committed, against HEAD</Text>
          </Box>
        )}
        <Box flexDirection="row" alignItems="center" gap={2}>
          <Text bold>
            {list.files.length} file{list.files.length === 1 ? '' : 's'}
          </Text>
          {counts(totalAdded, totalRemoved)}
        </Box>
        {Svg && <Svg source={compositionSvg(list.files, 260)} alt="Files by kind of change" />}
        <Box flexDirection="row" gap={2} flexWrap="wrap">
          {parts.map(part => (
            <Text>
              <Text color={statusHex(part.status)}>●</Text>{' '}
              <Text dimColor>
                {part.count} {STATUS_WORDS[part.status]}
              </Text>
            </Text>
          ))}
        </Box>
      </Box>
    )

    const fileList = (
      <Box flexDirection="column" gap={1}>
        {list.error !== null && <Text color="error">{list.error}</Text>}
        {list.error === null && list.files.length === 0 && (
          <Box borderStyle="round" borderDimColor paddingX={2} paddingY={1}>
            <Text dimColor>
              {which === 'working'
                ? 'Nothing to commit: the working tree matches HEAD.'
                : 'This commit changes no files.'}
            </Text>
          </Box>
        )}
        {summaryCard}
        {list.files.length > 0 && (
          <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} paddingY={1}>
            {treeRows}
          </Box>
        )}
      </Box>
    )

    const files = fileList

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

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} flexWrap="wrap">
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
          <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1} minWidth={0}>
            {away && (
              <Button key="folder-session" plain dimColor onPress={backToSession}>
                ← {away}
              </Button>
            )}
            {env.branch !== '' && (
              <Text dimColor mono wrap="truncate-start">
                {env.project} ⎇ {env.branch}
              </Text>
            )}
          </Box>
        </Box>
        {which === 'graph' ? graphView : files}
      </Box>
    )
  })

  // The project line and Context stay in view above the prompt, whatever the
  // Changes pane is scrolled to, and whether or not it is open.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button, Progress } = $.ui.resolve(e)
    const env = await read($, footer)
    const ctx = await read($, context)
    const isContextOpen = await read($, contextOpen)
    const timer = await read($, running)
    await read($, minute)
    const runningFor = timer ? formatMinutes(((await $.clock.now()) - timer.startedAt) / MINUTE) : ''

    return (
      <Box flexDirection="column" gap={1}>
        {isContextOpen && ctx !== null && (
          <Box flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={1}>
            <Progress
              label="Context window"
              value={ctx.tokens}
              max={ctx.window}
              valueText={`${compact(ctx.tokens)} / ${compact(ctx.window)} (${ctx.percent}%)`}
              color={ctx.percent >= 85 ? 'error' : ctx.percent >= 60 ? 'warning' : 'suggestion'}
            />
            <Box flexDirection="column">
              {ctx.categories.map(cat => (
                <Box key={`ctx:${cat.name}`} flexDirection="row" justifyContent="space-between">
                  <Text>
                    <Text color={cat.color}>■</Text> {cat.name}
                  </Text>
                  <Text dimColor tabular>
                    {compact(cat.tokens)}
                  </Text>
                </Box>
              ))}
            </Box>
          </Box>
        )}
        <Box flexDirection="row" justifyContent="flex-end" gap={1} flexWrap="wrap">
          {timer && (
            <Text wrap="truncate-end">
              <Text color="success">●</Text> {timer.label} · <Text tabular>{runningFor}</Text>
            </Text>
          )}
          <Button
            key="projects-open"
            plain
            dimColor
            onPress={() => $.ui.open({ id: PROJECTS_PANE, title: PROJECTS_TITLE })}
          >
            Projects
          </Button>
          <Text dimColor wrap="truncate-end">
            {env.project}
          </Text>
          <Button
            key="context-toggle"
            plain
            dimColor
            onPress={async () => {
              await update($, contextOpen, open => !open)
              await loadContext($).catch(() => undefined)
            }}
          >
            {`Context ${ctx === null ? '' : `${ctx.percent}% `}${isContextOpen ? '▾' : '▸'}`}
          </Button>
        </Box>
      </Box>
    )
  })
}
