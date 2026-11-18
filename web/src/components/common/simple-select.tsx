import type { ReactNode } from 'react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

export interface SelectOption {
  value: string
  label: string
  description?: string
  icon?: ReactNode
  group?: string
  disabled?: boolean
}

/** Base UI treats an empty string as "no value"; options with value '' ("Any", "None") use this internally instead. */
const EMPTY = '__simple-select-empty__'
const toInner = (value: string) => (value === '' ? EMPTY : value)
const toOuter = (value: string) => (value === EMPTY ? '' : value)

/** A value/label select over Base UI's Select with grouping support. */
export function SimpleSelect({
  value,
  onValueChange,
  options,
  placeholder = 'Select…',
  className,
  size = 'default',
  disabled,
  id,
  ariaLabel,
  ariaInvalid,
}: {
  value: string | null
  onValueChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  className?: string
  size?: 'sm' | 'default'
  disabled?: boolean
  id?: string
  ariaLabel?: string
  ariaInvalid?: boolean
}) {
  const items = options.map((option) => ({ value: toInner(option.value), label: option.label }))
  const groups = new Map<string, SelectOption[]>()
  for (const option of options) {
    const key = option.group ?? ''
    groups.set(key, [...(groups.get(key) ?? []), option])
  }

  return (
    <Select
      items={items}
      value={value === null || (value === '' && !options.some((option) => option.value === '')) ? null : toInner(value)}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === 'string') onValueChange(toOuter(next))
      }}
    >
      <SelectTrigger
        id={id}
        size={size}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid || undefined}
        className={cn('w-full', className)}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {[...groups.entries()].map(([group, groupOptions]) => (
          <SelectGroup key={group || 'default'}>
            {group && <SelectLabel>{group}</SelectLabel>}
            {groupOptions.map((option) => (
              <SelectItem key={option.value} value={toInner(option.value)} disabled={option.disabled}>
                {option.icon}
                <span className="truncate">{option.label}</span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}
