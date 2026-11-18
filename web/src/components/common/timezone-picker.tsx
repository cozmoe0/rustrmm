import { useMemo, useState } from 'react'
import { Check, ChevronsUpDown, Globe } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

function allTimezones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }
  const zones = intl.supportedValuesOf?.('timeZone') ?? []
  return zones.includes('UTC') ? zones : ['UTC', ...zones]
}

function offsetLabel(zone: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(new Date())
      .find((item) => item.type === 'timeZoneName')
    return part?.value.replace('GMT', 'UTC') ?? ''
  } catch {
    return ''
  }
}

export function TimezonePicker({
  value,
  onChange,
  id,
  className,
}: {
  value: string
  onChange: (zone: string) => void
  id?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const zones = useMemo(() => allTimezones(), [])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className={cn('w-full justify-between font-normal', className)}
          />
        }
      >
        <span className="flex min-w-0 items-center gap-2">
          <Globe className="text-muted-foreground" />
          <span className="truncate">{value || 'Select time zone'}</span>
          {value && <span className="text-micro text-subtle-foreground">{offsetLabel(value)}</span>}
        </span>
        <ChevronsUpDown className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className="w-(--anchor-width) min-w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search time zones…" />
          <CommandList className="max-h-72">
            <CommandEmpty>No time zone found.</CommandEmpty>
            <CommandGroup>
              {zones.map((zone) => (
                <CommandItem
                  key={zone}
                  value={zone}
                  onSelect={() => {
                    onChange(zone)
                    setOpen(false)
                  }}
                >
                  <Check className={cn('size-3.5', zone === value ? 'opacity-100' : 'opacity-0')} />
                  <span className="truncate">{zone.replace(/_/g, ' ')}</span>
                  <span className="ml-auto text-micro text-subtle-foreground">{offsetLabel(zone)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
