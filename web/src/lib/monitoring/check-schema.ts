/*
 * Generates check configuration forms from a check type's `config_schema` (GET /monitoring/check-types):
 * defaults, the field models the editor renders, input coercion, validation with the server's rules,
 * clean-up before saving and a short human summary for list rows.
 */
import type { CheckConfigValue, CheckFieldSchema, CheckFieldType, CheckTypeDefinition, ParameterValue } from '@/lib/api/types'

export type CheckConfig = Record<string, CheckConfigValue>

/** A `script` field stores the script id; the script's parameter values live next to it under this key. */
export const SCRIPT_PARAMETERS_KEY = 'parameters'

export interface FieldOption {
  value: string
  label: string
}

export interface GeneratedField {
  key: string
  label: string
  type: CheckFieldType
  required: boolean
  /** The value to show: the configured one, else the schema default. */
  value: CheckConfigValue
  /** True when the config carries its own value (not the default). */
  set: boolean
  unit?: string
  min?: number
  max?: number
  options?: FieldOption[]
  /** A short helper line such as "Between 1 and 100 %". */
  hint?: string
}

const isBlank = (value: unknown) =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)

const OPTION_LABEL: Record<string, string> = {
  running: 'Running',
  stopped: 'Stopped',
  not_running: 'Not running',
  store: 'Certificate store',
  file: 'File on disk',
  exists: 'Exists',
  missing: 'Is missing',
  older_than: 'Older than',
  larger_than: 'Larger than',
  GET: 'GET',
  HEAD: 'HEAD',
  POST: 'POST',
  '*': 'Every fixed volume',
}

export function optionLabel(value: string): string {
  return OPTION_LABEL[value] ?? value
}

function rangeHint(field: CheckFieldSchema): string | undefined {
  const unit = field.unit ? ` ${field.unit}` : ''
  if (field.min !== undefined && field.max !== undefined) return `Between ${field.min} and ${field.max}${unit}`
  if (field.min !== undefined) return `At least ${field.min}${unit}`
  if (field.max !== undefined) return `At most ${field.max}${unit}`
  return undefined
}

/** The starting config for a new check: every schema default that is set. */
export function defaultConfig(schema: CheckFieldSchema[]): CheckConfig {
  const config: CheckConfig = {}
  for (const field of schema) {
    if (field.default === null || field.default === undefined) continue
    config[field.key] = Array.isArray(field.default) ? ([...field.default] as CheckConfigValue) : field.default
  }
  return config
}

/** Field models for rendering, in schema order. */
export function buildForm(schema: CheckFieldSchema[], config: CheckConfig = {}): GeneratedField[] {
  return schema.map((field) => {
    const own = config[field.key]
    const set = own !== undefined
    return {
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      value: set ? own : (field.default ?? null),
      set,
      unit: field.unit,
      min: field.min,
      max: field.max,
      options: field.options?.map((value) => ({ value, label: optionLabel(value) })),
      hint: field.type === 'number' || field.type === 'number_list' ? rangeHint(field) : undefined,
    }
  })
}

/**
 * Converts raw input to a config value. Empty input becomes `undefined` (the key is removed), numbers are
 * parsed (unparseable text stays as text so validation can flag it), lists are trimmed and de-duplicated.
 */
