/*
 * Dynamic group rule documents: the field catalog, operators per field type, immutable editing
 * helpers for the rule builder, validation (mirroring the server's limits) and an evaluator the
 * mock API uses to resolve members.
 */
import type {
  CustomField,
  RuleCondition,
  RuleDocument,
  RuleMatch,
  RuleNode,
  RuleOperator,
  RuleScalar,
  RuleValue,
} from '@/lib/api/types'

export const MAX_RULE_DEPTH = 3
export const MAX_RULE_CONDITIONS = 50
export const MAX_REGEX_LENGTH = 200

export type RuleFieldType = 'text' | 'enum' | 'id' | 'tag' | 'boolean' | 'number' | 'date'

export interface RuleField {
  key: string
  label: string
  type: RuleFieldType
  group: 'Device' | 'Status' | 'Hardware' | 'Organisation' | 'Custom fields'
  options?: { value: string; label: string }[]
  /** For `id` fields: which entity the value refers to. */
  entity?: 'client' | 'site'
  unit?: string
  placeholder?: string
}

export const BUILTIN_RULE_FIELDS: RuleField[] = [
  { key: 'hostname', label: 'Hostname', type: 'text', group: 'Device', placeholder: 'NWD-FRONT-01' },
  {
    key: 'os_family',
    label: 'OS family',
    type: 'enum',
    group: 'Device',
    options: [
      { value: 'windows', label: 'Windows' },
      { value: 'macos', label: 'macOS' },
      { value: 'linux', label: 'Linux' },
    ],
  },
  { key: 'os_name', label: 'OS name', type: 'text', group: 'Device', placeholder: 'Windows 11 Pro' },
  { key: 'os_version', label: 'OS version', type: 'text', group: 'Device', placeholder: '10.0.26100' },
  { key: 'device_type', label: 'Device type', type: 'text', group: 'Device', placeholder: 'server' },
  { key: 'tag', label: 'Tag', type: 'tag', group: 'Device', placeholder: 'vip' },
  { key: 'domain', label: 'Domain', type: 'text', group: 'Device', placeholder: 'corp.local' },
  { key: 'last_user', label: 'Last user', type: 'text', group: 'Device' },
  { key: 'agent_version', label: 'Agent version', type: 'text', group: 'Device', placeholder: '0.1.0' },
  { key: 'public_ip', label: 'Public IP', type: 'text', group: 'Device', placeholder: '203.0.113.10' },
  { key: 'online', label: 'Online', type: 'boolean', group: 'Status' },
  { key: 'pending_reboot', label: 'Restart pending', type: 'boolean', group: 'Status' },
  { key: 'health_score', label: 'Health score', type: 'number', group: 'Status', placeholder: '70' },
  { key: 'disk_free_pct', label: 'Lowest disk free', type: 'number', group: 'Status', unit: '%', placeholder: '15' },
  { key: 'uptime_days', label: 'Uptime', type: 'number', group: 'Status', unit: 'days', placeholder: '30' },
  {
    key: 'last_seen_minutes',
    label: 'Last seen',
    type: 'number',
    group: 'Status',
    unit: 'min ago',
    placeholder: '1440',
  },
  { key: 'manufacturer', label: 'Manufacturer', type: 'text', group: 'Hardware', placeholder: 'Dell Inc.' },
  { key: 'model', label: 'Model', type: 'text', group: 'Hardware' },
  { key: 'serial', label: 'Serial number', type: 'text', group: 'Hardware' },
  { key: 'ram_gb', label: 'Memory', type: 'number', group: 'Hardware', unit: 'GB', placeholder: '16' },
  { key: 'client_id', label: 'Client', type: 'id', group: 'Organisation', entity: 'client' },
  { key: 'site_id', label: 'Site', type: 'id', group: 'Organisation', entity: 'site' },
]

