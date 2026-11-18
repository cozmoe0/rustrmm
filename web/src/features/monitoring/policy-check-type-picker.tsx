/* The "Add check" dialog: a searchable grid of check types from the catalog. */
import { useState } from 'react'
import { Gauge, Search } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import type { CheckTypeDefinition } from '@/lib/api/types'
import { cn } from '@/lib/utils'
import { PlatformIcons } from '@/features/automation/automation-ui'
import { CheckTypeTile } from './monitoring-ui'

export function CheckTypePicker({
  open,
  onOpenChange,
  catalog,
  loading,
  usedTypes,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  catalog: CheckTypeDefinition[]
  loading: boolean
  usedTypes: string[]
  onPick: (definition: CheckTypeDefinition) => void
}) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const visible = catalog.filter(
    (item) => !needle || `${item.label} ${item.type} ${item.description}`.toLowerCase().includes(needle),
  )
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery('')
        onOpenChange(next)
      }}
    >
      <DialogContent className="gap-0 p-0 sm:max-w-[720px]">
        <DialogHeader className="border-b border-border px-5 pt-5 pb-4">
          <DialogTitle>Add a check</DialogTitle>
          <DialogDescription>Checks run on the agent at their interval; thresholds are evaluated on the device.</DialogDescription>
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search check types…"
              aria-label="Search check types"
              className="pl-8"
            />
          </div>
        </DialogHeader>
        <div className="max-h-[min(60vh,520px)] overflow-y-auto p-3">
          {loading ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} className="h-[84px] rounded-lg" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <p className="px-3 py-10 text-center text-dense text-muted-foreground">No check type matches “{query}”.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {visible.map((item) => {
                const used = usedTypes.filter((type) => type === item.type).length
                return (
                  <li key={item.type}>
                    <button
                      type="button"
                      onClick={() => {
                        onPick(item)
                        setQuery('')
                      }}
                      className={cn(
                        'group flex h-full w-full items-start gap-3 rounded-lg bg-card p-3 text-left shadow-card outline-none transition-colors',
                        'hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring',
                      )}
                    >
                      <CheckTypeTile type={item.type} className="group-hover:text-foreground" />
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-dense font-medium">{item.label}</span>
                          {used > 0 && (
                            <span className="tabular shrink-0 rounded-full bg-surface-3 px-1.5 text-[10px] text-muted-foreground">
                              {used} in policy
                            </span>
                          )}
                        </span>
                        <span className="line-clamp-2 text-micro text-muted-foreground">{item.description}</span>
                        <span className="mt-1 flex items-center gap-2 text-[10.5px] text-subtle-foreground">
                          <PlatformIcons platforms={item.platforms} />
                          <span aria-hidden="true">·</span>
                          {item.graded ? (
                            <span className="inline-flex items-center gap-1">
                              <Gauge className="size-3" />
                              Warning and critical thresholds
                            </span>
                          ) : (
                            <span>Uses the check’s severity</span>
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
