import type { CustomField, CustomFieldValue } from '@/lib/api/types'
import { formatDate } from '@/lib/format'

/** A readable rendering of a custom field value. */
export function formatFieldValue(field: Pick<CustomField, 'type'>, value: CustomFieldValue | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  if (field.type === 'boolean') return value === true || value === 'true' ? 'Yes' : 'No'
  if (field.type === 'date') return formatDate(`${String(value).slice(0, 10)}T12:00:00`)
  if (field.type === 'number') return Number(value).toLocaleString()
  return String(value)
}
