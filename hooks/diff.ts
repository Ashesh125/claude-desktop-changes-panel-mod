import type { DiffLine } from '../types'

// Lines of context kept around each change, and how many one press reveals.
export const CONTEXT = 3
export const STEP = 20

// A diff asked for with the whole file as context (`-U<huge>`): every line of
// the file, numbered on each side, in one hunk per file. Lines before the
// first hunk (`diff --git`, `index`, `---`, `+++`) and `\ No newline` are skipped.
export const parseFullDiff = (out: string): { lines: DiffLine[]; isBinary: boolean } => {
  const lines: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  let started = false
  for (const raw of out.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      started = true
      continue
    }
    if (!started) {
      if (/^Binary files .* differ$/.test(raw)) return { lines: [], isBinary: true }
      continue
    }
    const sign = raw.charAt(0)
    const text = raw.slice(1)
    if (sign === '+') lines.push({ kind: 'add', old: null, new: newNo++, text })
    else if (sign === '-') lines.push({ kind: 'del', old: oldNo++, new: null, text })
    else if (sign === ' ') lines.push({ kind: 'ctx', old: oldNo++, new: newNo++, text })
  }
  return { lines, isBinary: false }
}

export type Block =
  // Lines drawn, as one unified-diff hunk the Code element reads.
  | { kind: 'hunk'; from: number; to: number; source: string }
  // Unchanged lines folded away, [from, to) by line index.
  | { kind: 'gap'; from: number; to: number }

// Splits a file's lines into drawn hunks and folded gaps: every change with
// CONTEXT lines around it, plus the ranges the person revealed; all of it
// when `full`.
export const blocks = (lines: DiffLine[], full: boolean, revealed: [number, number][]): Block[] => {
  const shown = lines.map(() => full)
  lines.forEach((line, i) => {
    if (line.kind === 'ctx') return
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) shown[j] = true
  })
  for (const [from, to] of revealed) {
    for (let i = Math.max(0, from); i < Math.min(lines.length, to); i++) shown[i] = true
  }

  // Lines of each side before index i, for the hunk headers.
  const oldBefore: number[] = []
  const newBefore: number[] = []
  let olds = 0
  let news = 0
  lines.forEach((line, i) => {
    oldBefore[i] = olds
    newBefore[i] = news
    if (line.kind !== 'add') olds++
    if (line.kind !== 'del') news++
  })

  const out: Block[] = []
  for (let i = 0; i < lines.length; ) {
    let end = i
    while (end < lines.length && shown[end] === shown[i]) end++
    if (!shown[i]) {
      out.push({ kind: 'gap', from: i, to: end })
    } else {
      const run = lines.slice(i, end)
      const oldCount = run.filter(l => l.kind !== 'add').length
      const newCount = run.filter(l => l.kind !== 'del').length
      const oldStart = (oldBefore[i] ?? 0) + (oldCount > 0 ? 1 : 0)
      const newStart = (newBefore[i] ?? 0) + (newCount > 0 ? 1 : 0)
      const body = run.map(l => (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text)
      out.push({
        kind: 'hunk',
        from: i,
        to: end,
        source: [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body].join('\n'),
      })
    }
    i = end
  }
  return out
}
