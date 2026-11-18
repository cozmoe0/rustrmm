/*
 * CSV parsing (RFC 4180: quoted fields, doubled quotes, CRLF/LF/CR line ends, a leading BOM) and the
 * contact-import preview. The preview applies the server's rules before upload so each row shows
 * whether it creates, updates or fails: headers match case-insensitively in any order (extra columns
 * are ignored), `name` and `email` are required, rows match existing contacts by e-mail, `site` matches
 * a site name within the client, and row numbers count the header as row 1.
 */

export const CONTACT_COLUMNS = ['name', 'email', 'phone', 'title', 'site'] as const
export type ContactColumn = (typeof CONTACT_COLUMNS)[number]
export const REQUIRED_COLUMNS: ContactColumn[] = ['name', 'email']
export const MAX_IMPORT_ROWS = 10_000
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024

/** Splits CSV text into records of fields. Blank lines yield a record with one empty field. */
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  let index = 0
  while (index < input.length) {
    const char = input[index]
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        quoted = false
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }
    if (char === '"' && field === '') {
      quoted = true
      index += 1
      continue
    }
    if (char === ',') {
      record.push(field)
      field = ''
      index += 1
      continue
    }
    if (char === '\r' || char === '\n') {
      record.push(field)
      records.push(record)
      record = []
      field = ''
      index += char === '\r' && input[index + 1] === '\n' ? 2 : 1
      continue
    }
    field += char
    index += 1
  }
  if (field !== '' || record.length > 0) {
    record.push(field)
    records.push(record)
  }
  return records
}

const EMAIL = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/

export function isEmail(value: string): boolean {
  return EMAIL.test(value.trim())
}

export type ImportAction = 'create' | 'update' | 'invalid'

export interface ContactCsvRow {
  /** 1-based; the header is row 1. */
  row: number
  name: string
  email: string
  phone: string
  title: string
  site: string
  site_id: string | null
  action: ImportAction
  errors: string[]
  warnings: string[]
}

export interface ContactCsvPreview {
  rows: ContactCsvRow[]
  /** A problem with the file as a whole (no header, missing columns, too many rows). */
  fileError: string | null
  missingColumns: ContactColumn[]
  ignoredColumns: string[]
  creates: number
  updates: number
  invalid: number
}

export interface ImportContext {
  sites: { id: string; name: string }[]
  /** Addresses of the client's existing contacts (matched case-insensitively). */
  existingEmails: string[]
}

function emptyPreview(fileError: string, missing: ContactColumn[] = [], ignored: string[] = []): ContactCsvPreview {
  return { rows: [], fileError, missingColumns: missing, ignoredColumns: ignored, creates: 0, updates: 0, invalid: 0 }
}

export function previewContactsCsv(text: string, context: ImportContext): ContactCsvPreview {
  const records = parseCsv(text)
  const blank = (record: string[]) => record.every((cell) => cell.trim() === '')
  const headerIndex = records.findIndex((record) => !blank(record))
  if (headerIndex !== 0) return emptyPreview(headerIndex < 0 ? 'The file is empty.' : 'The first line must be the header row.')
  const header = records[0].map((cell) => cell.trim().toLowerCase())
  const columns = new Map<ContactColumn, number>()
  const ignored: string[] = []
  header.forEach((name, index) => {
    if ((CONTACT_COLUMNS as readonly string[]).includes(name) && !columns.has(name as ContactColumn)) columns.set(name as ContactColumn, index)
    else if (name) ignored.push(records[0][index].trim())
  })
  const missing = REQUIRED_COLUMNS.filter((column) => !columns.has(column))
  if (missing.length) {
    return emptyPreview(`The header is missing ${missing.map((column) => `“${column}”`).join(' and ')}.`, missing, ignored)
  }
  const data = records.slice(1)
  // A trailing blank line is not a row.
  while (data.length && blank(data[data.length - 1])) data.pop()
  if (data.length > MAX_IMPORT_ROWS) return emptyPreview(`The file has ${data.length.toLocaleString()} rows; the limit is ${MAX_IMPORT_ROWS.toLocaleString()}.`, [], ignored)

  const existing = new Set(context.existingEmails.map((email) => email.trim().toLowerCase()))
  const siteByName = new Map(context.sites.map((site) => [site.name.trim().toLowerCase(), site.id]))
  const seen = new Map<string, number>()
  const rows: ContactCsvRow[] = []
  data.forEach((record, index) => {
    if (blank(record)) return
    const cell = (column: ContactColumn) => {
      const position = columns.get(column)
      return position === undefined ? '' : (record[position] ?? '').trim()
    }
    const row: ContactCsvRow = {
      row: index + 2,
      name: cell('name'),
      email: cell('email'),
      phone: cell('phone'),
      title: cell('title'),
      site: cell('site'),
      site_id: null,
      action: 'create',
      errors: [],
      warnings: [],
    }
    if (!row.name) row.errors.push('Name is required')
    else if (row.name.length > 200) row.errors.push('Name is longer than 200 characters')
    if (!row.email) row.errors.push('Email is required')
    else if (!isEmail(row.email)) row.errors.push(`“${row.email}” is not an email address`)
    const key = row.email.toLowerCase()
    if (row.email && isEmail(row.email)) {
      const first = seen.get(key)
      if (first !== undefined) row.errors.push(`Same email as row ${first}`)
      else seen.set(key, row.row)
    }
    if (row.site) {
      const siteId = siteByName.get(row.site.toLowerCase())
      if (siteId) row.site_id = siteId
      else row.errors.push(`No site named “${row.site}” for this client`)
    }
    row.action = row.errors.length ? 'invalid' : existing.has(key) ? 'update' : 'create'
    rows.push(row)
  })
  return {
    rows,
    fileError: rows.length === 0 ? 'The file has a header but no contacts.' : null,
    missingColumns: [],
    ignoredColumns: ignored,
    creates: rows.filter((row) => row.action === 'create').length,
    updates: rows.filter((row) => row.action === 'update').length,
    invalid: rows.filter((row) => row.action === 'invalid').length,
  }
}

/** A template file for the import dialog. */
export const CONTACT_CSV_TEMPLATE = 'name,email,phone,title,site\nDana Reyes,dana@example.com,+1 555 0100,Office manager,Main Clinic\n'
