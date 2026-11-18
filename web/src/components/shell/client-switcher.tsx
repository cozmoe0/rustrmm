import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronsUpDown, Layers } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { EntityAvatar } from '@/components/common/misc'
import { SimpleSelect } from '@/components/common/simple-select'
import { clientsQuery, sitesQuery } from '@/lib/api/queries'
import { useScope } from '@/lib/scope'
import { cn } from '@/lib/utils'

export function ClientSwitcher({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const { clientId, setClient } = useScope()
  const { data: clients = [] } = useQuery(clientsQuery())
  const current = clients.find((client) => client.id === clientId)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Switch client"
            className={cn(
              'flex h-8 max-w-[240px] min-w-0 items-center gap-2 rounded-lg px-1.5 pr-2 text-sm outline-none transition-colors hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-surface-3',
              className,
            )}
          />
        }
      >
        {current ? (
          <EntityAvatar name={current.name} seed={current.id} accent={current.accent_color} size="sm" />
        ) : (
          <span className="flex size-6 items-center justify-center rounded-md bg-surface-3 text-muted-foreground ring-1 ring-border">
            <Layers className="size-3.5" />
          </span>
        )}
        <span className="truncate font-medium">{current?.name ?? 'All clients'}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-subtle-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Find a client…" />
          <CommandList className="max-h-80">
            <CommandEmpty>No clients match.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__all__ All clients"
                onSelect={() => {
                  setClient(null)
                  setOpen(false)
                }}
              >
                <span className="flex size-5 items-center justify-center rounded-[5px] bg-surface-3 text-muted-foreground">
                  <Layers className="size-3" />
                </span>
                All clients
                <Check className={cn('ml-auto size-3.5', !clientId ? 'opacity-100' : 'opacity-0')} />
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading={`Clients · ${clients.length}`}>
              {clients.map((client) => (
                <CommandItem
                  key={client.id}
                  value={`${client.name} ${client.slug}`}
                  onSelect={() => {
                    setClient(client.id)
                    setOpen(false)
                  }}
                >
                  <EntityAvatar name={client.name} seed={client.id} accent={client.accent_color} size="xs" />
                  <span className="truncate">{client.name}</span>
                  <span className="ml-auto text-micro text-subtle-foreground tabular">{client.device_count}</span>
                  <Check className={cn('size-3.5', client.id === clientId ? 'opacity-100' : 'opacity-0')} />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function SiteFilter({ className }: { className?: string }) {
  const { clientId, siteId, setSite } = useScope()
  const { data: sites = [] } = useQuery({ ...sitesQuery(clientId), enabled: Boolean(clientId) })
  if (!clientId) return null

  return (
    <SimpleSelect
      size="sm"
      ariaLabel="Filter by site"
      className={cn('h-8 w-44 border-transparent bg-transparent shadow-none hover:bg-surface-3 dark:bg-transparent', className)}
      value={siteId ?? '__all__'}
      onValueChange={(value) => setSite(value === '__all__' ? null : value)}
      options={[
        { value: '__all__', label: 'All sites' },
        ...sites.map((site) => ({ value: site.id, label: site.name })),
      ]}
    />
  )
}
