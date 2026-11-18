import { useState } from 'react'
import { ChevronsUpDown, CircleExclamationPoint, Layers, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SimpleSelect } from '@/components/common/simple-select'
import type { Client, RuleCondition, RuleDocument, RuleMatch, RuleScalar, RuleValue, Site } from '@/lib/api/types'
import {
  MAX_RULE_CONDITIONS,
  MAX_RULE_DEPTH,
  appendNode,
  canNestAt,
  changeField,
  changeOperator,
  countConditions,
  findField,
  isGroup,
  isListOperator,
  isPresenceOperator,
  issuesAt,
  newCondition,
  newGroup,
  operatorLabel,
  operatorsFor,
  removeNode,
  setMatch,
  updateNode,
  type RuleField,
  type RuleIssue,
  type RulePath,
} from '@/lib/automation/rules'
import { cn } from '@/lib/utils'
import { ListInput } from './list-input'

interface Context {
  fields: RuleField[]
  issues: RuleIssue[]
  clients: Client[]
  sites: Site[]
  readOnly: boolean
  total: number
  update: (next: RuleDocument) => void
  doc: RuleDocument
}

function FieldPicker({
  value,
  fields,
  onChange,
  disabled,
}: {
  value: string
  fields: RuleField[]
  onChange: (field: RuleField) => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const current = findField(fields, value)
  const groups = [...new Set(fields.map((field) => field.group))]
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            role="combobox"
            aria-expanded={open}
            aria-label="Field"
            className="w-full justify-between font-normal"
          />
        }
      >
        <span className="truncate">{current?.label ?? value}</span>
        <ChevronsUpDown className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search fields…" />
          <CommandList className="max-h-72">
            <CommandEmpty>No field matches.</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup key={group} heading={group}>
                {fields
                  .filter((field) => field.group === group)
                  .map((field) => (
                    <CommandItem
                      key={field.key}
                      value={`${field.label} ${field.key}`}
                      data-checked={field.key === value}
                      onSelect={() => {
                        onChange(field)
                        setOpen(false)
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">{field.label}</span>
                      <span className="font-mono text-[10px] text-subtle-foreground">{field.key}</span>
                    </CommandItem>
                  ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function EntityMultiPicker({
  options,
  value,
  onChange,
  disabled,
  noun,
}: {
  options: { value: string; label: string; group?: string }[]
  value: RuleScalar[]
  onChange: (value: string[]) => void
  disabled: boolean
  noun: string
}) {
  const [open, setOpen] = useState(false)
  const selected = value.map(String)
  const groups = [...new Set(options.map((option) => option.group ?? ''))]
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            className="h-auto min-h-(--control-h) w-full justify-between py-1 font-normal"
          />
        }
      >
        <span className="flex min-w-0 flex-wrap gap-1">
          {selected.length === 0 && <span className="text-muted-foreground">Choose {noun}s…</span>}
          {selected.map((id) => (
            <span
              key={id}
              className="inline-flex h-5 max-w-full items-center rounded-[5px] bg-surface-3 px-1.5 text-micro ring-1 ring-border"
            >
              <span className="truncate">{options.find((option) => option.value === id)?.label ?? id}</span>
            </span>
          ))}
        </span>
        <ChevronsUpDown className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder={`Search ${noun}s…`} />
          <CommandList className="max-h-72">
            <CommandEmpty>Nothing matches.</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup key={group || 'all'} heading={group || undefined}>
                {options
                  .filter((option) => (option.group ?? '') === group)
                  .map((option) => {
                    const checked = selected.includes(option.value)
                    return (
                      <CommandItem
                        key={option.value}
                        value={`${option.label} ${option.group ?? ''}`}
                        data-checked={checked}
                        onSelect={() =>
                          onChange(checked ? selected.filter((id) => id !== option.value) : [...selected, option.value])
                        }
                      >
                        <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      </CommandItem>
                    )
                  })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function ValueEditor({
  field,
  condition,
  onChange,
  ctx,
  invalid,
}: {
  field: RuleField | undefined
  condition: RuleCondition
  onChange: (value: RuleValue) => void
  ctx: Context
  invalid: boolean
}) {
  const disabled = ctx.readOnly
  if (isPresenceOperator(condition.op))
    return (
      <div className="flex h-(--control-h) items-center px-1 text-dense text-subtle-foreground">No value needed</div>
    )
  if (!field) return <Input disabled value={String(condition.value ?? '')} />

  const entityOptions =
    field.entity === 'client'
      ? ctx.clients.map((client) => ({ value: client.id, label: client.name }))
      : field.entity === 'site'
        ? ctx.sites.map((site) => ({
            value: site.id,
            label: site.name,
            group: ctx.clients.find((client) => client.id === site.client_id)?.name,
          }))
        : []

  if (isListOperator(condition.op)) {
    const list = Array.isArray(condition.value) ? condition.value : []
    if (field.type === 'id')
      return (
        <EntityMultiPicker
          options={entityOptions}
          value={list}
          onChange={onChange}
          disabled={disabled}
          noun={field.entity ?? 'item'}
        />
      )
    if (field.type === 'enum') {
      return (
        <div className="flex min-h-(--control-h) flex-wrap items-center gap-1">
          {(field.options ?? []).map((option) => {
            const active = list.includes(option.value)
            return (
              <button
                key={option.value}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                onClick={() =>
                  onChange(active ? list.filter((item) => item !== option.value) : [...list, option.value])
                }
                className={cn(
                  'h-7 rounded-md px-2.5 text-dense ring-1 transition-colors',
                  active
                    ? 'bg-primary/12 font-medium text-foreground ring-primary/35'
                    : 'text-muted-foreground ring-border-strong hover:bg-surface-3',
                )}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      )
    }
    return (
      <ListInput
        value={list.map(String)}
        invalid={invalid}
        disabled={disabled}
        mono={field.type !== 'number'}
        placeholder={field.type === 'number' ? 'Numbers, press Enter' : 'Values, press Enter'}
        onChange={(items) =>
          onChange(
            field.type === 'number'
              ? items.map((item) => (Number.isFinite(Number(item)) ? Number(item) : item))
              : items,
          )
        }
      />
    )
  }

  switch (field.type) {
    case 'boolean':
      return (
        <SimpleSelect
          value={condition.value === false ? 'false' : 'true'}
          disabled={disabled}
          onValueChange={(value) => onChange(value === 'true')}
          options={[
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' },
          ]}
          ariaLabel="Value"
        />
      )
    case 'enum':
      return (
        <SimpleSelect
          value={typeof condition.value === 'string' ? condition.value : null}
          disabled={disabled}
          onValueChange={onChange}
          options={field.options ?? []}
          ariaLabel="Value"
          ariaInvalid={invalid}
        />
      )
    case 'id':
      return (
        <SimpleSelect
          value={typeof condition.value === 'string' ? condition.value : null}
          disabled={disabled}
          onValueChange={onChange}
          options={entityOptions}
          placeholder={`Choose a ${field.entity}…`}
          ariaLabel="Value"
          ariaInvalid={invalid}
        />
      )
    case 'number':
      return (
        <div className="relative">
          <Input
            type="number"
            className={cn('tabular', field.unit && 'pr-16')}
            disabled={disabled}
            aria-label="Value"
            aria-invalid={invalid || undefined}
            placeholder={field.placeholder}
            value={condition.value === null || condition.value === undefined ? '' : String(condition.value)}
            onChange={(event) => onChange(event.target.value === '' ? '' : Number(event.target.value))}
          />
          {field.unit && (
            <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-micro text-subtle-foreground">
              {field.unit}
            </span>
          )}
        </div>
      )
    case 'date':
      return (
        <Input
          type="date"
          disabled={disabled}
          aria-label="Value"
          aria-invalid={invalid || undefined}
          value={typeof condition.value === 'string' ? condition.value.slice(0, 10) : ''}
          onChange={(event) => onChange(event.target.value)}
        />
      )
    default:
      return (
        <Input
          disabled={disabled}
          aria-label="Value"
          aria-invalid={invalid || undefined}
          className={cn(condition.op === 'matches' && 'font-mono')}
          placeholder={condition.op === 'matches' ? '^NWD-.*$' : field.placeholder}
          value={
            typeof condition.value === 'string' || typeof condition.value === 'number' ? String(condition.value) : ''
          }
          onChange={(event) => onChange(event.target.value)}
        />
      )
  }
}

function ConditionRow({ condition, path, ctx }: { condition: RuleCondition; path: RulePath; ctx: Context }) {
  const field = findField(ctx.fields, condition.field)
  const problems = issuesAt(ctx.issues, path)
  const ops = field ? operatorsFor(field.type) : [condition.op]
  const set = (next: RuleCondition) => ctx.update(updateNode(ctx.doc, path, () => next))
  return (
    <div className="grid grid-cols-1 gap-1.5">
      <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,10.5rem)_minmax(0,1fr)_auto]">
        <FieldPicker
          value={condition.field}
          fields={ctx.fields}
          disabled={ctx.readOnly}
          onChange={(next) => set(changeField(condition, next, field))}
        />
        <SimpleSelect
          value={condition.op}
          disabled={ctx.readOnly}
          ariaLabel="Operator"
          onValueChange={(op) => set(changeOperator(condition, op as RuleCondition['op'], field))}
          options={ops.map((op) => ({ value: op, label: operatorLabel(op, field?.type) }))}
        />
        <ValueEditor
          field={field}
          condition={condition}
          ctx={ctx}
          invalid={problems.length > 0}
          onChange={(value) => set({ ...condition, value })}
        />
        {!ctx.readOnly && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Remove condition"
            className="justify-self-end hover:text-critical"
            onClick={() => ctx.update(removeNode(ctx.doc, path))}
          >
            <X />
          </Button>
        )}
      </div>
      {problems.map((problem) => (
        <p key={problem.message} className="flex items-center gap-1.5 text-micro text-critical">
          <CircleExclamationPoint className="size-3.5" />
          {problem.message}
        </p>
      ))}
    </div>
  )
}

function Connector({ match }: { match: RuleMatch }) {
  return (
    <div className="flex items-center gap-2 py-0.5" aria-hidden="true">
      <span className="h-px w-3 bg-border-strong" />
      <span className="rounded-full bg-surface-3 px-2 py-px text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase ring-1 ring-border">
        {match === 'all' ? 'and' : 'or'}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

function GroupNode({ doc, path, ctx }: { doc: RuleDocument; path: RulePath; ctx: Context }) {
  const nested = path.length > 0
  const full = ctx.total >= MAX_RULE_CONDITIONS
  const problems = issuesAt(ctx.issues, path)
  const canNest = canNestAt(path)
  return (
    <div
      className={cn(
        'grid gap-2.5 rounded-xl p-3',
        nested ? 'border-l-2 border-primary/40 bg-surface-2/60 ring-1 ring-border' : 'bg-card shadow-card sm:p-4',
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-dense">
        {nested && <Layers className="size-3.5 text-primary" />}
        <span className="text-muted-foreground">Match</span>
        <SimpleSelect
          size="sm"
          className="w-20"
          ariaLabel="Match"
          disabled={ctx.readOnly}
          value={doc.match}
          onValueChange={(match) => ctx.update(setMatch(ctx.doc, path, match as RuleMatch))}
          options={[
            { value: 'all', label: 'all' },
            { value: 'any', label: 'any' },
          ]}
        />
        <span className="text-muted-foreground">of these conditions</span>
        {nested && !ctx.readOnly && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-auto hover:text-critical"
            onClick={() => ctx.update(removeNode(ctx.doc, path))}
          >
            <Trash2 data-icon="inline-start" />
            Remove group
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-1.5">
        {doc.conditions.map((node, index) => (
          <div key={index} className="grid grid-cols-1 gap-1.5">
            {index > 0 && <Connector match={doc.match} />}
            {isGroup(node) ? (
              <GroupNode doc={node} path={[...path, index]} ctx={ctx} />
            ) : (
              <ConditionRow condition={node} path={[...path, index]} ctx={ctx} />
            )}
          </div>
        ))}
      </div>

      {problems.map((problem) => (
        <p key={problem.message} className="flex items-center gap-1.5 text-micro text-critical">
          <CircleExclamationPoint className="size-3.5" />
          {problem.message}
        </p>
      ))}

      {!ctx.readOnly && (
        <div className="flex flex-wrap gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={full}
            onClick={() => ctx.update(appendNode(ctx.doc, path, newCondition()))}
          >
            <Plus data-icon="inline-start" />
            Condition
          </Button>
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={full || !canNest}
                onClick={() => ctx.update(appendNode(ctx.doc, path, newGroup(doc.match === 'all' ? 'any' : 'all')))}
              >
                <Layers data-icon="inline-start" />
                Group
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {canNest ? 'Add a nested group of conditions' : `Groups nest at most ${MAX_RULE_DEPTH} levels deep`}
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  )
}

/** Nested all/any rule editor with field-typed operators and values. */
export function RuleBuilder({
  value,
  onChange,
  fields,
  issues,
  clients,
  sites,
  readOnly = false,
}: {
  value: RuleDocument
  onChange: (next: RuleDocument) => void
  fields: RuleField[]
  issues: RuleIssue[]
  clients: Client[]
  sites: Site[]
  readOnly?: boolean
}) {
  const total = countConditions(value)
  const ctx: Context = { fields, issues, clients, sites, readOnly, total, update: onChange, doc: value }
  return (
    <div className="grid grid-cols-1 gap-2">
      <GroupNode doc={value} path={[]} ctx={ctx} />
      <p
        className={cn(
          'px-1 text-right text-micro',
          total >= MAX_RULE_CONDITIONS ? 'text-warning' : 'text-subtle-foreground',
        )}
      >
        {total} of {MAX_RULE_CONDITIONS} conditions · up to {MAX_RULE_DEPTH} levels
      </p>
    </div>
  )
}
