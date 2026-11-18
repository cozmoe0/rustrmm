import { Fragment, useMemo, useState } from 'react'
import { ChevronsUpDown } from 'lucide-react'
import {
  diffLines,
  diffWords,
  sideBySide,
  type DiffOp,
  type SideBySideRow,
  type WordSegment,
} from '@/lib/automation/diff'
import { cn } from '@/lib/utils'

function Words({ segments, tone }: { segments: WordSegment[]; tone: 'delete' | 'insert' }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.changed ? (
          <mark
            key={index}
            className={cn('rounded-[2px] text-inherit', tone === 'delete' ? 'bg-critical/25' : 'bg-success/25')}
          >
            {segment.text}
          </mark>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </>
  )
}

const NUM = 'w-11 shrink-0 select-none px-2 text-right text-subtle-foreground/70'
const CELL = 'min-w-0 flex-1 whitespace-pre px-3'

function SkipRow({ count, onExpand }: { count: number; onExpand: () => void }) {
  return (
    <button
      type="button"
      onClick={onExpand}
      className="flex w-full items-center gap-2 border-y border-border bg-surface-2/70 px-3 py-1 text-left font-sans text-micro text-muted-foreground hover:bg-surface-3 hover:text-foreground"
    >
      <ChevronsUpDown className="size-3.5" />
      {count} unchanged {count === 1 ? 'line' : 'lines'}
    </button>
  )
}

function SplitRow({ row }: { row: Exclude<SideBySideRow, { kind: 'skip' }> }) {
  if (row.kind === 'equal') {
    return (
      <div className="flex">
        <span className={NUM}>{row.left.line}</span>
        <span className={cn(CELL, 'border-r border-border text-foreground/80')}>{row.left.text || ' '}</span>
        <span className={NUM}>{row.right.line}</span>
        <span className={cn(CELL, 'text-foreground/80')}>{row.right.text || ' '}</span>
      </div>
    )
  }
  if (row.kind === 'change') {
    const words = diffWords(row.left.text, row.right.text)
    return (
      <div className="flex">
        <span className={cn(NUM, 'bg-critical/[0.07]')}>{row.left.line}</span>
        <span className={cn(CELL, 'border-r border-border bg-critical/[0.07]')}>
          <Words segments={words.left} tone="delete" />
        </span>
        <span className={cn(NUM, 'bg-success/[0.08]')}>{row.right.line}</span>
        <span className={cn(CELL, 'bg-success/[0.08]')}>
          <Words segments={words.right} tone="insert" />
        </span>
      </div>
    )
  }
  if (row.kind === 'delete') {
    return (
      <div className="flex">
        <span className={cn(NUM, 'bg-critical/[0.07]')}>{row.left.line}</span>
        <span className={cn(CELL, 'border-r border-border bg-critical/[0.07]')}>{row.left.text || ' '}</span>
        <span className={cn(NUM, 'bg-surface-2/60')} />
        <span
          className={cn(CELL, 'bg-[repeating-linear-gradient(135deg,transparent_0_6px,var(--grid-line)_6px_7px)]')}
        />
      </div>
    )
  }
  return (
    <div className="flex">
      <span className={cn(NUM, 'bg-surface-2/60')} />
      <span
        className={cn(
          CELL,
          'border-r border-border bg-[repeating-linear-gradient(135deg,transparent_0_6px,var(--grid-line)_6px_7px)]',
        )}
      />
      <span className={cn(NUM, 'bg-success/[0.08]')}>{row.right.line}</span>
      <span className={cn(CELL, 'bg-success/[0.08]')}>{row.right.text || ' '}</span>
    </div>
  )
}

function UnifiedRow({ op }: { op: DiffOp }) {
  const tone = op.type === 'delete' ? 'bg-critical/[0.07]' : op.type === 'insert' ? 'bg-success/[0.08]' : ''
  return (
    <div className={cn('flex', tone)}>
      <span className={NUM}>{op.oldLine ?? ''}</span>
      <span className={NUM}>{op.newLine ?? ''}</span>
      <span
        className={cn(
          'w-5 shrink-0 text-center select-none',
          op.type === 'delete' ? 'text-critical' : op.type === 'insert' ? 'text-success' : 'text-subtle-foreground/50',
        )}
      >
        {op.type === 'delete' ? '−' : op.type === 'insert' ? '+' : ' '}
      </span>
      <span className={cn(CELL, op.type === 'equal' && 'text-foreground/80')}>{op.text || ' '}</span>
    </div>
  )
}

/** Side-by-side or unified diff of two texts, with unchanged regions folded. */
export function DiffView({
  oldText,
  newText,
  layout,
  className,
}: {
  oldText: string
  newText: string
  layout: 'split' | 'unified'
  className?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const ops = useMemo(() => diffLines(oldText, newText), [oldText, newText])
  const rows = useMemo(() => sideBySide(ops, expanded ? -1 : 3), [ops, expanded])
  const unchanged = ops.every((op) => op.type === 'equal')

  if (unchanged) {
    return (
      <div
        className={cn(
          'rounded-lg bg-surface-2 px-4 py-8 text-center text-dense text-muted-foreground ring-1 ring-border',
          className,
        )}
      >
        The content of these versions is identical.
      </div>
    )
  }

  return (
    <div
      className={cn(
        'overflow-auto rounded-lg bg-surface-1 font-mono text-[12px] leading-5 ring-1 ring-border',
        className,
      )}
    >
      <div className="min-w-max py-1">
        {layout === 'split'
          ? rows.map((row, index) =>
              row.kind === 'skip' ? (
                <SkipRow key={`skip-${index}`} count={row.count} onExpand={() => setExpanded(true)} />
              ) : (
                <SplitRow key={index} row={row} />
              ),
            )
          : unifiedRows(ops, expanded).map((item, index) =>
              item.kind === 'skip' ? (
                <SkipRow key={`skip-${index}`} count={item.count} onExpand={() => setExpanded(true)} />
              ) : (
                <UnifiedRow key={index} op={item.op} />
              ),
            )}
      </div>
    </div>
  )
}

function unifiedRows(
  ops: DiffOp[],
  expanded: boolean,
): ({ kind: 'op'; op: DiffOp } | { kind: 'skip'; count: number })[] {
  if (expanded) return ops.map((op) => ({ kind: 'op', op }))
  const out: ({ kind: 'op'; op: DiffOp } | { kind: 'skip'; count: number })[] = []
  let index = 0
  while (index < ops.length) {
    if (ops[index].type !== 'equal') {
      out.push({ kind: 'op', op: ops[index] })
      index += 1
      continue
    }
    let end = index
    while (end < ops.length && ops[end].type === 'equal') end += 1
    const head = index === 0 ? 0 : 3
    const tail = end === ops.length ? 0 : 3
    if (end - index > head + tail + 1) {
      ops.slice(index, index + head).forEach((op) => out.push({ kind: 'op', op }))
      out.push({ kind: 'skip', count: end - index - head - tail })
      ops.slice(end - tail, end).forEach((op) => out.push({ kind: 'op', op }))
    } else ops.slice(index, end).forEach((op) => out.push({ kind: 'op', op }))
    index = end
  }
  return out
}
