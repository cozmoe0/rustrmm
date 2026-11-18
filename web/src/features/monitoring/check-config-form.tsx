/* The configuration form for one check, generated from its type's `config_schema`. */
import { useQuery } from '@tanstack/react-query'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SimpleSelect } from '@/components/common/simple-select'
import { scriptQuery } from '@/lib/api/queries'
import type { CheckTypeDefinition, ParameterValue } from '@/lib/api/types'
import { defaultParameterValues, toApiParameters, validateParameterValues } from '@/lib/automation/params'
import {
  buildForm,
  SCRIPT_PARAMETERS_KEY,
  setConfigValue,
  validateCheckConfig,
  type CheckConfig,
  type GeneratedField,
} from '@/lib/monitoring/check-schema'
import { cn } from '@/lib/utils'
import { ListInput } from '@/features/automation/list-input'
import { ParameterForm } from '@/features/automation/parameter-form'
import { ScriptPicker } from '@/features/automation/run-dialog'

const MONO_KEYS = new Set(['url', 'path', 'store', 'volume', 'host', 'target', 'log', 'source'])

function FieldKey({ name }: { name: string }) {
  return <span className="ml-auto font-mono text-[10.5px] font-normal text-subtle-foreground">{name}</span>
}

function display(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
}

function ScriptField({
  field,
  config,
  onChange,
  error,
  readOnly,
  idPrefix,
}: {
  field: GeneratedField
  config: CheckConfig
  onChange: (config: CheckConfig) => void
  error?: string
  readOnly: boolean
  idPrefix: string
}) {
  const scriptId = typeof config[field.key] === 'string' ? (config[field.key] as string) : ''
  const { data: script } = useQuery({ ...scriptQuery(scriptId), enabled: Boolean(scriptId) })
  const stored = config[SCRIPT_PARAMETERS_KEY]
  const current = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, ParameterValue>) : {}
  const values = { ...(script ? defaultParameterValues(script.parameters) : {}), ...current }
  const paramErrors = script ? validateParameterValues(script.parameters, values) : {}
  return (
    <div className="grid grid-cols-1 gap-3 sm:col-span-2">
      <Field data-invalid={Boolean(error) || undefined}>
        <FieldLabel className="flex w-full items-baseline gap-1.5">
          <span>{field.label}</span>
          <span className="text-critical" aria-hidden="true">
            *
          </span>
          <FieldKey name={field.key} />
        </FieldLabel>
        {readOnly ? (
          <div className="rounded-lg bg-surface-2 px-3 py-2 text-dense ring-1 ring-border">{script?.name ?? 'No script chosen'}</div>
        ) : (
          <ScriptPicker value={scriptId || null} onChange={(id) => onChange(setConfigValue(config, field, id))} />
        )}
        {error ? (
          <FieldError>{error}</FieldError>
        ) : (
          <FieldDescription>Exit code 0 is OK, 1 warning, 2 or anything else critical; the last line of output becomes the message.</FieldDescription>
        )}
      </Field>
      {script && (
        <div className="grid grid-cols-1 gap-2 rounded-lg bg-surface-2/60 p-3 ring-1 ring-border">
          <div className="text-micro font-medium text-muted-foreground">Script parameters</div>
          <ParameterForm
            parameters={script.parameters.filter((param) => param.type !== 'secret')}
            values={values}
            errors={paramErrors}
            disabled={readOnly}
            idPrefix={`${idPrefix}-param`}
            onChange={(name, value) =>
              onChange({ ...config, [SCRIPT_PARAMETERS_KEY]: toApiParameters(script.parameters, { ...values, [name]: value }) })
            }
          />
          {script.parameters.some((param) => param.type === 'secret') && (
            <p className="text-micro text-subtle-foreground">
              Secret parameters can’t be stored in a policy; they come from secret variables with the same name.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Renders every field of a check type's schema: numbers with units and ranges, text, switches, selects,
 * lists and the script picker. Errors combine local validation with the server's (`config.<key>`).
 */
export function CheckConfigForm({
  definition,
  config,
  onChange,
  serverErrors = {},
  readOnly = false,
  idPrefix,
}: {
  definition: CheckTypeDefinition
  config: CheckConfig
  onChange: (config: CheckConfig) => void
  serverErrors?: Record<string, string>
  readOnly?: boolean
  idPrefix: string
}) {
  const fields = buildForm(definition.config_schema, config)
  const errors = { ...serverErrors, ...validateCheckConfig(definition, config) }
  if (fields.length === 0) {
    return (
      <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-dense text-muted-foreground ring-1 ring-border">
        This check has no settings: {definition.description.charAt(0).toLowerCase() + definition.description.slice(1)}
      </p>
    )
  }
  const set = (field: GeneratedField, raw: unknown) => onChange(setConfigValue(config, field, raw))
  return (
    <fieldset disabled={readOnly} className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
      {fields.map((field) => {
        const id = `${idPrefix}-${field.key}`
        const error = errors[field.key]
        if (field.type === 'script')
          return (
            <ScriptField key={field.key} field={field} config={config} onChange={onChange} error={error} readOnly={readOnly} idPrefix={idPrefix} />
          )
        if (field.type === 'boolean') {
          return (
            <Field key={field.key} className="rounded-lg px-3 py-2.5 ring-1 ring-border sm:self-end" data-invalid={Boolean(error) || undefined}>
              <label htmlFor={id} className="flex items-center justify-between gap-3 text-dense">
                <span className="min-w-0 font-medium">{field.label}</span>
                <Switch id={id} checked={field.value === true} disabled={readOnly} onCheckedChange={(checked) => set(field, checked)} />
              </label>
              <FieldError>{error}</FieldError>
            </Field>
          )
        }
        const label = (
          <FieldLabel htmlFor={id} className="flex w-full items-baseline gap-1.5">
            <span>{field.label}</span>
            {field.required && (
              <span className="text-critical" aria-hidden="true">
                *
              </span>
            )}
            <FieldKey name={field.key} />
          </FieldLabel>
        )
        const own = config[field.key]
        return (
          <Field key={field.key} data-invalid={Boolean(error) || undefined}>
            {label}
            {field.type === 'select' ? (
              <SimpleSelect
                id={id}
                value={field.value === null || field.value === undefined ? null : String(field.value)}
                onValueChange={(value) => set(field, value)}
                options={field.options ?? []}
                disabled={readOnly}
                ariaInvalid={Boolean(error)}
              />
            ) : field.type === 'string_list' || field.type === 'number_list' ? (
              <ListInput
                id={id}
                ariaLabel={field.label}
                value={Array.isArray(own) ? own.map(String) : []}
                onChange={(items) => set(field, items)}
                placeholder={field.type === 'number_list' ? 'Type a number and press Enter' : 'Type and press Enter'}
                mono={field.type === 'number_list'}
                invalid={Boolean(error)}
                disabled={readOnly}
              />
            ) : (
              <div className="relative">
                <Input
                  id={id}
                  type={field.type === 'number' ? 'number' : 'text'}
                  inputMode={field.type === 'number' ? 'decimal' : undefined}
                  min={field.min}
                  max={field.max}
                  spellCheck={false}
                  className={cn(field.type === 'number' && 'tabular', field.unit && 'pr-14', MONO_KEYS.has(field.key) && 'font-mono text-[12.5px]')}
                  value={display(own)}
                  placeholder={field.value !== null && field.value !== undefined && own === undefined ? `${display(field.value)} (default)` : undefined}
                  aria-invalid={Boolean(error) || undefined}
                  onChange={(event) => set(field, event.target.value)}
                />
                {field.unit && (
                  <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-micro text-subtle-foreground">
                    {field.unit}
                  </span>
                )}
              </div>
            )}
            {error ? <FieldError>{error}</FieldError> : field.hint ? <FieldDescription>{field.hint}</FieldDescription> : null}
          </Field>
        )
      })}
    </fieldset>
  )
}