export function coerceInput(type: CheckFieldType, raw: unknown): CheckConfigValue | undefined {
  switch (type) {
    case 'number': {
      if (typeof raw === 'number') return Number.isNaN(raw) ? undefined : raw
      const text = String(raw ?? '').trim()
      if (text === '') return undefined
      const parsed = Number(text)
      return Number.isFinite(parsed) ? parsed : text
    }
    case 'boolean':
      return Boolean(raw)
    case 'string_list': {
      const items = (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
        .map((item) => String(item).trim())
        .filter(Boolean)
      return items.length ? [...new Set(items)] : undefined
    }
    case 'number_list': {
      const items = (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
        .map((item) => String(item).trim())
        .filter(Boolean)
      if (!items.length) return undefined
      const numbers = items.map(Number)
      return numbers.every(Number.isFinite) ? [...new Set(numbers)] : items
    }
    case 'select':
    case 'text':
    case 'script': {
      const text = typeof raw === 'string' ? raw : raw === null || raw === undefined ? '' : String(raw)
      return text.trim() === '' ? undefined : text
    }
  }
}

/** Returns a copy of `config` with `key` set to the coerced value (or removed when blank). */
export function setConfigValue(config: CheckConfig, field: Pick<CheckFieldSchema, 'key' | 'type'>, raw: unknown): CheckConfig {
  const next = { ...config }
  const value = coerceInput(field.type, raw)
  if (value === undefined) delete next[field.key]
  else next[field.key] = value
  if (field.type === 'script' && config[field.key] !== next[field.key]) delete next[SCRIPT_PARAMETERS_KEY]
  return next
}

function validateNumber(field: CheckFieldSchema, value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter a number'
  const unit = field.unit ? ` ${field.unit}` : ''
  if (field.min !== undefined && value < field.min) return `Must be at least ${field.min}${unit}`
  if (field.max !== undefined && value > field.max) return `Must be at most ${field.max}${unit}`
  return null
}

/**
 * Validates `config` against the schema: required fields, types, ranges and options. Unknown keys are
 * refused, except the parameters that accompany a `script` field. Returns errors keyed by field key.
 */
export function validateConfig(schema: CheckFieldSchema[], config: CheckConfig): Record<string, string> {
  const errors: Record<string, string> = {}
  const known = new Set(schema.map((field) => field.key))
  const hasScript = schema.some((field) => field.type === 'script')
  for (const field of schema) {
    const value = config[field.key] === undefined ? field.default : config[field.key]
    if (isBlank(value)) {
      if (field.required) errors[field.key] = field.type === 'script' ? 'Choose a script' : 'Required'
      continue
    }
    let problem: string | null = null
    switch (field.type) {
      case 'number':
        problem = validateNumber(field, value)
        break
      case 'boolean':
        if (typeof value !== 'boolean') problem = 'Must be on or off'
        break
      case 'text':
      case 'script':
        if (typeof value !== 'string') problem = 'Enter text'
        else if (value.length > 1024) problem = 'Too long (1024 characters at most)'
        break
      case 'select':
        if (typeof value !== 'string' || (field.options && !field.options.includes(value)))
          problem = `Choose one of: ${(field.options ?? []).map(optionLabel).join(', ')}`
        break
      case 'string_list':
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim()))
          problem = 'Enter one or more values'
        break
      case 'number_list':
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'number' || !Number.isFinite(item)))
          problem = 'Enter whole numbers separated by commas'
        else
          for (const item of value as number[]) {
            const issue = validateNumber(field, item)
            if (issue) {
              problem = issue
              break
            }
          }
        break
    }
    if (problem) errors[field.key] = problem
  }
  for (const key of Object.keys(config)) {
    if (known.has(key)) continue
    if (key === SCRIPT_PARAMETERS_KEY && hasScript) {
      const params = config[key]
      if (params !== null && (typeof params !== 'object' || Array.isArray(params))) errors[key] = 'Must be an object'
      continue
    }
    errors[key] = `Unknown setting “${key}”`
  }
  return errors
}

/** Drops blank optional values so the stored policy stays tidy. Required and default-valued keys are kept. */
export function cleanConfig(schema: CheckFieldSchema[], config: CheckConfig): CheckConfig {
  const out: CheckConfig = {}
  for (const [key, value] of Object.entries(config)) {
    const field = schema.find((item) => item.key === key)
    if (isBlank(value) && !field?.required) continue
    if (key === SCRIPT_PARAMETERS_KEY && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, ParameterValue>).filter(([, item]) => item !== undefined),
      )
      continue
    }
    out[key] = value
  }
  return out
}