/** `custom.<key>` fields for device-scope custom field definitions. */
export function customRuleFields(fields: CustomField[]): RuleField[] {
  return fields
    .filter((field) => field.scope === 'device')
    .map((field) => ({
      key: `custom.${field.key}`,
      label: field.name,
      group: 'Custom fields' as const,
      type:
        field.type === 'select'
          ? ('enum' as const)
          : field.type === 'text'
            ? ('text' as const)
            : (field.type as 'number' | 'boolean' | 'date'),
      options: field.type === 'select' ? field.options.map((option) => ({ value: option, label: option })) : undefined,
    }))
}

export function ruleFieldCatalog(customFields: CustomField[] = []): RuleField[] {
  return [...BUILTIN_RULE_FIELDS, ...customRuleFields(customFields)]
}

export function findField(fields: RuleField[], key: string): RuleField | undefined {
  return fields.find((field) => field.key === key)
}

// ------------------------------------------------------------------ operators

const COMMON: RuleOperator[] = ['eq', 'neq', 'in', 'not_in', 'exists', 'not_exists']
const TEXT_ONLY: RuleOperator[] = ['contains', 'not_contains', 'starts_with', 'ends_with', 'matches']
const ORDERED: RuleOperator[] = ['gt', 'gte', 'lt', 'lte']

export const OPERATOR_LABEL: Record<RuleOperator, string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is any of',
  not_in: 'is none of',
  exists: 'is set',
  not_exists: 'is not set',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  ends_with: 'ends with',
  matches: 'matches regex',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
}

const DATE_LABEL: Partial<Record<RuleOperator, string>> = {
  gt: 'is after',
  gte: 'is on or after',
  lt: 'is before',
  lte: 'is on or before',
}

export function operatorLabel(op: RuleOperator, type?: RuleFieldType): string {
  return (type === 'date' && DATE_LABEL[op]) || OPERATOR_LABEL[op]
}

export function operatorsFor(type: RuleFieldType): RuleOperator[] {
  switch (type) {
    case 'text':
    case 'tag':
      return [...COMMON.slice(0, 2), ...TEXT_ONLY, ...COMMON.slice(2)]
    case 'number':
    case 'date':
      return [...COMMON.slice(0, 2), ...ORDERED, ...COMMON.slice(2)]
    case 'boolean':
      return ['eq', 'neq', 'exists', 'not_exists']
    default:
      return COMMON
  }
}

export const isListOperator = (op: RuleOperator) => op === 'in' || op === 'not_in'
export const isPresenceOperator = (op: RuleOperator) => op === 'exists' || op === 'not_exists'

// ------------------------------------------------------------------ structure

export type RulePath = number[]

export function isGroup(node: RuleNode): node is RuleDocument {
  return typeof node === 'object' && node !== null && 'conditions' in node && Array.isArray(node.conditions)
}

export function emptyRules(match: RuleMatch = 'all'): RuleDocument {
  return { match, conditions: [] }
}

/** The default value an editor shows for a field/operator pair. */
export function defaultValueFor(field: RuleField | undefined, op: RuleOperator): RuleValue {
  if (isPresenceOperator(op)) return null
  if (isListOperator(op)) return []
  if (!field) return ''
  if (field.type === 'boolean') return true
  if (field.type === 'enum') return field.options?.[0]?.value ?? ''
  return ''
}

export function newCondition(field: RuleField = BUILTIN_RULE_FIELDS[1]): RuleCondition {
  return { field: field.key, op: 'eq', value: defaultValueFor(field, 'eq') }
}

export function newGroup(match: RuleMatch = 'any', field?: RuleField): RuleDocument {
  return { match, conditions: [newCondition(field)] }
}

export function getNode(doc: RuleDocument, path: RulePath): RuleNode | undefined {
  let node: RuleNode = doc
  for (const index of path) {
    if (!isGroup(node)) return undefined
    const next: RuleNode | undefined = node.conditions[index]
    if (!next) return undefined
    node = next
  }
  return node
}

