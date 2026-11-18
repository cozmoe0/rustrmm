import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { EmptyState } from '@/components/common/empty-state'
import { SimpleSelect } from '@/components/common/simple-select'
import type { ParameterType, ScriptLanguage, ScriptParameter } from '@/lib/api/types'
import { PARAMETER_TYPE_LABEL, changeParameterType, newParameter, type ParameterIssues } from '@/lib/automation/params'
import { cn } from '@/lib/utils'
import { ListInput } from './list-input'

/** How a script reads a parameter, for the builder's hint. */
function parameterUsage(language: ScriptLanguage, name: string): string {
  switch (language) {
    case 'powershell':
    case 'pwsh':
      return `$env:${name}`
    case 'cmd':
      return `%${name}%`
    case 'python':
      return `os.environ["${name}"]`
    default:
      return `"$${name}"`
  }
}

const TYPES: ParameterType[] = ['string', 'number', 'boolean', 'select', 'secret']

function DefaultEditor({
  param,
  onChange,
  disabled,
  id,
  invalid,
}: {
  param: ScriptParameter
  onChange: (value: ScriptParameter['default']) => void
  disabled: boolean
  id: string
  invalid: boolean
}) {
  if (param.type === 'secret') return <Input id={id} disabled value="" placeholder="Secrets have no default" />
  if (param.type === 'boolean') {
    return (
      <label htmlFor={id} className="flex h-(--control-h) items-center gap-2 text-dense text-muted-foreground">
        <Switch
          id={id}
          checked={param.default === true}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(checked)}
        />
        {param.default === true ? 'On' : 'Off'}
      </label>
    )
  }
  if (param.type === 'select') {
    return (
      <SimpleSelect
        id={id}
        value={typeof param.default === 'string' && param.default ? param.default : '__none'}
        onValueChange={(value) => onChange(value === '__none' ? null : value)}
        disabled={disabled}
        options={[
          { value: '__none', label: 'No default' },
          ...(param.options ?? []).map((option) => ({ value: option, label: option })),
        ]}
      />
    )
  }
  return (
    <Input
      id={id}
      type={param.type === 'number' ? 'number' : 'text'}
      className={cn(param.type === 'number' && 'tabular')}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      value={param.default === null ? '' : String(param.default)}
      placeholder="None"
      onChange={(event) => {
        const raw = event.target.value
        if (param.type === 'number') onChange(raw === '' ? null : Number.isFinite(Number(raw)) ? Number(raw) : raw)
        else onChange(raw === '' ? null : raw)
      }}
    />
  )
}

