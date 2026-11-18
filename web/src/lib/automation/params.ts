/*
 * Script parameters: definition validation for the parameter builder and value validation for the
 * generated run form. Mirrors the server's checks so mistakes surface before a request is sent.
 */
import type { ParameterType, ParameterValue, ScriptParameter } from '@/lib/api/types'

export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** Rejected for both parameters and variables, case-insensitively, plus any `RUSTRMM_` prefix. */
export const RESERVED_ENV_NAMES = [
  'PATH',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'SHELL',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'PSMODULEPATH',
] as const

export const SECRET_MASK = '••••••'

export const PARAMETER_TYPE_LABEL: Record<ParameterType, string> = {
  string: 'Text',
  number: 'Number',
  boolean: 'Yes / no',
  select: 'Choice',
  secret: 'Secret',
}

export function isReservedName(name: string): boolean {
  const upper = name.trim().toUpperCase()
  return upper.startsWith('RUSTRMM_') || (RESERVED_ENV_NAMES as readonly string[]).includes(upper)
}

/** Validation message for a parameter or variable name, or null when it is acceptable. */
export function envNameError(name: string): string | null {
  const value = name.trim()
  if (!value) return 'Enter a name'
  if (!NAME_PATTERN.test(value))
    return 'Use letters, digits and underscores; start with a letter or underscore (max 64)'
  if (isReservedName(value)) return `${value} is reserved for the agent's environment`
  return null
}

export type ParameterField = 'name' | 'label' | 'options' | 'default'
export type ParameterIssues = Partial<Record<ParameterField, string>>

/** Per-parameter problems, indexed like the input array. An empty object means the definition is valid. */
export function validateParameterDefinitions(params: ScriptParameter[]): ParameterIssues[] {
  const seen = new Map<string, number>()
  params.forEach((param, index) => {
    const key = param.name.trim().toUpperCase()
    if (key && !seen.has(key)) seen.set(key, index)
  })
  return params.map((param, index) => {
    const issues: ParameterIssues = {}
    const nameProblem = envNameError(param.name)
    if (nameProblem) issues.name = nameProblem
    else if (seen.get(param.name.trim().toUpperCase()) !== index)
      issues.name = 'Another parameter already uses this name'
    if (param.label.length > 80) issues.label = 'Keep the label under 80 characters'
    if (param.type === 'select') {
      const options = param.options ?? []
      if (options.length === 0) issues.options = 'Add at least one option'
      else if (new Set(options).size !== options.length) issues.options = 'Options must be unique'
      else if (options.some((option) => !option.trim())) issues.options = 'Options cannot be empty'
    }
    const defaultProblem = param.default === null || param.default === '' ? null : valueError(param, param.default)
    if (defaultProblem) issues.default = defaultProblem
    return issues
  })
}

export function hasParameterIssues(issues: ParameterIssues[]): boolean {
  return issues.some((item) => Object.keys(item).length > 0)
}

/** A fresh parameter with a unique placeholder name. */
export function newParameter(existing: ScriptParameter[]): ScriptParameter {
  let index = existing.length + 1
  const taken = new Set(existing.map((param) => param.name.toUpperCase()))
  while (taken.has(`PARAM${index}`)) index += 1
  return { name: `Param${index}`, label: '', description: '', type: 'string', required: false, default: null }
}

/** Switching type keeps the definition valid: defaults are coerced or cleared, options added or dropped. */
export function changeParameterType(param: ScriptParameter, type: ParameterType): ScriptParameter {
  const next: ScriptParameter = { ...param, type }
  if (type === 'select') next.options = param.options?.length ? param.options : ['Option 1']
  else delete next.options
  if (type === 'secret') next.default = null
  else if (type === 'boolean') next.default = param.default === true || param.default === 'true'
  else if (type === 'number') {
    const parsed = typeof param.default === 'number' ? param.default : Number(param.default)
    next.default = param.default !== null && param.default !== '' && Number.isFinite(parsed) ? parsed : null
  } else if (type === 'select') {
    next.default = typeof param.default === 'string' && next.options!.includes(param.default) ? param.default : null
  } else next.default = param.default === null ? null : String(param.default)
  return next
}

// ------------------------------------------------------------------ values

function valueError(param: ScriptParameter, value: ParameterValue): string | null {
  switch (param.type) {
    case 'number': {
      const parsed = typeof value === 'number' ? value : Number(String(value).trim())
      return Number.isFinite(parsed) && String(value).trim() !== '' ? null : 'Enter a number'
    }
    case 'boolean':
      return typeof value === 'boolean' || value === 'true' || value === 'false' ? null : 'Choose yes or no'
    case 'select':
      return (param.options ?? []).includes(String(value)) ? null : 'Choose one of the options'
    default:
      return String(value).length > 4096 ? 'Keep values under 4,096 characters' : null
  }
}

/** The run form's initial values: each parameter's default, or an empty value. */
export function defaultParameterValues(params: ScriptParameter[]): Record<string, ParameterValue> {
  const values: Record<string, ParameterValue> = {}
  for (const param of params) {
    if (param.type === 'boolean') values[param.name] = param.default === true
    else if (param.type === 'secret') values[param.name] = ''
    else values[param.name] = param.default ?? ''
  }
  return values
}

function isEmpty(value: ParameterValue | undefined): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

/** Errors keyed by parameter name; an empty object means the values can be submitted. */
export function validateParameterValues(
  params: ScriptParameter[],
  values: Record<string, ParameterValue | undefined>,
): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const param of params) {
    const value = values[param.name]
    if (isEmpty(value)) {
      if (param.required && param.type !== 'boolean') errors[param.name] = `${param.label || param.name} is required`
      continue
    }
    const problem = valueError(param, value as ParameterValue)
    if (problem) errors[param.name] = problem
  }
  return errors
}

/** Values in API form: numbers parsed, booleans real, empty optional values left out. */
export function toApiParameters(
  params: ScriptParameter[],
  values: Record<string, ParameterValue | undefined>,
): Record<string, ParameterValue> {
  const out: Record<string, ParameterValue> = {}
  for (const param of params) {
    const value = values[param.name]
    if (param.type === 'boolean') {
      out[param.name] = value === true || value === 'true'
      continue
    }
    if (isEmpty(value)) continue
    out[param.name] = param.type === 'number' ? Number(String(value).trim()) : String(value)
  }
  return out
}

/** A readable value for summaries; secrets are always masked. */
export function displayParameterValue(param: Pick<ScriptParameter, 'type'> | undefined, value: ParameterValue): string {
  if (param?.type === 'secret' || value === SECRET_MASK) return SECRET_MASK
  if (value === null || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}
