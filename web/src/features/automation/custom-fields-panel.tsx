import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Bot, Check, Pencil, SlidersHorizontal, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { RelativeTime } from '@/components/common/misc'
import { SimpleSelect } from '@/components/common/simple-select'
import { customFieldsApi } from '@/lib/api/endpoints'
import { customFieldValuesQuery, keys } from '@/lib/api/queries'
import type { CustomField, CustomFieldScope, CustomFieldValue, CustomFieldValueEntry } from '@/lib/api/types'
import { formatFieldValue } from '@/lib/automation/fields'
import { cn } from '@/lib/utils'

function Editor({
  field,
  value,
  onSave,
  onCancel,
  saving,
}: {
  field: CustomField
  value: CustomFieldValue
  onSave: (value: CustomFieldValue) => void
  onCancel: () => void
  saving: boolean
}) {
  const [draft, setDraft] = useState(value === null ? '' : String(value))
  const commit = () => onSave(draft === '' ? null : field.type === 'number' ? Number(draft) : draft)
  if (field.type === 'select') {
    return (
      <div className="flex items-center gap-1.5">
        <SimpleSelect
          size="sm"
          className="min-w-36"
          value={draft || '__none'}
          ariaLabel={field.name}
          onValueChange={(next) => onSave(next === '__none' ? null : next)}
          options={[
            { value: '__none', label: 'Not set' },
            ...field.options.map((option) => ({ value: option, label: option })),
          ]}
        />
        <Button size="icon-xs" variant="ghost" aria-label="Cancel" onClick={onCancel}>
          <X />
        </Button>
      </div>
    )
  }
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault()
        commit()
      }}
    >
      <Input
        autoFocus
        aria-label={field.name}
        type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
        className={cn('h-7 min-w-0 flex-1 text-dense', field.type === 'number' && 'tabular')}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onCancel()
          }
        }}
      />
      <Button type="submit" size="icon-xs" aria-label="Save" disabled={saving}>
        {saving ? <Spinner /> : <Check />}
      </Button>
      <Button type="button" size="icon-xs" variant="ghost" aria-label="Cancel" onClick={onCancel}>
        <X />
      </Button>
    </form>
  )
}

function FieldRow({
  entry,
  canEdit,
  onSave,
  saving,
}: {
  entry: CustomFieldValueEntry
  canEdit: boolean
  onSave: (value: CustomFieldValue) => void
  saving: boolean
}) {
  const [editing, setEditing] = useState(false)
  const { field, value } = entry
  const empty = value === null || value === ''
  return (
    <div className="group grid min-h-10 grid-cols-[minmax(7rem,40%)_1fr] items-center gap-3 py-1.5 text-dense">
      <div className="min-w-0">
        <Tooltip>
          <TooltipTrigger render={<span className="block truncate text-muted-foreground" />}>
            {field.name}
          </TooltipTrigger>
          <TooltipContent className="max-w-64">
            <span className="font-mono text-[10.5px]">{field.key}</span>
            {field.description && <div className="mt-0.5">{field.description}</div>}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        {editing ? (
          <div className="min-w-0 flex-1">
            <Editor
              field={field}
              value={value}
              saving={saving}
              onCancel={() => setEditing(false)}
              onSave={(next) => {
                onSave(next)
                setEditing(false)
              }}
            />
          </div>
        ) : field.type === 'boolean' ? (
          <>
            <Switch
              size="sm"
              checked={value === true}
              disabled={!canEdit || saving}
              aria-label={field.name}
              onCheckedChange={(checked) => onSave(checked)}
            />
            <span className={cn(empty && 'text-subtle-foreground')}>{empty ? 'Not set' : value ? 'Yes' : 'No'}</span>
          </>
        ) : (
          <span
            className={cn(
              'min-w-0 truncate',
              empty ? 'text-subtle-foreground' : 'font-medium',
              field.key.includes('tag') && !empty && 'font-mono text-[12px]',
            )}
          >
            {formatFieldValue(field, value)}
          </span>
        )}
        {!editing && entry.updated_by === 'script' && (
          <Tooltip>
            <TooltipTrigger
              render={<span className="inline-flex shrink-0 text-primary" aria-label="Written by a script" />}
            >
              <Bot className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>
              Written by a script {entry.updated_at && <RelativeTime value={entry.updated_at} />}
            </TooltipContent>
          </Tooltip>
        )}
        {!editing && canEdit && field.type !== 'boolean' && (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Edit ${field.name}`}
            className="ml-auto opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
            onClick={() => setEditing(true)}
          >
            <Pencil />
          </Button>
        )}
      </div>
    </div>
  )
}

/** Typed, inline-editable custom field values for a device, client or site. */
export function CustomFieldsPanel({
  scope,
  entityId,
  canEdit,
  className,
}: {
  scope: CustomFieldScope
  entityId: string
  canEdit: boolean
  className?: string
}) {
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery(customFieldValuesQuery(scope, entityId))
  const save = useMutation({
    mutationFn: (values: Record<string, CustomFieldValue>) => customFieldsApi.setValues(scope, entityId, values),
    meta: { successMessage: 'Saved' },
    onSuccess: (result) => {
      queryClient.setQueryData(keys.customFieldValues(scope, entityId), result.items)
      if (scope === 'device') {
        void queryClient.invalidateQueries({ queryKey: keys.devices })
        void queryClient.invalidateQueries({ queryKey: keys.groups })
      }
    },
  })

  if (isLoading)
    return (
      <div className={cn('grid gap-2', className)}>
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-7" />
        ))}
      </div>
    )
  const entries = data ?? []
  if (entries.length === 0) {
    return (
      <div className={cn('flex flex-col items-start gap-2 text-dense text-muted-foreground', className)}>
        <p>No {scope} fields are defined yet.</p>
        <Button
          size="xs"
          variant="outline"
          render={<Link to="/settings/custom-fields" search={{ scope }} />}
          nativeButton={false}
        >
          <SlidersHorizontal data-icon="inline-start" />
          Define fields
        </Button>
      </div>
    )
  }
  return (
    <div className={cn('divide-y divide-border', className)}>
      {entries.map((entry) => (
        <FieldRow
          key={entry.field.id}
          entry={entry}
          canEdit={canEdit}
          saving={save.isPending && save.variables?.[entry.field.key] !== undefined}
          onSave={(value) => save.mutate({ [entry.field.key]: value })}
        />
      ))}
    </div>
  )
}
