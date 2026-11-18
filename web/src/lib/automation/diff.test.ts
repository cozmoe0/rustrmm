import { describe, expect, it } from 'vitest'
import { diffLines, diffStats, diffWords, myers, sideBySide } from './diff'

describe('myers', () => {
  it('finds the shortest edit script', () => {
    const ops = myers('ABCABBA'.split(''), 'CBABAC'.split(''))
    const edits = ops.filter((op) => op.type !== 'equal').length
    expect(edits).toBe(5)
    expect(
      ops
        .filter((op) => op.type !== 'insert')
        .map((op) => op.value)
        .join(''),
    ).toBe('ABCABBA')
    expect(
      ops
        .filter((op) => op.type !== 'delete')
        .map((op) => op.value)
        .join(''),
    ).toBe('CBABAC')
  })

  it('handles empty inputs', () => {
    expect(myers([], ['a'])).toEqual([{ type: 'insert', value: 'a' }])
    expect(myers(['a'], [])).toEqual([{ type: 'delete', value: 'a' }])
    expect(myers([], [])).toEqual([])
  })
})

describe('diffLines', () => {
  const before = 'one\ntwo\nthree\nfour\n'
  const after = 'one\n2\nthree\nfour\nfive\n'

  it('numbers lines on each side', () => {
    const ops = diffLines(before, after)
    expect(ops).toEqual([
      { type: 'equal', text: 'one', oldLine: 1, newLine: 1 },
      { type: 'delete', text: 'two', oldLine: 2 },
      { type: 'insert', text: '2', newLine: 2 },
      { type: 'equal', text: 'three', oldLine: 3, newLine: 3 },
      { type: 'equal', text: 'four', oldLine: 4, newLine: 4 },
      { type: 'insert', text: 'five', newLine: 5 },
    ])
    expect(diffStats(ops)).toEqual({ added: 2, removed: 1 })
  })

  it('normalises line endings', () => {
    expect(diffLines('a\r\nb', 'a\nb').every((op) => op.type === 'equal')).toBe(true)
  })
})

describe('sideBySide', () => {
  it('pairs deletions with insertions as changes', () => {
    const rows = sideBySide(diffLines('a\nold1\nold2\nb', 'a\nnew1\nb'), -1)
    expect(rows.map((row) => row.kind)).toEqual(['equal', 'change', 'delete', 'equal'])
    expect(rows[1]).toEqual({ kind: 'change', left: { line: 2, text: 'old1' }, right: { line: 2, text: 'new1' } })
  })

  it('collapses long unchanged runs but keeps context around changes', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
    const changed = [...lines]
    changed[10] = 'CHANGED'
    const rows = sideBySide(diffLines(lines.join('\n'), changed.join('\n')), 2)
    expect(rows.map((row) => row.kind)).toEqual(['skip', 'equal', 'equal', 'change', 'equal', 'equal', 'skip'])
    expect(rows[0]).toEqual({ kind: 'skip', count: 8, oldStart: 1, newStart: 1 })
    expect(rows[6]).toMatchObject({ kind: 'skip', count: 7, oldStart: 14 })
  })

  it('folds identical texts into one skip row', () => {
    expect(sideBySide(diffLines('a\nb\nc', 'a\nb\nc'))).toEqual([{ kind: 'skip', count: 3, oldStart: 1, newStart: 1 }])
  })
})

describe('diffWords', () => {
  it('highlights only the changed words', () => {
    const { left, right } = diffWords('Restart-Service -Name Spooler', 'Restart-Service -Name W32Time -Force')
    expect(left).toEqual([
      { text: 'Restart-Service -Name ', changed: false },
      { text: 'Spooler', changed: true },
    ])
    expect(right).toEqual([
      { text: 'Restart-Service -Name ', changed: false },
      { text: 'W32Time -Force', changed: true },
    ])
  })
})
