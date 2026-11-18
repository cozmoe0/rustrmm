import { describe, expect, it } from 'vitest'
import { MAX_IMPORT_ROWS, parseCsv, previewContactsCsv } from './csv'

const SITES = [
  { id: 's-main', name: 'Main Clinic' },
  { id: 's-east', name: 'Eastside Clinic' },
]

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, embedded separators and line ends', () => {
    const text = '﻿name,notes\r\n"Reyes, Dana","She said ""hi""\nthen left"\rBob,plain\n'
    expect(parseCsv(text)).toEqual([
      ['name', 'notes'],
      ['Reyes, Dana', 'She said "hi"\nthen left'],
      ['Bob', 'plain'],
    ])
  })

  it('keeps empty fields and blank lines', () => {
    expect(parseCsv('a,,c\n\nd')).toEqual([['a', '', 'c'], [''], ['d']])
  })
})

describe('previewContactsCsv', () => {
  it('matches headers case-insensitively in any order and ignores extra columns', () => {
    const preview = previewContactsCsv('Email,NAME,Department,site\ndana@example.com,Dana Reyes,Front desk,main clinic\n', {
      sites: SITES,
      existingEmails: [],
    })
    expect(preview.fileError).toBeNull()
    expect(preview.ignoredColumns).toEqual(['Department'])
    expect(preview.rows).toEqual([
      expect.objectContaining({ row: 2, name: 'Dana Reyes', email: 'dana@example.com', site_id: 's-main', action: 'create', errors: [] }),
    ])
  })

  it('refuses a header without the required columns', () => {
    const preview = previewContactsCsv('name,phone\nDana,123\n', { sites: SITES, existingEmails: [] })
    expect(preview.fileError).toMatch(/missing “email”/)
    expect(preview.missingColumns).toEqual(['email'])
    expect(preview.rows).toEqual([])
  })

  it('validates each row and numbers rows from the header', () => {
    const csv = [
      'name,email,phone,title,site',
      'Dana Reyes,DANA@example.com,,,',
      ',nobody@example.com,,,',
      'Sam Ortiz,not-an-address,,,',
      'Dana Twin,dana@example.com,,,',
      'Lee Park,lee@example.com,,,Basement',
      'Ana Silva,ana@example.com,555,Nurse,Eastside Clinic',
      '',
    ].join('\n')
    const preview = previewContactsCsv(csv, { sites: SITES, existingEmails: ['dana@example.com'] })
    const byRow = Object.fromEntries(preview.rows.map((row) => [row.row, row]))
    expect(byRow[2].action).toBe('update')
    expect(byRow[3].errors).toContain('Name is required')
    expect(byRow[4].errors[0]).toMatch(/not an email address/)
    expect(byRow[5].errors).toContain('Same email as row 2')
    expect(byRow[6].errors[0]).toMatch(/No site named “Basement”/)
    expect(byRow[7]).toMatchObject({ action: 'create', site_id: 's-east', title: 'Nurse' })
    expect(preview).toMatchObject({ creates: 1, updates: 1, invalid: 4 })
  })

  it('reports empty files, missing rows and oversized files', () => {
    expect(previewContactsCsv('', { sites: [], existingEmails: [] }).fileError).toBe('The file is empty.')
    expect(previewContactsCsv('name,email\n', { sites: [], existingEmails: [] }).fileError).toMatch(/no contacts/)
    const big = ['name,email', ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, index) => `P${index},p${index}@example.com`)].join('\n')
    expect(previewContactsCsv(big, { sites: [], existingEmails: [] }).fileError).toMatch(/limit is 10,000/)
  })
})
