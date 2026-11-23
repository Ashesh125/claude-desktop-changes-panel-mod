// Turns a flat list of changed files into a folder tree, and draws each row's
// guide lines and icon as its own SVG slice so the rows stack into one tree.

import type { ChangedFile } from '../types'

export type TreeRow = {
  kind: 'dir' | 'file'
  // A folder's full path (its key), or the file's path.
  path: string
  // What the row shows: a file's name, or a folder's name with any
  // single-child folders below it folded in ("Domain/Admin").
  name: string
  depth: number
  // For each ancestor level: whether a later sibling still hangs below it.
  guides: boolean[]
  isLast: boolean
  isOpen: boolean
  added: number
  removed: number
  fileCount: number
  file?: ChangedFile
}

type Node = {
  name: string
  path: string
  dirs: Map<string, Node>
  files: ChangedFile[]
}

const newNode = (name: string, path: string): Node => ({ name, path, dirs: new Map(), files: [] })

const totals = (node: Node): { added: number; removed: number; fileCount: number } => {
  let added = 0
  let removed = 0
  let fileCount = node.files.length
  for (const file of node.files) {
    added += file.added
    removed += file.removed
  }
  for (const dir of node.dirs.values()) {
    const sub = totals(dir)
    added += sub.added
    removed += sub.removed
    fileCount += sub.fileCount
  }
  return { added, removed, fileCount }
}

export const buildTree = (files: readonly ChangedFile[], collapsed: readonly string[]): TreeRow[] => {
  const root = newNode('', '')
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      const path = node.path === '' ? part : `${node.path}/${part}`
      let next = node.dirs.get(part)
      if (!next) {
        next = newNode(part, path)
        node.dirs.set(part, next)
      }
      node = next
    }
    node.files.push(file)
  }

  const closed = new Set(collapsed)
  const rows: TreeRow[] = []

  const walk = (node: Node, depth: number, guides: boolean[]) => {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))
    const kids = [
      ...dirs.map(dir => ({ dir })),
      ...[...node.files].sort((a, b) => a.path.localeCompare(b.path)).map(file => ({ file })),
    ]
    kids.forEach((kid, i) => {
      const isLast = i === kids.length - 1
      if ('dir' in kid) {
        // Fold a chain of folders that hold nothing but one folder each.
        let dir = kid.dir
        let name = dir.name
        while (dir.files.length === 0 && dir.dirs.size === 1) {
          const only = [...dir.dirs.values()][0]
          if (!only) break
          dir = only
          name = `${name}/${dir.name}`
        }
        const isOpen = !closed.has(dir.path)
        rows.push({ kind: 'dir', path: dir.path, name, depth, guides, isLast, isOpen, ...totals(dir) })
        if (isOpen) walk(dir, depth + 1, [...guides, !isLast])
      } else {
        const file = kid.file
        rows.push({
          kind: 'file',
          path: file.path,
          name: file.path.slice(file.path.lastIndexOf('/') + 1),
          depth,
          guides,
          isLast,
          isOpen: false,
          added: file.added,
          removed: file.removed,
          fileCount: 1,
          file,
        })
      }
    })
  }
  walk(root, 0, [])
  return rows
}

// ---- Drawing ---------------------------------------------------------------

export const UNIT = 16
export const ROW = 26
const MID = ROW / 2
const GUIDE = '#8b949e'

export const STATUS_COLORS: Record<string, string> = {
  A: '#2ea043',
  M: '#d29922',
  D: '#da3633',
  R: '#8250df',
  C: '#8250df',
  U: '#1b9bd1',
  T: '#d29922',
}
export const statusHex = (status: string) => STATUS_COLORS[status] ?? '#d29922'

// The dot on a file's page: the colour of its language, as code hosts show it.
const EXT_COLORS: [RegExp, string][] = [
  [/\.blade\.php$/, '#f05340'],
  [/\.php$/, '#777bb4'],
  [/\.(ts|tsx)$/, '#3178c6'],
  [/\.(js|jsx|mjs|cjs)$/, '#e6c84f'],
  [/\.vue$/, '#41b883'],
  [/\.(scss|sass|css)$/, '#c6538c'],
  [/\.(md|txt)$/, '#8b949e'],
  [/\.json$/, '#cbcb41'],
  [/\.(ya?ml)$/, '#cb171e'],
  [/\.rb$/, '#cc342d'],
  [/\.(sh|zsh|bash)$/, '#89e051'],
  [/\.sql$/, '#e38c00'],
  [/\.html?$/, '#e34c26'],
  [/(^|\/)(Dockerfile|\.env.*)$/, '#384d54'],
]
const extColor = (path: string) => EXT_COLORS.find(([re]) => re.test(path))?.[1] ?? '#8b949e'

const folderIcon = (isOpen: boolean) =>
  isOpen
    ? `<path d="M1 4.5A1.5 1.5 0 0 1 2.5 3h3.6l1.6 1.8h5.8A1.5 1.5 0 0 1 15 6.3V7H3.2L1 13z" fill="#b07d1f"/>` +
      `<path d="M3.1 7.2h12.3l-1.9 5.9a1.3 1.3 0 0 1-1.2.9H1.4z" fill="#e3b341"/>`
    : `<path d="M1 4.5A1.5 1.5 0 0 1 2.5 3h3.6l1.6 1.8h5.8A1.5 1.5 0 0 1 15 6.3v6.2A1.5 1.5 0 0 1 13.5 14h-11A1.5 1.5 0 0 1 1 12.5z" fill="#c69026"/>`

