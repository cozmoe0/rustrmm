/*
 * Line and word diffs for comparing script versions (Myers' O(ND) algorithm), plus the
 * side-by-side row layout with collapsed unchanged regions.
 */

export type DiffKind = 'equal' | 'insert' | 'delete'

export interface DiffOp {
  type: DiffKind
  text: string
  /** 1-based line number in the old text (equal and delete). */
  oldLine?: number
  /** 1-based line number in the new text (equal and insert). */
  newLine?: number
}

/** Shortest edit script between two sequences: a list of equal / delete / insert steps. */
export function myers<T>(
  a: readonly T[],
  b: readonly T[],
  equals: (x: T, y: T) => boolean = Object.is,
): { type: DiffKind; value: T }[] {
  // Trim the common prefix and suffix: cheap, and keeps the O(ND) trace small.
  let start = 0
  while (start < a.length && start < b.length && equals(a[start], b[start])) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && equals(a[endA - 1], b[endB - 1])) {
    endA -= 1
    endB -= 1
  }
  const head = a.slice(0, start).map((value) => ({ type: 'equal' as const, value }))
  const tail = a.slice(endA).map((value) => ({ type: 'equal' as const, value }))
  const x0 = a.slice(start, endA)
  const y0 = b.slice(start, endB)
  const n = x0.length
  const m = y0.length

  if (n === 0 || m === 0) {
    return [
      ...head,
      ...x0.map((value) => ({ type: 'delete' as const, value })),
      ...y0.map((value) => ({ type: 'insert' as const, value })),
      ...tail,
    ]
  }

  const max = n + m
  const offset = max
  const v = new Int32Array(2 * max + 2)
  const trace: Int32Array[] = []
  let found = false
  for (let d = 0; d <= max && !found; d += 1) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset]) ? v[k + 1 + offset] : v[k - 1 + offset] + 1
      let y = x - k
      while (x < n && y < m && equals(x0[x], y0[y])) {
        x += 1
        y += 1
      }
      v[k + offset] = x
      if (x >= n && y >= m) {
        found = true
        break
      }
    }
  }

  const middle: { type: DiffKind; value: T }[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const row = trace[d]
    const k = x - y
    const prevK = k === -d || (k !== d && row[k - 1 + offset] < row[k + 1 + offset]) ? k + 1 : k - 1
    const prevX = row[prevK + offset]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      middle.push({ type: 'equal', value: x0[x - 1] })
      x -= 1
      y -= 1
    }
    if (d > 0) {
      if (x === prevX) {
        middle.push({ type: 'insert', value: y0[y - 1] })
        y -= 1
      } else {
        middle.push({ type: 'delete', value: x0[x - 1] })
        x -= 1
      }
    }
  }
  middle.reverse()
  return [...head, ...middle, ...tail]
}

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function diffLines(oldText: string, newText: string): DiffOp[] {
  let oldLine = 0
  let newLine = 0
  return myers(splitLines(oldText), splitLines(newText)).map(({ type, value }) => {
    if (type === 'equal') {
      oldLine += 1
      newLine += 1
      return { type, text: value, oldLine, newLine }
    }
    if (type === 'delete') {
      oldLine += 1
      return { type, text: value, oldLine }
    }
    newLine += 1
    return { type, text: value, newLine }
  })
}

export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.type === 'insert') added += 1
    else if (op.type === 'delete') removed += 1
  }
  return { added, removed }
}

// ------------------------------------------------------------------ word diff

export interface WordSegment {
  text: string
  changed: boolean
}

const TOKEN = /\s+|[A-Za-z0-9_$-]+|[^\sA-Za-z0-9_$-]/g

/** Highlights the changed words between two versions of one line. */
export function diffWords(oldText: string, newText: string): { left: WordSegment[]; right: WordSegment[] } {
  const ops = myers(oldText.match(TOKEN) ?? [], newText.match(TOKEN) ?? [])
  const left: WordSegment[] = []
  const right: WordSegment[] = []
  const push = (list: WordSegment[], text: string, changed: boolean) => {
    const last = list[list.length - 1]
    if (last && last.changed === changed) last.text += text
    else list.push({ text, changed })
  }
  for (const { type, value } of ops) {
    if (type !== 'insert') push(left, value, type === 'delete')
    if (type !== 'delete') push(right, value, type === 'insert')
  }
  return { left, right }
}

// ------------------------------------------------------------------ side by side

export interface SideCell {
  line: number
  text: string
}

export type SideBySideRow =
  | { kind: 'equal'; left: SideCell; right: SideCell }
  | { kind: 'change'; left: SideCell; right: SideCell }
  | { kind: 'delete'; left: SideCell }
  | { kind: 'insert'; right: SideCell }
  | { kind: 'skip'; count: number; oldStart: number; newStart: number }

/**
 * Pairs deletions with the insertions that follow them into “change” rows and collapses unchanged
 * runs longer than `2 × context` lines into a single “skip” row.
 */
export function sideBySide(ops: DiffOp[], context = 3): SideBySideRow[] {
  const rows: SideBySideRow[] = []
  let index = 0
  while (index < ops.length) {
    const op = ops[index]
    if (op.type === 'equal') {
      rows.push({
        kind: 'equal',
        left: { line: op.oldLine!, text: op.text },
        right: { line: op.newLine!, text: op.text },
      })
      index += 1
      continue
    }
    const deletes: DiffOp[] = []
    const inserts: DiffOp[] = []
    while (index < ops.length && ops[index].type === 'delete') deletes.push(ops[index++])
    while (index < ops.length && ops[index].type === 'insert') inserts.push(ops[index++])
    const paired = Math.min(deletes.length, inserts.length)
    for (let position = 0; position < Math.max(deletes.length, inserts.length); position += 1) {
      const del = deletes[position]
      const ins = inserts[position]
      if (position < paired) {
        rows.push({
          kind: 'change',
          left: { line: del.oldLine!, text: del.text },
          right: { line: ins.newLine!, text: ins.text },
        })
      } else if (del) rows.push({ kind: 'delete', left: { line: del.oldLine!, text: del.text } })
      else rows.push({ kind: 'insert', right: { line: ins.newLine!, text: ins.text } })
    }
  }
  return collapse(rows, context)
}

function collapse(rows: SideBySideRow[], context: number): SideBySideRow[] {
  if (context < 0) return rows
  const out: SideBySideRow[] = []
  let index = 0
  while (index < rows.length) {
    if (rows[index].kind !== 'equal') {
      out.push(rows[index])
      index += 1
      continue
    }
    let end = index
    while (end < rows.length && rows[end].kind === 'equal') end += 1
    const run = rows.slice(index, end) as Extract<SideBySideRow, { kind: 'equal' }>[]
    const atStart = index === 0
    const atEnd = end === rows.length
    const keepHead = atStart ? 0 : context
    const keepTail = atEnd ? 0 : context
    if (run.length > keepHead + keepTail + 1) {
      out.push(...run.slice(0, keepHead))
      const first = run[keepHead]
      out.push({
        kind: 'skip',
        count: run.length - keepHead - keepTail,
        oldStart: first.left.line,
        newStart: first.right.line,
      })
      out.push(...run.slice(run.length - keepTail))
    } else out.push(...run)
    index = end
  }
  return out
}
