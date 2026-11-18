import { describe, expect, it } from 'vitest'
import type { WidgetPlacement } from '@/lib/api/types'
import { addItem, clampRect, compact, firstFit, layoutHeight, layoutIssues, moveItem, overlaps, readingOrder, removeItem, resizeItem, type Rect } from './grid'
import { BUILTIN_HOME_LAYOUT, availableWidgets, cleanConfig, configIssues, widgetTitle } from './widgets'

const noOverlap = (layout: Rect[]) => {
  for (let a = 0; a < layout.length; a += 1) for (let b = a + 1; b < layout.length; b += 1) expect(overlaps(layout[a], layout[b]), `${a} vs ${b}`).toBe(false)
}

describe('grid constraints', () => {
  it('clamps rectangles into the 12-column grid', () => {
    expect(clampRect({ x: 10, y: -3, w: 6, h: 40 })).toEqual({ x: 6, y: 0, w: 6, h: 24 })
    expect(clampRect({ x: -2, y: 2000, w: 0, h: 0 })).toEqual({ x: 0, y: 1000, w: 1, h: 1 })
    expect(clampRect({ x: 0, y: 0, w: 1, h: 1 }, { w: 3, h: 2 })).toEqual({ x: 0, y: 0, w: 3, h: 2 })
    expect(clampRect({ x: 1.6, y: 2.2, w: 3.5, h: 2.4 })).toEqual({ x: 2, y: 2, w: 4, h: 2 })
  })

  it('reports what the server would refuse', () => {
    expect(layoutIssues(BUILTIN_HOME_LAYOUT)).toEqual([])
    expect(layoutIssues([{ x: 8, y: 0, w: 6, h: 3 }])[0]).toMatch(/12-column/)
    expect(layoutIssues([{ x: 0, y: 0, w: 4, h: 30 }])[0]).toMatch(/1–24/)
    expect(layoutIssues([{ x: 0, y: 1001, w: 4, h: 3 }])[0]).toMatch(/row 1000/)
    expect(layoutIssues([{ x: 0, y: 0, w: 4, h: 3, config: { title: 'x'.repeat(5000) } }])[0]).toMatch(/4 KB/)
    expect(layoutIssues([{ x: 0, y: 0, w: 4, h: 3 }, { x: 2, y: 1, w: 4, h: 3 }])[0]).toMatch(/overlap/)
    expect(layoutIssues(Array.from({ length: 41 }, (_, index) => ({ x: 0, y: index, w: 1, h: 1 })))[0]).toMatch(/40 widgets/)
  })
})

describe('compaction', () => {
  it('moves widgets up into free rows', () => {
    expect(compact([{ x: 0, y: 5, w: 4, h: 2 }])).toEqual([{ x: 0, y: 0, w: 4, h: 2 }])
    expect(compact([{ x: 0, y: 0, w: 4, h: 2 }, { x: 0, y: 6, w: 4, h: 2 }])[1].y).toBe(2)
  })

  it('pushes overlapping widgets below a pinned one', () => {
    const layout = compact([{ x: 0, y: 0, w: 6, h: 3 }, { x: 0, y: 0, w: 6, h: 2 }], 1)
    expect(layout[1]).toEqual({ x: 0, y: 0, w: 6, h: 2 })
    expect(layout[0].y).toBe(2)
  })
})

describe('moving and resizing', () => {
  const layout: Rect[] = [
    { x: 0, y: 0, w: 4, h: 3 },
    { x: 4, y: 0, w: 4, h: 3 },
    { x: 8, y: 0, w: 4, h: 3 },
    { x: 0, y: 3, w: 8, h: 5 },
  ]

  it('keeps the dragged widget where it was dropped and re-flows the rest', () => {
    const next = moveItem(layout, 2, { x: 0, y: 0 })
    expect(next[2]).toMatchObject({ x: 0, y: 0 })
    noOverlap(next)
    expect(next[0].y).toBeGreaterThanOrEqual(3)
  })

  it('clamps drops outside the grid', () => {
    const next = moveItem(layout, 0, { x: 11, y: -4 })
    expect(next[0].x).toBe(8)
    noOverlap(next)
  })

  it('respects minimum sizes and the right edge when resizing', () => {
    const next = resizeItem(layout, 1, { w: 20, h: 1 }, { w: 3, h: 2 })
    expect(next[1]).toMatchObject({ x: 4, w: 8, h: 2 })
    noOverlap(next)
    const shrunk = resizeItem(layout, 0, { w: 1, h: 1 }, { w: 3, h: 2 })
    expect(shrunk[0]).toMatchObject({ w: 3, h: 2 })
  })

  it('shifts left only when the minimum width cannot fit', () => {
    const next = resizeItem([{ x: 10, y: 0, w: 2, h: 2 }], 0, { w: 2, h: 2 }, { w: 4, h: 2 })
    expect(next[0]).toMatchObject({ x: 8, w: 4 })
  })

  it('adds widgets at the first free spot', () => {
    expect(firstFit([{ x: 0, y: 0, w: 8, h: 3 }], { w: 4, h: 3 })).toEqual({ x: 8, y: 0 })
    const added = addItem(layout, { w: 4, h: 5 })
    expect(added.at(-1)).toMatchObject({ x: 8, y: 3 })
    noOverlap(added)
    expect(layoutHeight(added)).toBe(8)
  })

  it('removes widgets and closes the gap', () => {
    const next = removeItem(layout, 3)
    expect(next).toHaveLength(3)
    expect(layoutHeight(next)).toBe(3)
  })

  it('stacks in reading order on small screens', () => {
    expect(readingOrder([{ x: 6, y: 0, w: 6, h: 1 }, { x: 0, y: 2, w: 6, h: 1 }, { x: 0, y: 0, w: 6, h: 1 }]).map((item) => item.x + item.y * 10)).toEqual([0, 6, 20])
  })
})

describe('widget catalog', () => {
  it('filters widgets by data permission', () => {
    expect(availableWidgets(['tickets.view']).map((def) => def.name)).toEqual(['tickets_open', 'sla_breaches'])
    expect(availableWidgets(undefined)).toEqual([])
  })

  it('validates per-widget settings', () => {
    expect(configIssues('alerts_list', { limit: 0 })).toHaveProperty('limit')
    expect(configIssues('recent_jobs', { days: 120 })).toHaveProperty('days')
    expect(configIssues('custom_field_breakdown', {})).toHaveProperty('field')
    expect(configIssues('alerts_list', { limit: 25 })).toEqual({})
  })

  it('drops settings a widget does not take', () => {
    expect(cleanConfig('fleet_health', { client_id: 'c', site_id: 's', limit: 5, title: ' ' })).toEqual({ client_id: 'c', site_id: 's' })
    expect(cleanConfig('alerts_list', { site_id: 's', limit: 5 })).toEqual({ limit: 5 })
    const placement: WidgetPlacement = { widget: 'os_mix', x: 0, y: 0, w: 4, h: 3, config: { title: 'Desktops' } }
    expect(widgetTitle(placement)).toBe('Desktops')
    expect(widgetTitle({ ...placement, config: {} })).toBe('Operating systems')
  })
})
