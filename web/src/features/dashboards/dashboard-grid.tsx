/*
 * The dashboard grid: 12 columns of fixed-height rows. In edit mode widgets move by their header
 * (pointer or arrow keys) and resize from the corner (pointer or Shift + arrow keys); the others
 * re-flow around them under the server's limits. Narrow screens stack widgets in reading order.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import type { WidgetPlacement } from '@/lib/api/types'
import { GRID_COLUMNS, cellsFromPixels, layoutHeight, moveItem, pixelBox, readingOrder, resizeItem } from '@/lib/dashboards/grid'
import { widgetDef } from '@/lib/dashboards/widgets'
import { cn } from '@/lib/utils'

export const ROW_HEIGHT = 56
export const GAP = 12
/** Below this container width widgets stack in one column. */
export const STACK_BELOW = 720

interface Drag {
  index: number
  mode: 'move' | 'resize'
  pointerId: number
  startX: number
  startY: number
  dx: number
  dy: number
  origin: WidgetPlacement[]
  preview: WidgetPlacement[]
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    setWidth(node.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

export function DashboardGrid({
  layout,
  editing,
  onChange,
  renderItem,
  selected,
  onSelect,
}: {
  layout: WidgetPlacement[]
  editing: boolean
  onChange?: (layout: WidgetPlacement[]) => void
  renderItem: (item: WidgetPlacement, index: number, options: { stacked: boolean; dragging: boolean }) => ReactNode
  selected?: number | null
  onSelect?: (index: number | null) => void
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [drag, setDrag] = useState<Drag | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const stacked = width > 0 && width < STACK_BELOW
  const colWidth = Math.max(0, (width - GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS)
  const metrics = { colWidth, rowHeight: ROW_HEIGHT, gap: GAP }
  const current = drag?.preview ?? layout
  const rows = layoutHeight(current) + (editing ? 3 : 0)

  function minSize(item: WidgetPlacement) {
    return widgetDef(item.widget)?.minSize ?? { w: 1, h: 1 }
  }

  function describe(item: WidgetPlacement) {
    return `${widgetDef(item.widget)?.label ?? item.widget}: column ${item.x + 1}, row ${item.y + 1}, ${item.w} wide, ${item.h} tall`
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>, index: number) {
    if (!editing || stacked || event.button !== 0) return
    const target = event.target as HTMLElement
    const mode = target.closest('[data-resize-handle]') ? 'resize' : target.closest('[data-drag-handle]') && !target.closest('button, a, input, [role="menuitem"]') ? 'move' : null
    if (!mode) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    onSelect?.(index)
    setDrag({ index, mode, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dx: 0, dy: 0, origin: layout, preview: layout })
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag || event.pointerId !== drag.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    const cells = cellsFromPixels(dx, dy, metrics)
    const item = drag.origin[drag.index]
    const preview =
      drag.mode === 'move'
        ? moveItem(drag.origin, drag.index, { x: item.x + cells.dx, y: item.y + cells.dy })
        : resizeItem(drag.origin, drag.index, { w: item.w + cells.dx, h: item.h + cells.dy }, minSize(item))
    setDrag({ ...drag, dx, dy, preview })
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!drag || event.pointerId !== drag.pointerId) return
    const changed = JSON.stringify(drag.preview) !== JSON.stringify(drag.origin)
    if (changed) {
      onChange?.(drag.preview)
      setAnnouncement(describe(drag.preview[drag.index]))
    }
    setDrag(null)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>, index: number) {
    if (!editing || stacked || event.target !== event.currentTarget) return
    const step: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const delta = step[event.key]
    if (!delta) return
    event.preventDefault()
    const item = layout[index]
    const next = event.shiftKey
      ? resizeItem(layout, index, { w: item.w + delta[0], h: item.h + delta[1] }, minSize(item))
      : moveItem(layout, index, { x: item.x + delta[0], y: item.y + delta[1] })
    onChange?.(next)
    setAnnouncement(describe(next[index]))
  }

  if (stacked) {
    return (
      <div ref={ref} className="grid grid-cols-1 gap-3">
        {readingOrder(layout.map((item, index) => ({ ...item, index }))).map((item) => (
          <div key={item.index} style={{ height: Math.max(2, Math.min(item.h, 7)) * ROW_HEIGHT + (Math.max(2, Math.min(item.h, 7)) - 1) * GAP }} className="min-w-0">
            {renderItem(layout[item.index], item.index, { stacked: true, dragging: false })}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div ref={ref} className="relative w-full" style={{ height: Math.max(0, rows * (ROW_HEIGHT + GAP) - GAP) }} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      {editing && width > 0 && (
        <div aria-hidden className="pointer-events-none absolute inset-0 grid gap-x-3" style={{ gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))` }}>
          {Array.from({ length: GRID_COLUMNS }, (_, index) => (
            <div key={index} className="rounded-md bg-primary/[0.035] ring-1 ring-primary/10 ring-inset" />
          ))}
        </div>
      )}
      {drag && width > 0 && (
        <div aria-hidden className="pointer-events-none absolute rounded-xl border-2 border-dashed border-primary/50 bg-primary/[0.06] transition-all duration-150" style={pixelBox(drag.preview[drag.index], metrics)} />
      )}
      {width > 0 &&
        current.map((item, index) => {
          const dragging = drag?.index === index
          const box = pixelBox(dragging && drag ? drag.origin[index] : item, metrics)
          const style = dragging && drag
            ? drag.mode === 'move'
              ? { ...box, transform: `translate(${drag.dx}px, ${drag.dy}px)`, zIndex: 20 }
              : { ...box, ...pixelBox(drag.preview[index], metrics), left: box.left, top: box.top, zIndex: 20 }
            : box
          return (
            <div
              key={index}
              role={editing ? 'group' : undefined}
              aria-roledescription={editing ? 'Movable widget' : undefined}
              aria-label={editing ? `${describe(item)}. Arrow keys move, Shift and arrow keys resize.` : undefined}
              tabIndex={editing ? 0 : undefined}
              onPointerDown={(event) => onPointerDown(event, index)}
              onKeyDown={(event) => onKeyDown(event, index)}
              onFocus={() => editing && onSelect?.(index)}
              className={cn(
                'absolute min-w-0 rounded-xl outline-none',
                !dragging && 'transition-[left,top,width,height] duration-200 ease-(--ease-snappy)',
                editing && 'focus-visible:ring-2 focus-visible:ring-ring',
                editing && selected === index && 'ring-2 ring-primary/50',
                dragging && 'shadow-popover',
              )}
              style={style}
            >
              {renderItem(item, index, { stacked: false, dragging })}
              {editing && (
                <span
                  data-resize-handle
                  aria-hidden
                  className="absolute right-1 bottom-1 z-10 flex size-5 cursor-nwse-resize touch-none items-end justify-end rounded-br-lg p-0.5 text-subtle-foreground hover:text-primary"
                >
                  <svg viewBox="0 0 10 10" className="size-3">
                    <path d="M9 1v8H1M9 5v4H5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </span>
              )}
            </div>
          )
        })}
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </div>
  )
}
