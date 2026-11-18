/*
 * Canned-response placeholders (`{{contact.first_name}}`, …), filled the way the server's render
 * endpoint fills them: known placeholders with missing values render empty, unknown ones stay as
 * written. The composer uses this for its preview and resolves what it previews before posting.
 */
import { firstName } from './labels'

export interface PlaceholderContext {
  contact?: { name: string } | null
  ticket?: { number: number; subject: string } | null
  technician?: { name: string } | null
  client?: { name: string } | null
}

export const PLACEHOLDERS: { key: string; label: string; sample: string }[] = [
  { key: 'contact.first_name', label: 'Contact first name', sample: 'Dana' },
  { key: 'contact.name', label: 'Contact name', sample: 'Dana Reyes' },
  { key: 'ticket.number', label: 'Ticket number', sample: '1042' },
  { key: 'ticket.subject', label: 'Ticket subject', sample: 'Printer offline in reception' },
  { key: 'technician.name', label: 'Your name', sample: 'Avery Chen' },
  { key: 'client.name', label: 'Client name', sample: 'Northwind Dental' },
]

const PATTERN = /\{\{([a-z_]+\.[a-z_]+)\}\}/g

function valueFor(key: string, context: PlaceholderContext): string | undefined {
  switch (key) {
    case 'contact.first_name':
      return firstName(context.contact?.name)
    case 'contact.name':
      return context.contact?.name ?? ''
    case 'ticket.number':
      return context.ticket ? String(context.ticket.number) : ''
    case 'ticket.subject':
      return context.ticket?.subject ?? ''
    case 'technician.name':
      return context.technician?.name ?? ''
    case 'client.name':
      return context.client?.name ?? ''
    default:
      return undefined
  }
}

/** Replaces the known placeholders in `body`. */
export function renderPlaceholders(body: string, context: PlaceholderContext): string {
  return body.replace(PATTERN, (match, key: string) => valueFor(key, context) ?? match)
}

/** The distinct known placeholders used in `body`. */
export function usedPlaceholders(body: string): string[] {
  const keys = new Set<string>()
  for (const match of body.matchAll(PATTERN)) {
    if (valueFor(match[1], {}) !== undefined) keys.add(match[1])
  }
  return [...keys]
}

/** Sample values, for previews outside a ticket (settings). */
export const SAMPLE_CONTEXT: PlaceholderContext = {
  contact: { name: 'Dana Reyes' },
  ticket: { number: 1042, subject: 'Printer offline in reception' },
  technician: { name: 'Avery Chen' },
  client: { name: 'Northwind Dental' },
}
