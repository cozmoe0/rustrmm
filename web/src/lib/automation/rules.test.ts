import { describe, expect, it } from 'vitest'
import type { CustomField, RuleDocument } from '@/lib/api/types'
import {
  MAX_RULE_CONDITIONS,
  appendNode,
  canNestAt,
  changeField,
  changeOperator,
  countConditions,
  describeRules,
  evaluateRules,
  findField,
  getNode,
  newCondition,
  newGroup,
  operatorsFor,
  removeNode,
  ruleDepth,
  ruleFieldCatalog,
  setMatch,
  updateNode,
  validateRules,
  type DeviceFacts,
} from './rules'

const customFields: CustomField[] = [
  {
    id: '1',
    key: 'patch_ring',
    name: 'Patch ring',
    description: '',
    type: 'select',
    options: ['Pilot', 'Broad'],
    scope: 'device',
    script_writable: false,
    created_at: '',
  },
  {
    id: '2',
    key: 'warranty_end',
    name: 'Warranty ends',
    description: '',
    type: 'date',
    options: [],
    scope: 'device',
    script_writable: false,
    created_at: '',
  },
  {
    id: '3',
    key: 'contract_tier',
    name: 'Contract tier',
    description: '',
    type: 'select',
    options: ['Gold'],
    scope: 'client',
    script_writable: false,
    created_at: '',
  },
]
const fields = ruleFieldCatalog(customFields)

const doc: RuleDocument = {
  match: 'all',
  conditions: [
    { field: 'os_family', op: 'eq', value: 'windows' },
    {
      match: 'any',
      conditions: [
        { field: 'tag', op: 'eq', value: 'vip' },
        { field: 'health_score', op: 'lt', value: 70 },
      ],
    },
  ],
}

describe('rule catalog', () => {
  it('adds device custom fields as custom.<key> with their types', () => {
    expect(findField(fields, 'custom.patch_ring')).toMatchObject({ type: 'enum', group: 'Custom fields' })
    expect(findField(fields, 'custom.warranty_end')?.type).toBe('date')
    expect(findField(fields, 'custom.contract_tier')).toBeUndefined()
  })

  it('offers operators per field type', () => {
    expect(operatorsFor('text')).toContain('matches')
    expect(operatorsFor('number')).toEqual(expect.arrayContaining(['gt', 'lte']))
    expect(operatorsFor('number')).not.toContain('contains')
    expect(operatorsFor('boolean')).toEqual(['eq', 'neq', 'exists', 'not_exists'])
    expect(operatorsFor('enum')).not.toContain('gt')
  })
})

describe('rule document editing', () => {
  it('reads and updates nodes by path without mutating', () => {
    const next = updateNode(doc, [1, 0], () => ({ field: 'tag', op: 'eq', value: 'partner' }))
    expect(getNode(next, [1, 0])).toEqual({ field: 'tag', op: 'eq', value: 'partner' })
    expect(getNode(doc, [1, 0])).toEqual({ field: 'tag', op: 'eq', value: 'vip' })
    expect(getNode(doc, [5])).toBeUndefined()
  })

  it('appends, removes and switches match mode', () => {
    const appended = appendNode(doc, [1], newCondition())
    expect(countConditions(appended)).toBe(4)
    const removed = removeNode(appended, [1, 2])
    expect(removed).toEqual(doc)
    expect(setMatch(doc, [1], 'all').conditions[1]).toMatchObject({ match: 'all' })
    expect(removeNode(doc, [])).toEqual({ match: 'all', conditions: [] })
  })

  it('tracks depth and nesting limits', () => {
    expect(ruleDepth({ match: 'all', conditions: [] })).toBe(1)
    expect(ruleDepth(doc)).toBe(2)
    expect(canNestAt([])).toBe(true)
    expect(canNestAt([1])).toBe(true)
    expect(canNestAt([1, 0])).toBe(false)
  })

  it('keeps compatible operators and resets values when the field changes type', () => {
    const condition = { field: 'hostname', op: 'contains' as const, value: 'NWD' }
    expect(changeField(condition, findField(fields, 'os_name')!, findField(fields, 'hostname'))).toEqual({
      field: 'os_name',
      op: 'contains',
      value: '',
    })
    expect(changeField(condition, findField(fields, 'health_score')!, findField(fields, 'hostname'))).toEqual({
      field: 'health_score',
      op: 'eq',
      value: '',
    })
    expect(changeField(condition, findField(fields, 'online')!)).toEqual({ field: 'online', op: 'eq', value: true })
    expect(changeField(condition, findField(fields, 'os_family')!)).toEqual({
      field: 'os_family',
      op: 'eq',
      value: 'windows',
    })
  })

  it('converts values between scalar, list and presence operators', () => {
    const condition = { field: 'hostname', op: 'eq' as const, value: 'A' }
    expect(changeOperator(condition, 'in').value).toEqual(['A'])
    expect(changeOperator({ ...condition, op: 'in', value: ['B', 'C'] }, 'eq').value).toBe('B')
    expect(changeOperator(condition, 'exists').value).toBeNull()
    expect(
      changeOperator({ ...condition, op: 'exists', value: null }, 'contains', findField(fields, 'hostname')).value,
    ).toBe('')
  })
})

