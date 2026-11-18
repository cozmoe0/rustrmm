import { KeyRound } from 'lucide-react'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SimpleSelect } from '@/components/common/simple-select'
import type { ParameterValue, ScriptParameter } from '@/lib/api/types'
import { cn } from '@/lib/utils'

/** The run form generated from a script's typed parameters. */
export function ParameterForm({
  parameters,
  values,
  onChange,
  errors = {},
  disabled = false,
  idPrefix = 'param',
  columns = 2,
}: {
  parameters: ScriptParameter[]
  values: Record<string, ParameterValue | undefined>
  onChange: (name: string, value: ParameterValue) => void
  errors?: Record<string, string>
  disabled?: boolean
  idPrefix?: string
  columns?: 1 | 2
}) {
  if (parameters.length === 0) {
    return (
      <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-dense text-muted-foreground ring-1 ring-border">
        This script takes no parameters.
      </p>
    )
  }
  return (
    <div className={cn('grid gap-x-4 gap-y-3.5', columns === 2 && 'sm:grid-cols-2')}>
      {parameters.map((param) => {
        const id = `${idPrefix}-${param.name}`
        const error = errors[param.name]
        const value = values[param.name]
        const label = (
          <FieldLabel htmlFor={id} className="flex items-baseline gap-1.5">
            <span>{param.label || param.name}</span>
            {param.required && param.type !== 'boolean' && (
              <span className="text-critical" aria-hidden="true">
                *
              </span>
            )}
            <span className="ml-auto font-mono text-[10.5px] font-normal text-subtle-foreground">${param.name}</span>
          </FieldLabel>
        )
        if (param.type === 'boolean') {
          return (
            <Field
              key={param.name}
              className={cn(
                'rounded-lg px-3 py-2.5 ring-1 ring-border',
                columns === 2 && parameters.length % 2 === 1 && 'sm:col-span-1',
              )}
            >
              <label htmlFor={id} className="flex items-center justify-between gap-3 text-dense">
                <span className="min-w-0">
                  <span className="font-medium">{param.label || param.name}</span>
                  {param.description && (
                    <span className="block text-micro text-muted-foreground">{param.description}</span>
                  )}
                </span>
                <Switch
                  id={id}
                  checked={value === true || value === 'true'}
                  disabled={disabled}
                  onCheckedChange={(checked) => onChange(param.name, checked)}
                />
              </label>
            </Field>
          )
        }
        return (
          <Field key={param.name} data-invalid={Boolean(error) || undefined}>
            {label}
            {param.type === 'select' ? (
              <SimpleSelect
                id={id}
                value={value === null || value === undefined || value === '' ? null : String(value)}
                onValueChange={(next) => onChange(param.name, next)}
                options={(param.options ?? []).map((option) => ({ value: option, label: option }))}
                placeholder="Choose…"
                disabled={disabled}
                ariaInvalid={Boolean(error)}
              />
            ) : param.type === 'secret' ? (
              <div className="relative">
                <KeyRound className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle-foreground" />
                <Input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  className="pl-8 font-mono"
                  value={value === null || value === undefined ? '' : String(value)}
                  disabled={disabled}
                  aria-invalid={Boolean(error) || undefined}
                  placeholder="Masked in output and logs"
                  onChange={(event) => onChange(param.name, event.target.value)}
                />
              </div>
            ) : (
              <Input
                id={id}
                type={param.type === 'number' ? 'number' : 'text'}
                inputMode={param.type === 'number' ? 'decimal' : undefined}
                className={cn(param.type === 'number' && 'tabular')}
                value={value === null || value === undefined ? '' : String(value)}
                disabled={disabled}
                aria-invalid={Boolean(error) || undefined}
                placeholder={param.default !== null && param.default !== '' ? String(param.default) : undefined}
                onChange={(event) => onChange(param.name, event.target.value)}
              />
            )}
            {param.description && !error && <FieldDescription>{param.description}</FieldDescription>}
            <FieldError>{error}</FieldError>
          </Field>
        )
      })}
    </div>
  )
}