/** Replaces the node at `path` with `updater(node)`; returns a new document. */
export function updateNode(doc: RuleDocument, path: RulePath, updater: (node: RuleNode) => RuleNode): RuleDocument {
  if (path.length === 0) {
    const next = updater(doc)
    return isGroup(next) ? next : doc
  }
  const [head, ...rest] = path
  const child = doc.conditions[head]
  if (child === undefined) return doc
  const replaced = rest.length === 0 ? updater(child) : isGroup(child) ? updateNode(child, rest, updater) : child
  return { ...doc, conditions: doc.conditions.map((item, index) => (index === head ? replaced : item)) }
}

/** Appends `node` to the group at `groupPath`. */
export function appendNode(doc: RuleDocument, groupPath: RulePath, node: RuleNode): RuleDocument {
  return updateNode(doc, groupPath, (group) =>
    isGroup(group) ? { ...group, conditions: [...group.conditions, node] } : group,
  )
}

export function removeNode(doc: RuleDocument, path: RulePath): RuleDocument {
  if (path.length === 0) return emptyRules(doc.match)
  const parentPath = path.slice(0, -1)
  const index = path[path.length - 1]
  return updateNode(doc, parentPath, (group) =>
    isGroup(group) ? { ...group, conditions: group.conditions.filter((_, position) => position !== index) } : group,
  )
}

export function setMatch(doc: RuleDocument, groupPath: RulePath, match: RuleMatch): RuleDocument {
  return updateNode(doc, groupPath, (group) => (isGroup(group) ? { ...group, match } : group))
}

/** Switching field keeps the operator when the new field supports it and resets the value when its type changes. */
export function changeField(condition: RuleCondition, field: RuleField, previous?: RuleField): RuleCondition {
  const ops = operatorsFor(field.type)
  const op = ops.includes(condition.op) ? condition.op : 'eq'
  const sameKind = previous && previous.type === field.type && previous.key === field.key
  return { field: field.key, op, value: sameKind ? condition.value : defaultValueFor(field, op) }
}

/** Switching operator converts the value between scalar, list and "no value". */
export function changeOperator(condition: RuleCondition, op: RuleOperator, field?: RuleField): RuleCondition {
  if (isPresenceOperator(op)) return { ...condition, op, value: null }
  const current = condition.value
  if (isListOperator(op)) {
    const list = Array.isArray(current) ? current : current === null || current === '' ? [] : [current]
    return { ...condition, op, value: list }
  }
  if (Array.isArray(current)) return { ...condition, op, value: current[0] ?? defaultValueFor(field, op) }
  if (current === null) return { ...condition, op, value: defaultValueFor(field, op) }
  return { ...condition, op }
}

export function countConditions(doc: RuleDocument): number {
  return doc.conditions.reduce((sum, node) => sum + (isGroup(node) ? countConditions(node) : 1), 0)
}

/** Nesting depth: a flat document is 1. */
export function ruleDepth(doc: RuleDocument): number {
  return 1 + Math.max(0, ...doc.conditions.map((node) => (isGroup(node) ? ruleDepth(node) : 0)))
}

/** Whether a sub-group may be added inside the group at `groupPath` (top level is depth 1). */
export function canNestAt(groupPath: RulePath): boolean {
  return groupPath.length + 1 < MAX_RULE_DEPTH
}

// ------------------------------------------------------------------ validation

export interface RuleIssue {
  path: RulePath
  message: string
}

function isScalarFor(field: RuleField, value: unknown): boolean {
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'date':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value))
    case 'enum':
      return typeof value === 'string' && (!field.options || field.options.some((option) => option.value === value))
    default:
      return typeof value === 'string' && value.trim().length > 0
  }
}

function regexProblem(pattern: string): string | null {
  if (pattern.length > MAX_REGEX_LENGTH) return `Regular expressions are limited to ${MAX_REGEX_LENGTH} characters`
  try {
    new RegExp(pattern)
    return null
  } catch {
    return 'This regular expression is not valid'
  }
}

