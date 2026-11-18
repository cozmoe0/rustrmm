/*
 * The dashboard grid: 12 columns, rows of fixed height, and the server's limits
 * (0 ≤ x, 1 ≤ w, x + w ≤ 12, 0 ≤ y ≤ 1000, 1 ≤ h ≤ 24, at most 40 widgets, config ≤ 4 KB).
 * Moves and resizes keep the dragged widget where the user put it and compact the others upwards
 * around it, so layouts never overlap and never leave holes at the top.
 */

export const GRID_COLUMNS = 12
export const MAX_Y = 1000
export const MAX_H = 24
export const MAX_WIDGETS = 40
export const CONFIG_MAX_BYTES = 4096

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Size {
  w: number
  h: number
}

const int = (value: number, fallback: number) => (Number.isFinite(value) ? Math.round(value) : fallback)

/** Clamps a rectangle into the grid (and to a minimum size, never larger than the grid allows). */
export function clampRect(rect: Rect, min: Size = { w: 1, h: 1 }): Rect {
  const minW = Math.min(GRID_COLUMNS, Math.max(1, min.w))
  const minH = Math.min(MAX_H, Math.max(1, min.h))
  const w = Math.min(GRID_COLUMNS, Math.max(minW, int(rect.w, minW)))
  const h = Math.min(MAX_H, Math.max(minH, int(rect.h, minH)))
  const x = Math.min(GRID_COLUMNS - w, Math.max(0, int(rect.x, 0)))
  const y = Math.min(MAX_Y, Math.max(0, int(rect.y, 0)))
  return { x, y, w, h }
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

function collision(rect: Rect, placed: readonly Rect[]): Rect | undefined {
  return placed.find((other) => overlaps(rect, other))
}

/** The number of rows a layout uses. */
export function layoutHeight(layout: readonly Rect[]): number {
  return layout.reduce((max, item) => Math.max(max, item.y + item.h), 0)
}

/** Reading order (top to bottom, then left to right): the order widgets stack on small screens. */
export function readingOrder<T extends Rect>(layout: readonly T[]): T[] {
  return [...layout].sort((a, b) => a.y - b.y || a.x - b.x)
}

/**
 * Vertical compaction. Every widget moves up as far as it can; a `pinned` widget is placed first and
 * keeps its position, and anything it lands on is pushed below it.
 */
export function compact<T extends Rect>(layout: readonly T[], pinned?: number): T[] {
  const result: T[] = layout.map((item) => ({ ...item }))
  const placed: Rect[] = []
  if (pinned !== undefined && result[pinned]) placed.push(result[pinned])
  const order = result
    .map((item, index) => ({ item, index }))
    .filter((entry) => entry.index !== pinned)
    .sort((a, b) => a.item.y - b.item.y || a.item.x - b.item.x || a.index - b.index)
  for (const { item } of order) {
    let y = Math.max(0, item.y)
    while (y > 0 && !collision({ ...item, y: y - 1 }, placed)) y -= 1
    let hit = collision({ ...item, y }, placed)
    while (hit) {
      y = hit.y + hit.h
      hit = collision({ ...item, y }, placed)
    }
    item.y = y
    placed.push(item)
  }
  return result
}

/** Moves one widget to a cell (clamped) and re-flows the others around it. */
export function moveItem<T extends Rect>(layout: readonly T[], index: number, to: { x: number; y: number }): T[] {
  const item = layout[index]
  if (!item) return [...layout]
  const next = layout.map((entry, position) => (position === index ? { ...entry, ...clampRect({ ...entry, x: to.x, y: to.y }, { w: entry.w, h: entry.h }) } : entry))
  return compact(next, index)
}

/** Resizes one widget (clamped to its minimum and the grid) and re-flows the others. */
export function resizeItem<T extends Rect>(layout: readonly T[], index: number, size: Size, min: Size = { w: 1, h: 1 }): T[] {
  const item = layout[index]
  if (!item) return [...layout]
  const minW = Math.min(GRID_COLUMNS, Math.max(1, min.w))
  let w = Math.min(GRID_COLUMNS, Math.max(minW, int(size.w, item.w)))
  let x = item.x
  if (x + w > GRID_COLUMNS) {
    // Stop at the right edge; only shift left when the minimum width would not fit.
    w = Math.max(minW, GRID_COLUMNS - x)
    x = Math.min(x, GRID_COLUMNS - w)
  }
  const rect = clampRect({ x, y: item.y, w, h: size.h }, { w: minW, h: min.h })
  const next = layout.map((entry, position) => (position === index ? { ...entry, ...rect } : entry))
  return compact(next, index)
}

/** The first free spot (top to bottom, left to right) for a widget of this size. */
export function firstFit(layout: readonly Rect[], size: Size): { x: number; y: number } {
  const w = Math.min(GRID_COLUMNS, Math.max(1, size.w))
  const h = Math.min(MAX_H, Math.max(1, size.h))
  const height = layoutHeight(layout)
  for (let y = 0; y <= height; y += 1) {
    for (let x = 0; x + w <= GRID_COLUMNS; x += 1) {
      if (!collision({ x, y, w, h }, layout)) return { x, y }
    }
  }
  return { x: 0, y: height }
}

/** Appends a widget at its first free spot. */
export function addItem<T extends Rect>(layout: readonly T[], item: Omit<T, 'x' | 'y'> & Partial<Rect>): T[] {
  const size = { w: item.w, h: item.h }
  const spot = firstFit(layout, size)
  const added = { ...item, ...clampRect({ ...spot, ...size }) } as T
  return compact([...layout, added])
}

export function removeItem<T extends Rect>(layout: readonly T[], index: number): T[] {
  return compact(layout.filter((_, position) => position !== index))
}

/** The byte length of a widget config as the server measures it (UTF-8 JSON). */
export function configBytes(config: unknown): number {
  return new TextEncoder().encode(JSON.stringify(config ?? {})).length
}

/** Problems the server would refuse, as readable sentences. */
export function layoutIssues(layout: readonly (Rect & { config?: unknown; widget?: string })[]): string[] {
  const issues: string[] = []
  if (layout.length > MAX_WIDGETS) issues.push(`A dashboard holds at most ${MAX_WIDGETS} widgets`)
  layout.forEach((item, index) => {
    const label = item.widget ? `${item.widget} (#${index + 1})` : `Widget #${index + 1}`
    if (!Number.isInteger(item.x) || !Number.isInteger(item.y) || !Number.isInteger(item.w) || !Number.isInteger(item.h)) issues.push(`${label} is not on the grid`)
    if (item.x < 0 || item.w < 1 || item.x + item.w > GRID_COLUMNS) issues.push(`${label} is wider than the 12-column grid`)
    if (item.y < 0 || item.y > MAX_Y) issues.push(`${label} is placed below row ${MAX_Y}`)
    if (item.h < 1 || item.h > MAX_H) issues.push(`${label} must be 1–${MAX_H} rows tall`)
    if (configBytes(item.config) > CONFIG_MAX_BYTES) issues.push(`${label} has more than 4 KB of settings`)
  })
  for (let a = 0; a < layout.length; a += 1) {
    for (let b = a + 1; b < layout.length; b += 1) {
      if (overlaps(layout[a], layout[b])) {
        issues.push(`Widgets #${a + 1} and #${b + 1} overlap`)
        return issues
      }
    }
  }
  return issues
}

/** Converts a pointer offset (px) into grid cells for the current column width and row pitch. */
export function cellsFromPixels(dx: number, dy: number, metrics: { colWidth: number; rowHeight: number; gap: number }): { dx: number; dy: number } {
  return {
    dx: Math.round(dx / (metrics.colWidth + metrics.gap)),
    dy: Math.round(dy / (metrics.rowHeight + metrics.gap)),
  }
}

/** A rectangle's pixel box inside the grid. */
export function pixelBox(rect: Rect, metrics: { colWidth: number; rowHeight: number; gap: number }) {
  return {
    left: rect.x * (metrics.colWidth + metrics.gap),
    top: rect.y * (metrics.rowHeight + metrics.gap),
    width: rect.w * metrics.colWidth + (rect.w - 1) * metrics.gap,
    height: rect.h * metrics.rowHeight + (rect.h - 1) * metrics.gap,
  }
}
