import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
  type RowData,
  type SortingState,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { useDensity } from '@/lib/theme'
import { cn } from '@/lib/utils'

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    className?: string
    headerClassName?: string
    align?: 'left' | 'right' | 'center'
  }
}

export interface DataTableProps<T> {
  data: T[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: ColumnDef<T, any>[]
  getRowId?: (row: T) => string
  onRowClick?: (row: T) => void
  /** Space bar on a focused row — used for inspector quick-look. */
  onRowPeek?: (row: T) => void
  activeRowId?: string | null
  loading?: boolean
  empty?: ReactNode
  /** Virtualize rows inside a scroll container of this CSS height (e.g. "60vh"). */
  virtualHeight?: string
  onEndReached?: () => void
  initialSorting?: SortingState
  /** Controlled sorting; pair with `onSortingChange`. */
  sorting?: SortingState
  onSortingChange?: (sorting: SortingState) => void
  /** Rows arrive already sorted (e.g. folders first); the headers still toggle `sorting`. */
  manualSorting?: boolean
  /** Double-click or Enter on a row (with `onRowClick` used for selection). */
  onRowActivate?: (row: T) => void
  caption?: string
  className?: string
  /** Extra classes per row (e.g. checkbox selection highlight). */
  rowClassName?: (row: T) => string | undefined | false
}

const ROW_HEIGHT = { compact: 36, comfortable: 44 }

export function DataTable<T>({
  data,
  columns,
  getRowId,
  onRowClick,
  onRowPeek,
  activeRowId,
  loading = false,
  empty,
  virtualHeight,
  onEndReached,
  initialSorting = [],
  sorting: controlledSorting,
  onSortingChange,
  manualSorting = false,
  onRowActivate,
  caption,
  className,
  rowClassName,
}: DataTableProps<T>) {
  const [internalSorting, setSorting] = useState<SortingState>(initialSorting)
  const sorting = controlledSorting ?? internalSorting
  const { density } = useDensity()
  const scrollRef = useRef<HTMLDivElement>(null)

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(sorting) : updater
      if (onSortingChange) onSortingChange(next)
      else setSorting(next)
    },
    manualSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: manualSorting ? undefined : getSortedRowModel(),
    getRowId: getRowId ? (row) => getRowId(row) : undefined,
  })

  const rows = table.getRowModel().rows
  const virtual = Boolean(virtualHeight)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT[density],
    overscan: 12,
    enabled: virtual,
  })

  const virtualItems = virtual ? virtualizer.getVirtualItems() : []
  const lastIndex = virtualItems.at(-1)?.index ?? -1

  useEffect(() => {
    if (virtual && onEndReached && rows.length > 0 && lastIndex >= rows.length - 8) onEndReached()
  }, [virtual, onEndReached, rows.length, lastIndex])

  const paddingTop = virtual && virtualItems.length > 0 ? virtualItems[0].start : 0
  const paddingBottom =
    virtual && virtualItems.length > 0 ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end : 0

  const renderedRows: Row<T>[] = virtual ? virtualItems.map((item) => rows[item.index]) : rows
  const columnCount = table.getVisibleLeafColumns().length

  function onRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, row: Row<T>) {
    if (event.key === 'Enter' && (onRowActivate || onRowClick)) {
      event.preventDefault()
      if (onRowActivate) onRowActivate(row.original)
      else onRowClick?.(row.original)
    } else if (event.key === ' ' && onRowPeek) {
      event.preventDefault()
      onRowPeek(row.original)
    } else if (event.key === 'ArrowDown' || event.key === 'j') {
      event.preventDefault()
      ;(event.currentTarget.nextElementSibling as HTMLElement | null)?.focus()
    } else if (event.key === 'ArrowUp' || event.key === 'k') {
      event.preventDefault()
      ;(event.currentTarget.previousElementSibling as HTMLElement | null)?.focus()
    }
  }

  return (
    <div
      ref={scrollRef}
      className={cn(
        'relative w-full overflow-auto rounded-xl bg-card shadow-card',
        virtual && 'overscroll-contain',
        className,
      )}
      style={virtual ? { height: virtualHeight } : undefined}
    >
      <table className="font-condensed w-full border-separate border-spacing-0 text-dense">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="sticky top-0 z-10">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => {
                const sortable = header.column.getCanSort()
                const sorted = header.column.getIsSorted()
                const meta = header.column.columnDef.meta
                return (
                  <th
                    key={header.id}
                    scope="col"
                    aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                    className={cn(
                      'h-9 border-b border-border bg-surface-2/95 px-3 text-left text-micro font-semibold tracking-[0.06em] whitespace-nowrap text-subtle-foreground uppercase backdrop-blur first:pl-4 last:pr-4',
                      meta?.align === 'right' && 'text-right',
                      meta?.align === 'center' && 'text-center',
                      meta?.headerClassName,
                    )}
                    style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}
                  >
                    {header.isPlaceholder ? null : sortable ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-sm uppercase outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
                          sorted && 'text-foreground',
                        )}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sorted === 'asc' ? (
                          <ArrowUp className="size-3" />
                        ) : sorted === 'desc' ? (
                          <ArrowDown className="size-3" />
                        ) : (
                          <ChevronsUpDown className="size-3 opacity-40" />
                        )}
                      </button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </th>
                )
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {loading &&
            Array.from({ length: 6 }, (_, index) => (
              <tr key={`skeleton-${index}`} style={{ height: ROW_HEIGHT[density] }}>
                {Array.from({ length: columnCount }, (_, cell) => (
                  <td key={cell} className="border-b border-border px-3 first:pl-4 last:pr-4">
                    <Skeleton className={cn('h-3.5', cell === 0 ? 'w-40' : 'w-20')} />
                  </td>
                ))}
              </tr>
            ))}

          {!loading && rows.length === 0 && (
            <tr>
              <td colSpan={columnCount} className="p-0">
                {empty ?? <div className="px-4 py-12 text-center text-muted-foreground">No results</div>}
              </td>
            </tr>
          )}

          {!loading && paddingTop > 0 && (
            <tr aria-hidden="true">
              <td colSpan={columnCount} style={{ height: paddingTop, padding: 0 }} />
            </tr>
          )}

          {!loading &&
            renderedRows.map((row) => {
              const interactive = Boolean(onRowClick || onRowPeek || onRowActivate)
              const active = activeRowId != null && row.id === activeRowId
              return (
                <tr
                  key={row.id}
                  data-index={row.index}
                  tabIndex={interactive ? 0 : undefined}
                  aria-selected={active || undefined}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  onDoubleClick={onRowActivate ? () => onRowActivate(row.original) : undefined}
                  onKeyDown={interactive ? (event) => onRowKeyDown(event, row) : undefined}
                  className={cn(
                    'group/row transition-colors outline-none',
                    interactive && 'cursor-pointer hover:bg-surface-3/60 focus-visible:bg-surface-3/80',
                    active && 'bg-primary/[0.07] hover:bg-primary/10',
                    rowClassName?.(row.original),
                  )}
                  style={{ height: ROW_HEIGHT[density] }}
                >
                  {row.getVisibleCells().map((cell, index) => {
                    const meta = cell.column.columnDef.meta
                    return (
                      <td
                        key={cell.id}
                        className={cn(
                          'border-b border-border px-3 whitespace-nowrap first:pl-4 last:pr-4 group-last/row:border-b-0',
                          index === 0 && active && 'shadow-[inset_2px_0_0_var(--primary)]',
                          meta?.align === 'right' && 'text-right',
                          meta?.align === 'center' && 'text-center',
                          meta?.className,
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    )
                  })}
                </tr>
              )
            })}

          {!loading && paddingBottom > 0 && (
            <tr aria-hidden="true">
              <td colSpan={columnCount} style={{ height: paddingBottom, padding: 0 }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
