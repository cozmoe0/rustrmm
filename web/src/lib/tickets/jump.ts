/*
 * "Jump to ticket" for the command palette and the queue search: `#1042`, `# 1042` or `ticket #1042`
 * name a ticket number. A bare number is not a jump (it could be part of a device or client search).
 */

const JUMP = /^\s*(?:ticket\s*)?#\s*(\d{1,9})\s*$/i

export function parseTicketJump(input: string): number | null {
  const match = JUMP.exec(input)
  if (!match) return null
  const number = Number(match[1])
  return Number.isSafeInteger(number) && number > 0 ? number : null
}
