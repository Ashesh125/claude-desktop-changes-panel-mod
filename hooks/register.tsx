import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ChangedFile, ContextInfo, Listing, Mode } from '../types'
import { layout, parseLog } from './graph'

const PANE = 'changes-panel'
const TITLE = 'Changes'
// The Code element draws at most 100000 characters; keep room for the rest.
const MAX_DIFF = 60000
const GRAPH_PAGE = 100
const EDITING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash'])

const listing = atom(
  { plugin: 'changes-panel', key: 'listing' } as const,
  { files: [], error: null, summary: '' },
  { shape: 'listing-2' },
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
const footer = atom(
  { plugin: 'changes-panel', key: 'footer' } as const,
  { project: '', branch: '', model: '' },
  { shape: 'footer-1' },
)
const context = atom({ plugin: 'changes-panel', key: 'context' } as const, null, {
  shape: 'context-1',
})
const contextOpen = atom({ plugin: 'changes-panel', key: 'contextOpen' } as const, false, {
  shape: 'context-open-1',
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
    return { files: [], error: 'This folder is not a git repository.', summary: '' }
  }
  if (which === 'working') {
    const ran = await git($, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (ran.exitCode !== 0) return { files: [], error: ran.stderr.trim(), summary: '' }
    const [branch, tracked] = await Promise.all([
      git($, ['branch', '--show-current']),
      git($, ['diff', 'HEAD', '--numstat', '-z', '-M']),
    ])
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
      summary: `${branch.stdout.trim() || 'detached HEAD'} · ${files.length} uncommitted file${files.length === 1 ? '' : 's'}`,
    }
  }
  if (which === 'graph') return { files: [], error: null, summary: '' }
  const ran = await git($, ['show', '--name-status', '-z', '-M', '--format=', commit])
  if (ran.exitCode !== 0) return { files: [], error: 'No such commit.', summary: '' }
  const [head, stat] = await Promise.all([
    git($, ['log', '-1', '--format=%h %s (%an, %ar)', commit]),
    git($, ['show', '--numstat', '-z', '-M', '--format=', commit]),
  ])
  const files = withCounts(parseNameStatus(ran.stdout), parseNumstat(stat.stdout)).sort(byFolder)
  return { files, error: null, summary: head.stdout.trim() }
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

// Never throws: the footer is a nicety, and must not break what called it.
const loadFooter = async ($: EngineInterface) => {
  try {
    await loadFooterOrThrow($)
  } catch {
    // Leave the footer as it was.
  }
}

const loadFooterOrThrow = async ($: EngineInterface) => {
  const [cwd, repo, model, branch] = await Promise.all([
    $.session.cwd(),
    $.session.repo().catch(() => null),
    $.session.model().catch(() => ''),
    git($, ['branch', '--show-current']).catch(() => null),
  ])
  const project = repo?.name ?? cwd.split('/').filter(Boolean).pop() ?? cwd
  const next = { project, branch: branch?.stdout.trim() ?? '', model }
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

const STATUS_NAMES: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  U: 'Untracked',
  T: 'Type changed',
}

const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

// A file's share of the change, scaled to the biggest file in the list, so
// the heavy files stand out: green for lines added, red for lines removed.
const ADD = '#2ea043'
const DEL = '#da3633'
const TRACK = '#8b949e'
const churnBar = (added: number, removed: number, biggest: number, width = 56) => {
  const total = added + removed
  const filled = total === 0 || biggest === 0 ? 0 : Math.max(3, Math.round((width * total) / biggest))
  const green = total === 0 ? 0 : Math.round((filled * added) / total)
  const clip = `<clipPath id="c"><rect x="0" y="1" width="${filled}" height="6" rx="3"/></clipPath>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="8" viewBox="0 0 ${width} 8">` +
    `<rect x="0" y="1" width="${width}" height="6" rx="3" fill="${TRACK}" opacity="0.18"/>` +
    (filled > 0
      ? `<defs>${clip}</defs><g clip-path="url(#c)">` +
        `<rect x="0" y="1" width="${green}" height="6" fill="${ADD}"/>` +
        `<rect x="${green}" y="1" width="${filled - green}" height="6" fill="${DEL}"/></g>`
      : '') +
    `</svg>`
  )
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
      description: 'Open the Changes pane: changed files, diffs and the git graph',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    void refresh($)
    void loadFooter($)
    void loadContext($).catch(() => undefined)

    return started
  })

  // Context use and the branch change as the conversation goes on.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    void loadContext($).catch(() => undefined)
    void loadFooter($)

    return done
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
    const { Box, Text, Button, Code } = ui
    const Svg = 'Svg' in ui ? ui.Svg : null
    const list = await read($, listing)
    const which = await read($, mode)
    const commit = await read($, rev)
    const open = await read($, shown)
    const lines = await read($, graph)

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
      const diff = await loadDiff($, which, commit, file)
      await update($, shown, () => ({ path: file.path, diff }))
    }
    const close = async () => {
      await update($, shown, () => null)
    }
    const isLastCommit = which === 'commit' && commit === 'HEAD'

    const biggest = Math.max(0, ...list.files.map(f => f.added + f.removed))
    const totalAdded = list.files.reduce((sum, f) => sum + f.added, 0)
    const totalRemoved = list.files.reduce((sum, f) => sum + f.removed, 0)
    const counts = (added: number, removed: number) => (
      <Text tabular>
        <Text color="diffAdded">+{added}</Text> <Text color="diffRemoved">−{removed}</Text>
      </Text>
    )

    const rows: ReturnType<typeof h>[] = []
    let folder: string | null = null
    for (const file of list.files) {
      const dir = folderOf(file.path)
      if (dir !== folder) {
        folder = dir
        rows.push(
          <Box key={`dir:${dir}`}>
            <Text dimColor mono size="caption" wrap="truncate-start">
              {dir === '' ? './' : `${dir}/`}
            </Text>
          </Box>,
        )
      }
      rows.push(
        <Box key={`row:${file.path}`} flexDirection="row" alignItems="center" gap={1} paddingLeft={2}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Button key={`file:${file.path}`} plain onPress={pick(file)}>
              <Text wrap="truncate-end">
                <Text mono bold color={statusColor(file.status)}>
                  {file.status}
                </Text>
                {'  '}
                {nameOf(file.path)}
              </Text>
            </Button>
          </Box>
          {file.isBinary ? <Text dimColor>binary</Text> : counts(file.added, file.removed)}
          {Svg && (
            <Box flexShrink={0}>
              <Svg source={churnBar(file.added, file.removed, biggest)} alt={`${file.added} added, ${file.removed} removed`} />
            </Box>
          )}
        </Box>,
      )
    }

    const fileList = (
      <Box flexDirection="column" gap={1}>
        {list.summary !== '' && <Text dimColor>{list.summary}</Text>}
        {list.error !== null && <Text color="error">{list.error}</Text>}
        {list.error === null && list.files.length === 0 && (
          <Text dimColor>
            {which === 'working' ? 'Nothing to commit: the working tree matches HEAD.' : 'This commit changes no files.'}
          </Text>
        )}
        {list.files.length > 0 && (
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Text bold>
              {list.files.length} file{list.files.length === 1 ? '' : 's'}
            </Text>
            {counts(totalAdded, totalRemoved)}
          </Box>
        )}
        <Box flexDirection="column">{rows}</Box>
      </Box>
    )

    const at = open === null ? -1 : list.files.findIndex(f => f.path === open.path)
    const openFile = at === -1 ? null : list.files[at] ?? null
    const prevFile = at > 0 ? list.files[at - 1] : undefined
    const nextFile = at >= 0 ? list.files[at + 1] : undefined
    const fileView = open !== null && (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
          <Button key="back-files" plain onPress={close}>
            ← All files
          </Button>
          <Box flexDirection="row" alignItems="center" gap={1}>
            {at >= 0 && (
              <Text dimColor tabular>
                {at + 1} of {list.files.length}
              </Text>
            )}
            {prevFile && (
              <Button key="file-prev" plain onPress={pick(prevFile)}>
                ‹ Prev
              </Button>
            )}
            {nextFile && (
              <Button key="file-next" plain onPress={pick(nextFile)}>
                Next ›
              </Button>
            )}
          </Box>
        </Box>
        <Box flexDirection="column">
          {folderOf(open.path) !== '' && (
            <Text dimColor mono wrap="truncate-start">
              {folderOf(open.path)}/
            </Text>
          )}
          <Text bold wrap="truncate-end">
            {nameOf(open.path)}
          </Text>
          {openFile && (
            <Text>
              <Text color={statusColor(openFile.status)}>
                {STATUS_NAMES[openFile.status] ?? openFile.status}
              </Text>
              {' · '}
              {openFile.isBinary ? <Text dimColor>binary</Text> : counts(openFile.added, openFile.removed)}
              <Text dimColor>
                {' · '}
                {which === 'commit' ? `in ${commit === 'HEAD' ? 'the last commit' : commit.slice(0, 7)}` : 'against HEAD'}
              </Text>
            </Text>
          )}
        </Box>
        {open.diff.startsWith('@@') ? (
          <Code source={open.diff} format="diff" path={open.path} />
        ) : (
          <Text dimColor>{open.diff}</Text>
        )}
      </Box>
    )
    const files = fileView || fileList

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
          <Text dimColor wrap="truncate-end">
            {env.project}
            {env.branch !== '' && ` · ⎇ ${env.branch}`}
            {env.model !== '' && ` · ${env.model}`}
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
