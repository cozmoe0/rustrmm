import { describe, expect, it } from 'vitest'
import { checkAttachments, MAX_ATTACHMENT_BYTES } from './attachments'
import { parseTicketJump } from './jump'
import { renderPlaceholders, SAMPLE_CONTEXT, usedPlaceholders } from './placeholders'
import { activeView, toTicketFilters, viewCount } from './queue'

describe('parseTicketJump', () => {
  it('reads ticket numbers written with a hash', () => {
    expect(parseTicketJump('#1042')).toBe(1042)
    expect(parseTicketJump('  # 1042 ')).toBe(1042)
    expect(parseTicketJump('ticket #77')).toBe(77)
    expect(parseTicketJump('Ticket#1001')).toBe(1001)
  })

  it('ignores anything else', () => {
    for (const input of ['1042', '#', '#12ab', '#0', 'printer #2 offline', '#-4', '']) expect(parseTicketJump(input)).toBeNull()
  })
})

describe('renderPlaceholders', () => {
  it('fills every supported placeholder', () => {
    const body = 'Hi {{contact.first_name}} ({{contact.name}}), #{{ticket.number}} “{{ticket.subject}}” for {{client.name}}. — {{technician.name}}'
    expect(renderPlaceholders(body, SAMPLE_CONTEXT)).toBe(
      'Hi Dana (Dana Reyes), #1042 “Printer offline in reception” for Northwind Dental. — Avery Chen',
    )
  })

  it('renders missing values empty and keeps unknown placeholders as written', () => {
    expect(renderPlaceholders('Hi {{contact.first_name}}, {{ticket.priority}} {{ contact.name }}', { contact: null })).toBe(
      'Hi , {{ticket.priority}} {{ contact.name }}',
    )
  })

  it('lists the known placeholders a body uses', () => {
    expect(usedPlaceholders('{{client.name}} {{client.name}} {{foo.bar}} {{ticket.number}}')).toEqual(['client.name', 'ticket.number'])
  })
})

describe('checkAttachments', () => {
  it('enforces type, size and count limits', () => {
    const result = checkAttachments(
      Array.from({ length: 8 }, (_, index) => ({ name: `f${index}.png`, size: 10 })),
      [
        { name: 'setup.exe', size: 10 },
        { name: 'huge.zip', size: MAX_ATTACHMENT_BYTES + 1 },
        { name: 'notes.txt', size: 0 },
        { name: 'a.pdf', size: 10 },
        { name: 'b.LOG', size: 10 },
        { name: 'c.csv', size: 10 },
      ],
    )
    expect(result.accepted.map((file) => file.name)).toEqual(['a.pdf', 'b.LOG'])
    expect(result.rejected.map((item) => item.reason)).toEqual([
      '.exe files are not accepted',
      'Larger than 25 MB',
      'The file is empty',
      'At most 10 files per reply',
    ])
  })
})

describe('queue views', () => {
  it('maps searches to API filters and views', () => {
    expect(toTicketFilters({ assignee: 'me', q: '  printer ', sort: 'due' }, 'c1')).toMatchObject({ assignee: 'me', q: 'printer', sort: 'due', client_id: 'c1' })
    expect(activeView({ assignee: 'me', priority: 'urgent' })?.id).toBe('mine')
    expect(activeView({ status: 'resolved,closed' })?.id).toBe('resolved')
    expect(activeView({ assignee: 'me', status: 'all' })).toBeUndefined()
  })

  it('derives view badges from counts', () => {
    const counts = { new: 2, open: 5, pending: 3, on_hold: 1, mine: 4, unassigned: 2, breached: 1 }
    expect(viewCount('open', counts)).toBe(11)
    expect(viewCount('pending', counts)).toBe(4)
    expect(viewCount('resolved', counts)).toBeUndefined()
    // Servers with the Phase 11 counts also badge the resolved and due-soon views.
    expect(viewCount('resolved', { ...counts, resolved: 7, due_soon: 2 })).toBe(7)
    expect(viewCount('due_soon', { ...counts, resolved: 7, due_soon: 2 })).toBe(2)
    expect(viewCount('all', { ...counts, resolved: 7, due_soon: 2 })).toBeUndefined()
  })
})
