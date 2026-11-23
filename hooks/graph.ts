import type { GraphRow } from '../types'

// Lays out `git log --topo-order` commits into lanes, GitLab/IDE style, and
// draws each row as its own SVG slice so rows stack into one graph.

export type GraphCommit = {
  hash: string
  parents: string[]
  short: string
  refs: string[]
  subject: string
  author: string
  when: string
}


export const LANE = 14
export const ROW = 28
const PAD = 8
const COLORS = [
  '#1f78d1', '#e5534b', '#2da44e', '#d4a72c', '#8250df',
  '#db61a2', '#0e9aa7', '#e16f24', '#57606a', '#5a8dee',
]
const color = (lane: number) => COLORS[lane % COLORS.length] ?? '#888'
const x = (lane: number) => PAD + lane * LANE

type Line = { from: number; to: number; half: 'top' | 'bottom'; lane: number }

export const parseLog = (out: string): GraphCommit[] =>
  out
    .split('\x1e')
    .map(rec => rec.replace(/^\n+/, ''))
    .filter(rec => rec.length > 0)
    .map(rec => {
      const [hash = '', parents = '', short = '', refs = '', subject = '', author = '', when = ''] =
        rec.split('\x1f')
      return {
        hash,
        parents: parents.split(' ').filter(Boolean),
        short,
        refs: refs.split(', ').map(r => r.trim()).filter(Boolean),
        subject,
        author,
        when: when.trim(),
      }
    })

const firstFree = (lanes: (string | null)[]) => {
  const i = lanes.indexOf(null)
  return i === -1 ? lanes.length : i
}

const trim = (lanes: (string | null)[]) => {
  while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
}

export const layout = (commits: GraphCommit[]): GraphRow[] => {
  let lanes: (string | null)[] = []
  const rows: { commit: GraphCommit; col: number; lines: Line[]; before: (string | null)[]; after: (string | null)[] }[] = []
  let widest = 1

  for (const commit of commits) {
    let col = lanes.indexOf(commit.hash)
    // A commit no lane waits for is a branch tip: nothing is drawn above it.
    const isTip = col === -1
    if (isTip) {
      col = firstFree(lanes)
      lanes[col] = commit.hash
    }
    const before = [...lanes]
    const lines: Line[] = []

    // Top half: every lane coming in; those waiting on this commit bend into it.
    before.forEach((h, i) => {
      if (h === null) return
      if (h !== commit.hash) lines.push({ from: i, to: i, half: 'top', lane: i })
      else if (!(isTip && i === col)) lines.push({ from: i, to: col, half: 'top', lane: i })
    })

    // Lanes waiting on this commit end here.
    lanes = lanes.map((h, i) => (h === commit.hash && i !== col ? null : h))
    const [first, ...rest] = commit.parents
    lanes[col] = first ?? null
    const parentLanes: number[] = first ? [col] : []
    for (const parent of rest) {
      let at = lanes.indexOf(parent)
      if (at === -1) {
        at = firstFree(lanes)
        lanes[at] = parent
      }
      parentLanes.push(at)
    }
    const after = [...lanes]

    // Bottom half: lanes passing by, and lines from this commit to its parents.
    after.forEach((h, i) => {
      if (h === null || parentLanes.includes(i)) return
      lines.push({ from: i, to: i, half: 'bottom', lane: i })
    })
    for (const at of parentLanes) {
      if (at !== col && before[at] != null && before[at] !== commit.hash) {
        // The parent already had a lane: it passes by and this one joins it.
        lines.push({ from: at, to: at, half: 'bottom', lane: at })
      }
      lines.push({ from: col, to: at, half: 'bottom', lane: at === col ? col : at })
    }

    widest = Math.max(widest, before.length, after.length, col + 1)
    rows.push({ commit, col, lines, before, after })
    trim(lanes)
  }

  const width = PAD * 2 + (widest - 1) * LANE
  const mid = ROW / 2

  return rows.map(({ commit, col, lines, before, after }) => {
    const paths = lines
      .map(l => {
        const y0 = l.half === 'top' ? 0 : mid
        const y1 = l.half === 'top' ? mid : ROW
        const x0 = x(l.from)
        const x1 = x(l.to)
        const d =
          x0 === x1
            ? `M${x0} ${y0}V${y1}`
            : `M${x0} ${y0}C${x0} ${(y0 + y1) / 2} ${x1} ${(y0 + y1) / 2} ${x1} ${y1}`
        return `<path d="${d}" stroke="${color(l.lane)}" stroke-width="2" fill="none" stroke-linecap="round"/>`
      })
      .join('')
    const isMerge = commit.parents.length > 1
    const isHead = commit.refs.some(r => r.startsWith('HEAD'))
    const node = isMerge
      ? `<circle cx="${x(col)}" cy="${mid}" r="4" fill="none" stroke="${color(col)}" stroke-width="2.5"/>`
      : `<circle cx="${x(col)}" cy="${mid}" r="${isHead ? 5.5 : 4.5}" fill="${color(col)}"/>`
    const ring = isHead
      ? `<circle cx="${x(col)}" cy="${mid}" r="8" fill="none" stroke="${color(col)}" stroke-width="1.5" opacity="0.5"/>`
      : ''
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${ROW}" viewBox="0 0 ${width} ${ROW}">${paths}${ring}${node}</svg>`

    // The terminal has no Svg: one glyph per lane.
    const cells = Math.max(before.length, after.length, col + 1)
    let text = ''
    for (let i = 0; i < cells; i++) {
      if (i === col) text += isMerge ? '◎' : '●'
      else if (before[i] != null || after[i] != null) text += '│'
      else text += ' '
      text += ' '
    }

    return {
      hash: commit.hash,
      short: commit.short,
      refs: commit.refs,
      subject: commit.subject,
      author: commit.author,
      when: commit.when,
      isMerge,
      svg,
      text: text.trimEnd(),
    }
  })
}
