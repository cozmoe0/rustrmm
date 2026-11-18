/*
 * SLA countdown state for chips and the SLA panel, plus duration formatting for business-minute
 * targets. The server owns due times and breach flags; between refreshes a running clock that passes
 * its due time is shown as breached right away.
 */
import type { Ticket, TicketSla } from '@/lib/api/types'

const MINUTE = 60_000

/** The server's `sla=due_soon` horizon: a running clock with an unmet target due within 60 minutes. */
export const DUE_SOON_MS = 60 * MINUTE

export type SlaKind = 'first_response' | 'resolution'
export type SlaTone = 'ok' | 'due_soon' | 'breached' | 'paused' | 'met' | 'met_late'

export interface SlaClock {
  kind: SlaKind
  tone: SlaTone
  due: string
  /** When the target was met (first response or resolution), if it was. */
  met_at: string | null
  /** Milliseconds until due (negative when overdue); null once met. */
  remaining_ms: number | null
  /** Short chip text: "2h 14m", "12m over", "Paused", "Met". */
  label: string
}

export const SLA_KIND_LABEL: Record<SlaKind, string> = {
  first_response: 'First response',
  resolution: 'Resolution',
}

/** One target's state at `now`. */
export function slaClock(sla: TicketSla, kind: SlaKind, now = Date.now()): SlaClock {
  const due = kind === 'first_response' ? sla.first_response_due : sla.resolution_due
  const metAt = kind === 'first_response' ? sla.first_response_at : sla.resolved_at
  const flagged = kind === 'first_response' ? sla.first_response_breached : sla.resolution_breached
  const dueMs = new Date(due).getTime()
  if (metAt) {
    const late = flagged || new Date(metAt).getTime() > dueMs
    return { kind, tone: late ? 'met_late' : 'met', due, met_at: metAt, remaining_ms: null, label: late ? 'Met late' : 'Met' }
  }
  const remaining = dueMs - now
  if (flagged || (!sla.paused && remaining < 0)) {
    return { kind, tone: 'breached', due, met_at: null, remaining_ms: remaining, label: remaining < 0 ? `${formatCountdown(-remaining)} over` : 'Breached' }
  }
  if (sla.paused) return { kind, tone: 'paused', due, met_at: null, remaining_ms: remaining, label: 'Paused' }
  return {
    kind,
    tone: remaining <= DUE_SOON_MS ? 'due_soon' : 'ok',
    due,
    met_at: null,
    remaining_ms: remaining,
    label: formatCountdown(remaining),
  }
}

/**
 * The clock a queue row shows: the first-response target until it is met, then resolution. Closed
 * and resolved tickets show how resolution went; tickets without an SLA show nothing.
 */
export function headlineClock(ticket: Pick<Ticket, 'sla' | 'status'>, now = Date.now()): SlaClock | null {
  const sla = ticket.sla
  if (!sla) return null
  const first = slaClock(sla, 'first_response', now)
  const resolution = slaClock(sla, 'resolution', now)
  if (ticket.status === 'resolved' || ticket.status === 'closed') return resolution.met_at ? resolution : null
  if (first.tone === 'breached' && resolution.tone !== 'breached') return first
  if (!first.met_at) return first
  return resolution
}

/** Whether either target is breached at `now`. */
export function isBreached(sla: TicketSla | null, now = Date.now()): boolean {
  if (!sla) return false
  const tones = [slaClock(sla, 'first_response', now).tone, slaClock(sla, 'resolution', now).tone]
  return tones.includes('breached') || tones.includes('met_late')
}

/** Countdown text with two units at most: "45s", "12m", "2h 14m", "3d 4h". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(Math.abs(ms) / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
}

/**
 * A business-minute duration as a technician reads an SLA target: "30m", "4h", "1h 30m", "72h";
 * beyond 96 hours as business days of the policy's hours are ambiguous, so plain days and hours: "7d 2h".
 */
export function formatBusinessMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes))
  if (total < 60) return `${total}m`
  const hours = Math.floor(total / 60)
  const rest = total % 60
  if (hours <= 96) return rest ? `${hours}h ${rest}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const leftover = hours % 24
  return leftover ? `${days}d ${leftover}h` : `${days}d`
}

/** Logged time: "0m", "45m", "1h 30m", "12h". */
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes))
  if (total < 60) return `${total}m`
  const hours = Math.floor(total / 60)
  return total % 60 ? `${hours}h ${total % 60}m` : `${hours}h`
}

/**
 * Parses a duration typed into a target or time field: "90", "90m", "1h 30m", "1.5h", "2d", "1d 4h".
 * Bare numbers are minutes; days are 24 hours. Returns whole minutes, or null when unreadable.
 */
export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!text) return null
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text))
  const pattern = /(\d+(?:\.\d+)?)\s*(d|h|m)/g
  let total = 0
  let consumed = ''
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1])
    total += match[2] === 'd' ? value * 1440 : match[2] === 'h' ? value * 60 : value
    consumed += match[0]
  }
  if (!consumed || consumed.replace(/\s/g, '') !== text.replace(/\s/g, '')) return null
  return Math.round(total)
}

/** Whole minutes for a stopped timer: at least one minute, rounded up to the next minute. */
export function timerMinutes(elapsedMs: number): number {
  return Math.max(1, Math.ceil(elapsedMs / MINUTE))
}
