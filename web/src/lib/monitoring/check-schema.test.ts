import { describe, expect, it } from 'vitest'
import type { CheckFieldSchema } from '@/lib/api/types'
import {
  buildForm,
  cleanConfig,
  coerceInput,
  defaultConfig,
  describeConfig,
  setConfigValue,
  validateConfig,
} from './check-schema'

const CPU: CheckFieldSchema[] = [
  { key: 'warn_pct', label: 'Warning at', type: 'number', required: true, default: 85, min: 1, max: 100, unit: '%' },
  { key: 'crit_pct', label: 'Critical at', type: 'number', required: true, default: 95, min: 1, max: 100, unit: '%' },
  { key: 'window_minutes', label: 'Window', type: 'number', required: true, default: 5, min: 1, max: 60, unit: 'min' },
]

const SERVICE: CheckFieldSchema[] = [
  { key: 'name', label: 'Service name', type: 'text', required: true, default: null },
  { key: 'expected', label: 'Expected state', type: 'select', required: true, default: 'running', options: ['running', 'stopped'] },
  { key: 'auto_restart', label: 'Restart automatically', type: 'boolean', required: false, default: false },
]

const EVENT_LOG: CheckFieldSchema[] = [
  { key: 'log', label: 'Log', type: 'text', required: true, default: 'System' },
  { key: 'source', label: 'Source', type: 'text', required: false, default: null },
  { key: 'event_ids', label: 'Event IDs', type: 'number_list', required: false, default: null, min: 0, max: 65535 },
  { key: 'targets', label: 'Hosts', type: 'string_list', required: false, default: null },
]

const SCRIPT: CheckFieldSchema[] = [
  { key: 'script_id', label: 'Script', type: 'script', required: true, default: null },
  { key: 'timeout_secs', label: 'Timeout', type: 'number', required: true, default: 60, min: 5, max: 3600, unit: 's' },
]

describe('check config form generator', () => {
  it('starts from the schema defaults and skips null defaults', () => {
    expect(defaultConfig(CPU)).toEqual({ warn_pct: 85, crit_pct: 95, window_minutes: 5 })
    expect(defaultConfig(SERVICE)).toEqual({ expected: 'running', auto_restart: false })
  })

  it('builds field models with values, options and range hints', () => {
    const fields = buildForm(SERVICE, { name: 'Spooler' })
    expect(fields.map((field) => field.key)).toEqual(['name', 'expected', 'auto_restart'])
    expect(fields[0]).toMatchObject({ value: 'Spooler', set: true, required: true })
    expect(fields[1]).toMatchObject({ value: 'running', set: false })
    expect(fields[1].options).toEqual([
      { value: 'running', label: 'Running' },
      { value: 'stopped', label: 'Stopped' },
    ])
    expect(buildForm(CPU)[0].hint).toBe('Between 1 and 100 %')
  })

  it('coerces raw input by field type', () => {
    expect(coerceInput('number', '42')).toBe(42)
    expect(coerceInput('number', '')).toBeUndefined()
    expect(coerceInput('number', 'abc')).toBe('abc')
    expect(coerceInput('boolean', 1)).toBe(true)
    expect(coerceInput('string_list', 'a, b, a,,')).toEqual(['a', 'b'])
    expect(coerceInput('number_list', '41, 6008, 41')).toEqual([41, 6008])
    expect(coerceInput('number_list', '41, x')).toEqual(['41', 'x'])
    expect(coerceInput('text', '  ')).toBeUndefined()
  })

  it('sets and clears values, dropping script parameters when the script changes', () => {
    const config = setConfigValue({ script_id: 'a', parameters: { X: 1 } }, SCRIPT[0], 'b')
    expect(config).toEqual({ script_id: 'b' })
    expect(setConfigValue({ source: 'Disk' }, EVENT_LOG[1], '')).toEqual({})
  })

  it('validates required fields, ranges, options, lists and unknown keys', () => {
    expect(validateConfig(CPU, {})).toEqual({})
    expect(validateConfig(CPU, { warn_pct: 0, crit_pct: 101, window_minutes: 'x' as never })).toEqual({
      warn_pct: 'Must be at least 1 %',
      crit_pct: 'Must be at most 100 %',
      window_minutes: 'Enter a number',
    })
    expect(validateConfig(SERVICE, { expected: 'paused' })).toEqual({
      name: 'Required',
      expected: 'Choose one of: Running, Stopped',
    })
    expect(validateConfig(EVENT_LOG, { event_ids: [41, 70000], targets: ['ok', ''], bogus: 1 })).toEqual({
      event_ids: 'Must be at most 65535',
      targets: 'Enter one or more values',
      bogus: 'Unknown setting “bogus”',
    })
    expect(validateConfig(SCRIPT, {})).toEqual({ script_id: 'Choose a script' })
    expect(validateConfig(SCRIPT, { script_id: 's1', parameters: { Days: 7 } })).toEqual({})
  })

  it('cleans blank optional values before saving', () => {
    expect(cleanConfig(EVENT_LOG, { log: 'System', source: '', event_ids: [], targets: null })).toEqual({ log: 'System' })
  })

  it('summarises a config in one line', () => {
    expect(describeConfig({ config_schema: CPU }, { warn_pct: 80 })).toBe('Warning at 80% · Critical at 95% · Window 5 min')
    expect(describeConfig({ config_schema: SERVICE }, { name: 'Spooler', auto_restart: true })).toBe(
      'Spooler · Running · Restart automatically',
    )
    expect(describeConfig(undefined, { name: 'x', parameters: {} })).toBe('name x')
  })
})