function validateCondition(condition: RuleCondition, fields: RuleField[], path: RulePath, issues: RuleIssue[]) {
  const field = findField(fields, condition.field)
  if (!field) {
    issues.push({ path, message: `Unknown field “${condition.field}”` })
    return
  }
  if (!operatorsFor(field.type).includes(condition.op)) {
    issues.push({ path, message: `“${operatorLabel(condition.op)}” does not apply to ${field.label}` })
    return
  }
  if (isPresenceOperator(condition.op)) return
  if (isListOperator(condition.op)) {
    if (!Array.isArray(condition.value) || condition.value.length === 0) {
      issues.push({ path, message: 'Add at least one value' })
    } else if (!condition.value.every((value) => isScalarFor(field, value))) {
      issues.push({ path, message: `Every value must be a valid ${field.label.toLowerCase()}` })
    }
    return
  }
  if (condition.op === 'matches') {
    const problem =
      typeof condition.value === 'string' && condition.value ? regexProblem(condition.value) : 'Enter a pattern'
    if (problem) issues.push({ path, message: problem })
    return
  }
  if (!isScalarFor(field, condition.value)) {
    const hint =
      field.type === 'number'
        ? 'Enter a number'
        : field.type === 'date'
          ? 'Choose a date'
          : field.type === 'boolean'
            ? 'Choose yes or no'
            : 'Enter a value'
    issues.push({ path, message: hint })
  }
}

function validateGroup(doc: RuleDocument, fields: RuleField[], path: RulePath, depth: number, issues: RuleIssue[]) {
  if (doc.match !== 'all' && doc.match !== 'any') issues.push({ path, message: 'Match must be “all” or “any”' })
  if (depth > MAX_RULE_DEPTH) {
    issues.push({ path, message: `Groups can nest at most ${MAX_RULE_DEPTH} levels deep` })
    return
  }
  if (doc.conditions.length === 0)
    issues.push({ path, message: path.length === 0 ? 'Add at least one condition' : 'This group is empty' })
  doc.conditions.forEach((node, index) => {
    const childPath = [...path, index]
    if (isGroup(node)) validateGroup(node, fields, childPath, depth + 1, issues)
    else validateCondition(node, fields, childPath, issues)
  })
}

export function validateRules(doc: RuleDocument, fields: RuleField[]): RuleIssue[] {
  const issues: RuleIssue[] = []
  validateGroup(doc, fields, [], 1, issues)
  const total = countConditions(doc)
  if (total > MAX_RULE_CONDITIONS)
    issues.unshift({ path: [], message: `Rules can hold at most ${MAX_RULE_CONDITIONS} conditions (${total} now)` })
  return issues
}

export function issuesAt(issues: RuleIssue[], path: RulePath): RuleIssue[] {
  return issues.filter(
    (issue) => issue.path.length === path.length && issue.path.every((value, index) => value === path[index]),
  )
}

// ------------------------------------------------------------------ evaluation

/** Values a device exposes to rules: built-in field keys, `tag` as a list, and `custom.<key>`. */
export type DeviceFacts = Record<string, RuleScalar | RuleScalar[] | null | undefined>

function normalize(value: unknown): unknown {
  return typeof value === 'string' ? value.toLowerCase() : value
}

function looseEquals(left: unknown, right: unknown): boolean {
  if (typeof left === 'number' || typeof right === 'number') return Number(left) === Number(right)
  if (typeof left === 'boolean' || typeof right === 'boolean') return String(left) === String(right)
  return normalize(left) === normalize(right)
}

function compare(left: unknown, right: unknown): number | null {
  if (left === null || left === undefined || right === null || right === undefined) return null
  if (typeof left === 'number' || typeof right === 'number') {
    const a = Number(left)
    const b = Number(right)
    return Number.isFinite(a) && Number.isFinite(b) ? a - b : null
  }
  const a = Date.parse(String(left))
  const b = Date.parse(String(right))
  if (!Number.isNaN(a) && !Number.isNaN(b)) return a - b
  return String(left).localeCompare(String(right))
}

