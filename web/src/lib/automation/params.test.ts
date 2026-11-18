import { describe, expect, it } from 'vitest'
import type { ScriptParameter } from '@/lib/api/types'
import {
  SECRET_MASK,
  changeParameterType,
  defaultParameterValues,
  displayParameterValue,
  envNameError,
  hasParameterIssues,
  isReservedName,
  newParameter,
  toApiParameters,
  validateParameterDefinitions,
  validateParameterValues,
} from './params'

const p = (overrides: Partial<ScriptParameter>): ScriptParameter => ({
  name: 'Name',
  label: '',
  description: '',
  type: 'string',
  required: false,
  default: null,
  ...overrides,
})

describe('environment names', () => {
  it('rejects reserved names case-insensitively and anything prefixed RUSTRMM_', () => {
    expect(isReservedName('path')).toBe(true)
    expect(isReservedName('LD_PRELOAD')).toBe(true)
    expect(isReservedName('rustrmm_device_id')).toBe(true)
    expect(isReservedName('ServiceName')).toBe(false)
    expect(envNameError('PsModulePath')).toMatch(/reserved/)
  })

  it('enforces the name pattern', () => {
    expect(envNameError('')).toBe('Enter a name')
    expect(envNameError('1Name')).toMatch(/start with a letter/)
    expect(envNameError('has-dash')).not.toBeNull()
    expect(envNameError('_private')).toBeNull()
    expect(envNameError(`A${'b'.repeat(63)}`)).toBeNull()
    expect(envNameError(`A${'b'.repeat(64)}`)).not.toBeNull()
  })
})

describe('parameter definitions', () => {
  it('flags duplicate names regardless of case', () => {
    const issues = validateParameterDefinitions([p({ name: 'Target' }), p({ name: 'target' })])
    expect(issues[0]).toEqual({})
    expect(issues[1].name).toMatch(/already uses/)
    expect(hasParameterIssues(issues)).toBe(true)
  })

  it('requires unique, non-empty options for choices and type-correct defaults', () => {
    expect(validateParameterDefinitions([p({ type: 'select', options: [] })])[0].options).toMatch(/at least one/)
    expect(validateParameterDefinitions([p({ type: 'select', options: ['a', 'a'] })])[0].options).toMatch(/unique/)
    expect(validateParameterDefinitions([p({ type: 'select', options: ['a'], default: 'b' })])[0].default).toMatch(
      /options/,
    )
    expect(validateParameterDefinitions([p({ type: 'number', default: 'many' })])[0].default).toBe('Enter a number')
    expect(validateParameterDefinitions([p({ type: 'number', default: 7 })])[0]).toEqual({})
  })

  it('creates unique placeholder parameters', () => {
    expect(newParameter([p({ name: 'Param1' })]).name).toBe('Param2')
  })

  it('keeps definitions valid when the type changes', () => {
    expect(changeParameterType(p({ default: '42' }), 'number').default).toBe(42)
    expect(changeParameterType(p({ default: 'abc' }), 'number').default).toBeNull()
    expect(changeParameterType(p({ default: 'x' }), 'select')).toMatchObject({ options: ['Option 1'], default: null })
    expect(changeParameterType(p({ default: 'hunter2' }), 'secret').default).toBeNull()
    expect(changeParameterType(p({ type: 'select', options: ['a'], default: 'a' }), 'string')).not.toHaveProperty(
      'options',
    )
    expect(changeParameterType(p({ default: 'true' }), 'boolean').default).toBe(true)
  })
})

describe('parameter values', () => {
  const params = [
    p({ name: 'Target', label: 'Host', required: true }),
    p({ name: 'Port', type: 'number', default: 443 }),
    p({ name: 'Restart', type: 'boolean', default: true, required: true }),
    p({ name: 'Mode', type: 'select', options: ['Quick', 'Full'] }),
    p({ name: 'Password', type: 'secret', required: true }),
  ]

  it('starts from defaults with empty secrets', () => {
    expect(defaultParameterValues(params)).toEqual({ Target: '', Port: 443, Restart: true, Mode: '', Password: '' })
  })

  it('validates required fields, numbers and choices', () => {
    expect(validateParameterValues(params, defaultParameterValues(params))).toEqual({
      Target: 'Host is required',
      Password: 'Password is required',
    })
    const errors = validateParameterValues(params, {
      Target: 'x',
      Port: '44x',
      Restart: false,
      Mode: 'Turbo',
      Password: 'pw',
    })
    expect(errors).toEqual({ Port: 'Enter a number', Mode: 'Choose one of the options' })
  })

  it('serialises values for the API', () => {
    expect(
      toApiParameters(params, { Target: ' db01 ', Port: '8443', Restart: false, Mode: '', Password: 's3cret' }),
    ).toEqual({
      Target: ' db01 ',
      Port: 8443,
      Restart: false,
      Password: 's3cret',
    })
  })

  it('never displays secrets', () => {
    expect(displayParameterValue({ type: 'secret' }, 'hunter2')).toBe(SECRET_MASK)
    expect(displayParameterValue(undefined, SECRET_MASK)).toBe(SECRET_MASK)
    expect(displayParameterValue({ type: 'boolean' }, false)).toBe('No')
    expect(displayParameterValue({ type: 'string' }, '')).toBe('—')
  })
})