export function ParameterBuilder({
  parameters,
  onChange,
  issues,
  language,
  readOnly = false,
}: {
  parameters: ScriptParameter[]
  onChange: (parameters: ScriptParameter[]) => void
  issues: ParameterIssues[]
  language: ScriptLanguage
  readOnly?: boolean
}) {
  const update = (index: number, next: ScriptParameter) =>
    onChange(parameters.map((param, position) => (position === index ? next : param)))
  const move = (index: number, delta: number) => {
    const next = [...parameters]
    const [item] = next.splice(index, 1)
    next.splice(index + delta, 0, item)
    onChange(next)
  }

  return (
    <div className="grid grid-cols-1 gap-3">
      {parameters.length === 0 ? (
        <EmptyState
          compact
          illustration="automation"
          title="No parameters"
          description="Parameters make a script reusable: text, numbers, yes/no switches, choices and write-only secrets, each delivered as an environment variable."
          actions={
            !readOnly && (
              <Button size="sm" onClick={() => onChange([newParameter(parameters)])}>
                <Plus data-icon="inline-start" />
                Add parameter
              </Button>
            )
          }
        />
      ) : (
        parameters.map((param, index) => {
          const problem = issues[index] ?? {}
          const id = `pb-${index}`
          return (
            <div
              key={index}
              className={cn(
                'rounded-xl bg-card shadow-card',
                Object.keys(problem).length > 0 && 'ring-1 ring-critical/30',
              )}
            >
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <span className="tabular flex size-5 items-center justify-center rounded-md bg-surface-3 text-[10.5px] font-semibold text-muted-foreground">
                  {index + 1}
                </span>
                <code className="truncate font-mono text-[12px] font-medium">{param.name || 'unnamed'}</code>
                <span className="hidden truncate font-mono text-[11px] text-subtle-foreground sm:inline">
                  → {parameterUsage(language, param.name || 'Name')}
                </span>
                {!readOnly && (
                  <div className="ml-auto flex items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Move up"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Move down"
                      disabled={index === parameters.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove ${param.name}`}
                      className="hover:text-critical"
                      onClick={() => onChange(parameters.filter((_, position) => position !== index))}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </div>
              <fieldset
                disabled={readOnly}
                className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_150px_auto]"
              >
                <Field data-invalid={Boolean(problem.name) || undefined}>
                  <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
                  <Input
                    id={`${id}-name`}
                    className="font-mono"
                    value={param.name}
                    spellCheck={false}
                    aria-invalid={Boolean(problem.name) || undefined}
                    onChange={(event) => update(index, { ...param, name: event.target.value })}
                  />
                  <FieldError>{problem.name}</FieldError>
                </Field>
                <Field data-invalid={Boolean(problem.label) || undefined}>
                  <FieldLabel htmlFor={`${id}-label`}>Label</FieldLabel>
                  <Input
                    id={`${id}-label`}
                    value={param.label}
                    placeholder={param.name}
                    onChange={(event) => update(index, { ...param, label: event.target.value })}
                  />
                  <FieldError>{problem.label}</FieldError>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-type`}>Type</FieldLabel>
                  <SimpleSelect
                    id={`${id}-type`}
                    value={param.type}
                    disabled={readOnly}
                    onValueChange={(value) => update(index, changeParameterType(param, value as ParameterType))}
                    options={TYPES.map((type) => ({ value: type, label: PARAMETER_TYPE_LABEL[type] }))}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-required`}>Required</FieldLabel>
                  <div className="flex h-(--control-h) items-center">
                    <Switch
                      id={`${id}-required`}
                      checked={param.required}
                      disabled={readOnly || param.type === 'boolean'}
                      onCheckedChange={(checked) => update(index, { ...param, required: checked })}
                    />
                  </div>
                </Field>
                <Field
                  data-invalid={Boolean(problem.default) || undefined}
                  className={cn(param.type === 'select' ? 'sm:col-span-1' : 'sm:col-span-2 lg:col-span-2')}
                >
                  <FieldLabel htmlFor={`${id}-default`}>Default</FieldLabel>
                  <DefaultEditor
                    id={`${id}-default`}
                    param={param}
                    disabled={readOnly}
                    invalid={Boolean(problem.default)}
                    onChange={(value) => update(index, { ...param, default: value })}
                  />
                  <FieldError>{problem.default}</FieldError>
                </Field>
                {param.type === 'select' && (
                  <Field data-invalid={Boolean(problem.options) || undefined} className="lg:col-span-3">
                    <FieldLabel htmlFor={`${id}-options`}>Options</FieldLabel>
                    <ListInput
                      id={`${id}-options`}
                      value={param.options ?? []}
                      invalid={Boolean(problem.options)}
                      onChange={(options) =>
                        update(index, {
                          ...param,
                          options,
                          default:
                            typeof param.default === 'string' && options.includes(param.default) ? param.default : null,
                        })
                      }
                      placeholder="Type an option and press Enter"
                    />
                    <FieldError>{problem.options}</FieldError>
                  </Field>
                )}
                <Field className="sm:col-span-2 lg:col-span-4">
                  <FieldLabel htmlFor={`${id}-description`}>Help text</FieldLabel>
                  <Input
                    id={`${id}-description`}
                    value={param.description}
                    maxLength={300}
                    placeholder="Shown under the field in the run form"
                    onChange={(event) => update(index, { ...param, description: event.target.value })}
                  />
                </Field>
              </fieldset>
            </div>
          )
        })
      )}
      {!readOnly && parameters.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          onClick={() => onChange([...parameters, newParameter(parameters)])}
        >
          <Plus data-icon="inline-start" />
          Add parameter
        </Button>
      )}
    </div>
  )
}