function scalarMatches(actual: RuleScalar | null | undefined, op: RuleOperator, value: RuleValue): boolean {
  const present = actual !== null && actual !== undefined && actual !== ''
  switch (op) {
    case 'exists':
      return present
    case 'not_exists':
      return !present
    case 'eq':
      return present && looseEquals(actual, value)
    case 'neq':
      return !present || !looseEquals(actual, value)
    case 'in':
      return present && Array.isArray(value) && value.some((item) => looseEquals(actual, item))
    case 'not_in':
      return !present || !Array.isArray(value) || !value.some((item) => looseEquals(actual, item))
    case 'contains':
      return present && String(actual).toLowerCase().includes(String(value).toLowerCase())
    case 'not_contains':
      return !present || !String(actual).toLowerCase().includes(String(value).toLowerCase())
    case 'starts_with':
      return present && String(actual).toLowerCase().startsWith(String(value).toLowerCase())
    case 'ends_with':
      return present && String(actual).toLowerCase().endsWith(String(value).toLowerCase())
    case 'matches':
      try {
        return present && new RegExp(String(value), 'i').test(String(actual))
      } catch {
        return false
      }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const diff = compare(actual, value)
      if (diff === null) return false
      return op === 'gt' ? diff > 0 : op === 'gte' ? diff >= 0 : op === 'lt' ? diff < 0 : diff <= 0
    }
  }
}

function conditionMatches(condition: RuleCondition, facts: DeviceFacts): boolean {
  const actual = facts[condition.field]
  if (Array.isArray(actual)) {
    // List facts (tags): positive operators match when any item does; negative ones when none does.
    if (condition.op === 'exists') return actual.length > 0
    if (condition.op === 'not_exists') return actual.length === 0
    const negative = condition.op === 'neq' || condition.op === 'not_in' || condition.op === 'not_contains'
    if (negative) {
      const positive = condition.op === 'neq' ? 'eq' : condition.op === 'not_in' ? 'in' : 'contains'
      return !actual.some((item) => scalarMatches(item, positive, condition.value))
    }
    return actual.some((item) => scalarMatches(item, condition.op, condition.value))
  }
  return scalarMatches(actual, condition.op, condition.value)
}

export function evaluateRules(doc: RuleDocument, facts: DeviceFacts): boolean {
  const test = (node: RuleNode) => (isGroup(node) ? evaluateRules(node, facts) : conditionMatches(node, facts))
  return doc.match === 'all' ? doc.conditions.every(test) : doc.conditions.some(test)
}

// ------------------------------------------------------------------ description

function describeValue(
  field: RuleField | undefined,
  value: RuleValue,
  lookup?: (field: RuleField, id: string) => string | undefined,
): string {
  if (value === null) return ''
  if (Array.isArray(value)) return value.map((item) => describeValue(field, item, lookup)).join(', ')
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (field?.type === 'id' && lookup) return lookup(field, String(value)) ?? String(value)
  const option = field?.options?.find((item) => item.value === value)
  return option ? option.label : String(value)
}

/** A one-line, human summary such as “OS family is Windows and (Tag is vip or Health score is less than 70)”. */
export function describeRules(
  doc: RuleDocument,
  fields: RuleField[],
  lookup?: (field: RuleField, id: string) => string | undefined,
): string {
  const parts = doc.conditions.map((node) => {
    if (isGroup(node)) return `(${describeRules(node, fields, lookup)})`
    const field = findField(fields, node.field)
    const label = field?.label ?? node.field
    const value = describeValue(field, node.value, lookup)
    const unit = field?.unit && value ? ` ${field.unit}` : ''
    return `${label} ${operatorLabel(node.op, field?.type)}${value ? ` ${value}${unit}` : ''}`
  })
  if (parts.length === 0) return 'No conditions'
  return parts.join(doc.match === 'all' ? ' and ' : ' or ')
}
