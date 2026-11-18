/* The card around a dashboard widget: title, scope chip and (while editing) the move handle and controls. */
import { useQuery } from '@tanstack/react-query'
import { GripVertical, Settings2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { clientsQuery } from '@/lib/api/queries'
import type { WidgetPlacement } from '@/lib/api/types'
import { widgetDef, widgetTitle } from '@/lib/dashboards/widgets'
import { hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { WidgetBody } from './widgets'

export function WidgetFrame({
  item,
  editing,
  onConfigure,
  onRemove,
}: {
  item: WidgetPlacement
  editing: boolean
  onConfigure?: () => void
  onRemove?: () => void
}) {
  const me = useMe()
  const def = widgetDef(item.widget)
  const { data: clients = [] } = useQuery({ ...clientsQuery(), enabled: Boolean(item.config.client_id), meta: { silent: true } })
  const client = item.config.client_id ? clients.find((entry) => entry.id === item.config.client_id) : undefined
  const allowed = !def || hasPermission(me, def.permission)

  return (
    <section aria-label={widgetTitle(item)} className={cn('flex h-full min-h-0 flex-col overflow-hidden rounded-xl bg-card shadow-card', editing && 'ring-1 ring-border-strong')}>
      <header data-drag-handle={editing || undefined} className={cn('flex h-10 shrink-0 items-center gap-1.5 border-b border-border pr-1.5 pl-3', editing && 'cursor-grab touch-none bg-surface-2/60 active:cursor-grabbing')}>
        {editing && <GripVertical aria-hidden className="-ml-1 size-3.5 shrink-0 text-subtle-foreground" />}
        <h2 className="min-w-0 flex-1 truncate text-dense font-semibold">{widgetTitle(item)}</h2>
        {client && <span className="max-w-[45%] truncate rounded-[5px] bg-surface-3 px-1.5 py-px text-[10.5px] text-muted-foreground ring-1 ring-border">{client.name}</span>}
        {editing && (
          <>
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`Configure ${widgetTitle(item)}`} onClick={onConfigure} />}>
                <Settings2 />
              </TooltipTrigger>
              <TooltipContent>Settings</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`Remove ${widgetTitle(item)}`} className="hover:text-critical" onClick={onRemove} />}>
                <X />
              </TooltipTrigger>
              <TooltipContent>Remove</TooltipContent>
            </Tooltip>
          </>
        )}
      </header>
      <div className={cn('min-h-0 flex-1', editing && 'pointer-events-none select-none')}>
        {allowed ? (
          <WidgetBody widget={item.widget} config={item.config} size={{ w: item.w, h: item.h }} />
        ) : (
          <p className="px-4 py-5 text-dense text-muted-foreground">This widget needs a permission you don’t hold.</p>
        )}
      </div>
    </section>
  )
}