const fileIcon = (path: string) =>
  `<path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="${GUIDE}" stroke-width="1.2" stroke-linejoin="round"/>` +
  `<path d="M9.5 1.5v3h3" fill="none" stroke="${GUIDE}" stroke-width="1.2" stroke-linejoin="round"/>` +
  `<circle cx="8" cy="10" r="2.5" fill="${extColor(path)}"/>`

export const rowSvg = (row: TreeRow) => {
  const width = row.depth * UNIT + UNIT + 2
  const parts: string[] = []
  const line = (d: string) =>
    parts.push(`<path d="${d}" stroke="${GUIDE}" stroke-opacity="0.5" stroke-width="1.25" fill="none" stroke-linecap="round"/>`)

  // Ancestors with siblings still to come keep their line running through:
  // the one at depth k hangs from column k - 1, as its own elbow does.
  row.guides.forEach((hasMore, depth) => {
    if (depth >= 1 && depth < row.depth && hasMore) line(`M${(depth - 1) * UNIT + 8} 0V${ROW}`)
  })
  if (row.depth > 0) {
    const x = (row.depth - 1) * UNIT + 8
    if (row.isLast) line(`M${x} 0V${MID - 4}Q${x} ${MID} ${x + 4} ${MID}H${x + UNIT - 3}`)
    else {
      line(`M${x} 0V${ROW}`)
      line(`M${x} ${MID}H${x + UNIT - 3}`)
    }
  }
  // An open folder hands its line down to its first child.
  if (row.kind === 'dir' && row.isOpen) line(`M${row.depth * UNIT + 8} ${MID + 6}V${ROW}`)

  const icon = row.kind === 'dir' ? folderIcon(row.isOpen) : fileIcon(row.path)
  parts.push(`<g transform="translate(${row.depth * UNIT} ${MID - 8})">${icon}</g>`)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${ROW}" viewBox="0 0 ${width} ${ROW}">${parts.join('')}</svg>`
}

// The terminal has no Svg: the same tree in box-drawing characters.
export const rowText = (row: TreeRow) => {
  let text = ''
  row.guides.forEach((hasMore, depth) => {
    if (depth >= 1 && depth < row.depth) text += hasMore ? '│ ' : '  '
  })
  if (row.depth > 0) text += row.isLast ? '└ ' : '├ '
  return text + (row.kind === 'dir' ? (row.isOpen ? '▾' : '▸') : '·')
}

export const chipSvg = (status: string) => {
  const color = statusHex(status)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="16" viewBox="0 0 18 16">` +
    `<rect x="0.75" y="0.75" width="16.5" height="14.5" rx="4" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-opacity="0.7"/>` +
    `<text x="9" y="11.6" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="10" font-weight="700" fill="${color}">${status}</text>` +
    `</svg>`
  )
}

// A file's share of the change, scaled to the biggest file in the list.
export const churnSvg = (added: number, removed: number, biggest: number, width = 48) => {
  const total = added + removed
  const filled = total === 0 || biggest === 0 ? 0 : Math.max(3, Math.round((width * total) / biggest))
  const green = total === 0 ? 0 : Math.round((filled * added) / total)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="8" viewBox="0 0 ${width} 8">` +
    `<rect x="0" y="1" width="${width}" height="6" rx="3" fill="${GUIDE}" opacity="0.18"/>` +
    (filled > 0
      ? `<defs><clipPath id="c"><rect x="0" y="1" width="${filled}" height="6" rx="3"/></clipPath></defs>` +
        `<g clip-path="url(#c)"><rect x="0" y="1" width="${green}" height="6" fill="${STATUS_COLORS.A}"/>` +
        `<rect x="${green}" y="1" width="${filled - green}" height="6" fill="${STATUS_COLORS.D}"/></g>`
      : '') +
    `</svg>`
  )
}

const ORDER = ['A', 'M', 'R', 'D', 'U']
export const statusOf = (status: string) => (status === 'C' ? 'R' : status === 'T' ? 'M' : status)

// How the change splits by kind: one segment per status, by file count.
export const compositionSvg = (files: readonly ChangedFile[], width = 260) => {
  const counts = ORDER.map(s => files.filter(f => statusOf(f.status) === s).length)
  const total = counts.reduce((a, b) => a + b, 0)
  let x = 0
  const segs = counts
    .map((n, i) => {
      if (n === 0 || total === 0) return ''
      const w = (width * n) / total
      const seg = `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="10" fill="${statusHex(ORDER[i] ?? 'M')}"/>`
      x += w
      return seg
    })
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="10" viewBox="0 0 ${width} 10">` +
    `<defs><clipPath id="r"><rect x="0" y="0" width="${width}" height="10" rx="5"/></clipPath></defs>` +
    `<g clip-path="url(#r)">${segs}</g></svg>`
  )
}

export const STATUS_WORDS: Record<string, string> = {
  A: 'added',
  M: 'modified',
  R: 'renamed',
  D: 'deleted',
  U: 'untracked',
}
export const legend = (files: readonly ChangedFile[]) =>
  ORDER.map(s => ({ status: s, count: files.filter(f => statusOf(f.status) === s).length })).filter(
    entry => entry.count > 0,
  )