describe('rule validation', () => {
  it('accepts a well-formed document', () => {
    expect(validateRules(doc, fields)).toEqual([])
  })

  it('reports empty documents and groups', () => {
    expect(validateRules({ match: 'all', conditions: [] }, fields)[0].message).toMatch(/at least one condition/)
    const issues = validateRules({ match: 'all', conditions: [{ match: 'any', conditions: [] }] }, fields)
    expect(issues).toEqual([{ path: [0], message: 'This group is empty' }])
  })

  it('checks fields, operators and value types', () => {
    const issues = validateRules(
      {
        match: 'any',
        conditions: [
          { field: 'nope', op: 'eq', value: 'x' },
          { field: 'health_score', op: 'contains', value: '5' },
          { field: 'health_score', op: 'gt', value: 'high' },
          { field: 'os_family', op: 'eq', value: 'beos' },
          { field: 'tag', op: 'in', value: [] },
          { field: 'custom.warranty_end', op: 'lt', value: 'soon' },
          { field: 'pending_reboot', op: 'exists', value: null },
        ],
      },
      fields,
    )
    expect(issues.map((issue) => issue.path[0])).toEqual([0, 1, 2, 3, 4, 5])
    expect(issues[0].message).toMatch(/Unknown field/)
    expect(issues[4].message).toMatch(/at least one value/)
  })

  it('limits regular expressions', () => {
    expect(
      validateRules({ match: 'all', conditions: [{ field: 'hostname', op: 'matches', value: '(' }] }, fields)[0]
        .message,
    ).toMatch(/not valid/)
    expect(
      validateRules(
        { match: 'all', conditions: [{ field: 'hostname', op: 'matches', value: 'a'.repeat(201) }] },
        fields,
      )[0].message,
    ).toMatch(/200 characters/)
  })

  it('enforces the depth and size limits', () => {
    const deep: RuleDocument = {
      match: 'all',
      conditions: [{ match: 'any', conditions: [{ match: 'all', conditions: [newGroup()] }] }],
    }
    expect(validateRules(deep, fields).some((issue) => /3 levels/.test(issue.message))).toBe(true)
    const big: RuleDocument = {
      match: 'any',
      conditions: Array.from({ length: MAX_RULE_CONDITIONS + 1 }, () => newCondition()),
    }
    expect(validateRules(big, fields)[0].message).toMatch(/at most 50 conditions/)
  })
})

describe('rule evaluation', () => {
  const base: DeviceFacts = {
    os_family: 'windows',
    tag: ['front-desk'],
    health_score: 92,
    hostname: 'NWD-FRONT-01',
    online: true,
    'custom.patch_ring': 'Pilot',
    disk_free_pct: 12,
  }

  it('evaluates nested all/any groups', () => {
    expect(evaluateRules(doc, base)).toBe(false)
    expect(evaluateRules(doc, { ...base, tag: ['vip'] })).toBe(true)
    expect(evaluateRules(doc, { ...base, health_score: 60 })).toBe(true)
    expect(evaluateRules(doc, { ...base, os_family: 'linux', tag: ['vip'] })).toBe(false)
  })

  it('matches list facts such as tags', () => {
    expect(evaluateRules({ match: 'all', conditions: [{ field: 'tag', op: 'neq', value: 'vip' }] }, base)).toBe(true)
    expect(evaluateRules({ match: 'all', conditions: [{ field: 'tag', op: 'contains', value: 'desk' }] }, base)).toBe(
      true,
    )
    expect(
      evaluateRules(
        { match: 'all', conditions: [{ field: 'tag', op: 'not_exists', value: null }] },
        { ...base, tag: [] },
      ),
    ).toBe(true)
  })

  it('compares text case-insensitively, numbers numerically and supports regex', () => {
    const one = (condition: RuleDocument['conditions'][number]) =>
      evaluateRules({ match: 'all', conditions: [condition] }, base)
    expect(one({ field: 'hostname', op: 'starts_with', value: 'nwd-' })).toBe(true)
    expect(one({ field: 'hostname', op: 'matches', value: '-front-\\d+$' })).toBe(true)
    expect(one({ field: 'disk_free_pct', op: 'lt', value: 15 })).toBe(true)
    expect(one({ field: 'health_score', op: 'in', value: [90, 92] })).toBe(true)
    expect(one({ field: 'custom.patch_ring', op: 'eq', value: 'pilot' })).toBe(true)
    expect(one({ field: 'custom.asset_tag', op: 'exists', value: null })).toBe(false)
    expect(one({ field: 'custom.asset_tag', op: 'neq', value: 'x' })).toBe(true)
  })
})

describe('rule descriptions', () => {
  it('reads like a sentence', () => {
    expect(describeRules(doc, fields)).toBe('OS family is Windows and (Tag is vip or Health score is less than 70)')
    expect(describeRules({ match: 'all', conditions: [{ field: 'disk_free_pct', op: 'lt', value: 15 }] }, fields)).toBe(
      'Lowest disk free is less than 15 %',
    )
    expect(describeRules({ match: 'any', conditions: [] }, fields)).toBe('No conditions')
    const lookup = (_field: unknown, id: string) => (id === 'c1' ? 'Northwind Dental' : undefined)
    expect(
      describeRules({ match: 'all', conditions: [{ field: 'client_id', op: 'in', value: ['c1'] }] }, fields, lookup),
    ).toBe('Client is any of Northwind Dental')
  })
})