function formatValue(field: CheckFieldSchema, value: CheckConfigValue): string | null {
  if (isBlank(value)) return null
  const unit = field.unit ? (field.unit === '%' ? '%' : ` ${field.unit}`) : ''
  if (typeof value === 'boolean') return value ? field.label : null
  if (Array.isArray(value)) return `${field.label}: ${value.join(', ')}`
  if (typeof value === 'number') return `${field.label} ${value}${unit}`
  if (typeof value === 'string') return optionLabel(value)
  return null
}

/** A one-line summary of a check's configuration, e.g. "Warning at 85% · Critical at 95% · Window 5 min". */
export function describeConfig(definition: Pick<CheckTypeDefinition, 'config_schema'> | undefined, config: CheckConfig = {}, max = 3): string {
  if (!definition) {
    const entries = Object.entries(config).filter(([key, value]) => key !== SCRIPT_PARAMETERS_KEY && !isBlank(value))
    return entries
      .slice(0, max)
      .map(([key, value]) => `${key} ${Array.isArray(value) ? value.join(', ') : String(value)}`)
      .join(' · ')
  }
  const parts: string[] = []
  for (const field of definition.config_schema) {
    if (field.type === 'script') continue
    const value = config[field.key] === undefined ? field.default : config[field.key]
    const text = formatValue(field, value)
    if (text) parts.push(text)
    if (parts.length >= max) break
  }
  return parts.join(' · ')
}

const numberOf = (schema: CheckFieldSchema[], config: CheckConfig, key: string): number | null => {
  const value = config[key] === undefined ? schema.find((field) => field.key === key)?.default : config[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Rules that span fields, as the server applies them: critical thresholds beyond warning ones, a disk
 * check with at least one threshold, and conditional fields of certificate and file checks.
 */
export function crossFieldErrors(type: string, schema: CheckFieldSchema[], config: CheckConfig): Record<string, string> {
  const errors: Record<string, string> = {}
  const value = (key: string) => numberOf(schema, config, key)
  const text = (key: string) => {
    const raw = config[key] === undefined ? schema.find((field) => field.key === key)?.default : config[key]
    return typeof raw === 'string' ? raw : ''
  }
  const atLeast = (crit: string, warn: string, message: string) => {
    const c = value(crit)
    const w = value(warn)
    if (c !== null && w !== null && c < w) errors[crit] = message
  }
  const atMost = (crit: string, warn: string, message: string) => {
    const c = value(crit)
    const w = value(warn)
    if (c !== null && w !== null && c > w) errors[crit] = message
  }
  switch (type) {
    case 'cpu':
    case 'memory':
      atLeast('crit_pct', 'warn_pct', 'Must be at least the warning threshold')
      break
    case 'uptime':
      atLeast('crit_days', 'warn_days', 'Must be at least the warning threshold')
      break
    case 'certificate':
      atMost('crit_days', 'warn_days', 'Must be no more than the warning threshold')
      if (text('source') === 'file' && !text('path').trim()) errors.path = 'Enter the certificate file path'
      break
    case 'disk':
      if (['warn_free_pct', 'crit_free_pct', 'warn_free_gb', 'crit_free_gb'].every((key) => value(key) === null))
        errors.warn_free_pct = 'Set at least one threshold'
      atMost('crit_free_pct', 'warn_free_pct', 'Must be no more than the warning threshold')
      atMost('crit_free_gb', 'warn_free_gb', 'Must be no more than the warning threshold')
      break
    case 'file':
      if (text('condition') === 'older_than' && value('minutes') === null) errors.minutes = 'Enter an age'
      if (text('condition') === 'larger_than' && value('size_mb') === null) errors.size_mb = 'Enter a size'
      break
  }
  return errors
}

/** Field validation plus the cross-field rules for a check type. */
export function validateCheckConfig(definition: Pick<CheckTypeDefinition, 'type' | 'config_schema'>, config: CheckConfig): Record<string, string> {
  return { ...crossFieldErrors(definition.type, definition.config_schema, config), ...validateConfig(definition.config_schema, config) }
}
