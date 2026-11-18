/*
 * Approval semantics: rule matching (the same rules the server applies), ring delays and the
 * "effective approval" of a patch for a device, plus display helpers for the catalog and device views.
 */
import type {
  AutoApproveRule,
  Patch,
  PatchApproval,
  PatchRing,
  PatchRingDelays,
  PatchSeverity,
} from '@/lib/api/types'
import { formatDate } from '@/lib/format'
import { APPROVAL_LABEL, APPROVAL_TONE, RING_LABEL, RING_ORDER, type Tone } from './labels'

const DAY = 86_400_000

type PatchFacts = Pick<Patch, 'platform' | 'classification' | 'severity'>
type PatchDates = Pick<Patch, 'release_date' | 'first_seen_at'>

/**
 * Whether a rule covers a patch. Empty lists match anything; a patch without a severity only matches
 * rules that list no severities. Comparisons ignore case.
 */
export function ruleMatches(rule: AutoApproveRule, patch: PatchFacts): boolean {
  if (rule.platform !== patch.platform) return false
  const classifications = rule.classifications ?? []
  if (classifications.length && !classifications.some((item) => item.toLowerCase() === patch.classification.toLowerCase()))
    return false
  const severities = rule.severities ?? []
  if (!severities.length) return true
  const severity = patch.severity
  return severity !== null && severities.some((item) => item.toLowerCase() === severity.toLowerCase())
}

/** The first rule in list order that matches (later rules never override an earlier match). */
export function matchingRule<T extends AutoApproveRule>(rules: readonly T[], patch: PatchFacts): T | undefined {
  return rules.find((rule) => ruleMatches(rule, patch))
}

/** Delay in days for a ring; missing or negative values count as 0. */
export function ringDelay(delays: PatchRingDelays | undefined, ring: PatchRing): number {
  return Math.max(0, Math.floor(delays?.[ring] ?? 0))
}

/** The instant delays count from: the release date, or the first sighting when there is none. */
export function approvalBase(patch: PatchDates): number {
  return new Date(patch.release_date ?? patch.first_seen_at).getTime()
}

export interface RingAvailability {
  ring: PatchRing
  delay: number
  at: Date
  available: boolean
  /** Whole days until `at`, rounded up; 0 once available. */
  daysLeft: number
}

/** When each ring may install a rule-approved patch. */
export function ringSchedule(patch: PatchDates, delays: PatchRingDelays | undefined, now = Date.now()): RingAvailability[] {
  const base = approvalBase(patch)
  return RING_ORDER.map((ring) => {
    const delay = ringDelay(delays, ring)
    const at = base + delay * DAY
    return {
      ring,
      delay,
      at: new Date(at),
      available: now >= at,
      daysLeft: now >= at ? 0 : Math.ceil((at - now) / DAY),
    }
  })
}

export interface EffectiveApproval {
  approved: boolean
  /** When the patch became installable for this device (null when it isn't approved). */
  since: Date | null
  /** A future instant at which a rule approval takes effect for the device's ring. */
  pendingUntil: Date | null
  reason: string
}

/**
 * The effective approval of a patch for a device in `ring`. Manual approvals take effect at once; a
 * rule approval waits for the ring's delay from the release date. Rule approvals record the delays of
 * the rule that matched; pass them as `delays`, or pass `rules` to use the first matching rule. An
 * expired deferral counts as no decision.
 */
export function effectiveApproval(
  patch: Pick<Patch, 'approval' | 'release_date' | 'first_seen_at' | 'platform' | 'classification' | 'severity'>,
  options: { ring: PatchRing; delays?: PatchRingDelays; rules?: readonly AutoApproveRule[] },
  now = Date.now(),
): EffectiveApproval {
  const approval = patch.approval
  if (approval.status === 'declined') return { approved: false, since: null, pendingUntil: null, reason: 'Declined' }
  if (approval.status === 'deferred') {
    const until = approval.until ? new Date(approval.until).getTime() : null
    if (until !== null && until > now)
      return { approved: false, since: null, pendingUntil: null, reason: `Deferred until ${formatDate(until)}` }
    return { approved: false, since: null, pendingUntil: null, reason: 'Deferral expired — waiting for a decision' }
  }
  if (approval.status !== 'approved') return { approved: false, since: null, pendingUntil: null, reason: 'Waiting for approval' }
  const decidedAt = new Date(approval.approved_at ?? approval.at ?? patch.first_seen_at).getTime()
  if (approval.source !== 'rule') {
    return { approved: true, since: new Date(Math.min(decidedAt, now)), pendingUntil: null, reason: 'Approved manually' }
  }
  const delays = options.delays ?? matchingRule(options.rules ?? [], patch)?.delay_days
  const delay = ringDelay(delays, options.ring)
  const at = Math.max(approvalBase(patch) + delay * DAY, decidedAt)
  if (now >= at) {
    return {
      approved: true,
      since: new Date(at),
      pendingUntil: null,
      reason: delay ? `Approved by rule · ${RING_LABEL[options.ring].toLowerCase()} ring after ${formatDelay(delay)}` : 'Approved by rule',
    }
  }
  return {
    approved: false,
    since: null,
    pendingUntil: new Date(at),
    reason: `Approved by rule · ${RING_LABEL[options.ring].toLowerCase()} ring from ${formatDate(at)}`,
  }
}

/** "same day", "1 day", "7 days". */
export function formatDelay(days: number): string {
  if (days <= 0) return 'same day'
  return `${days} ${days === 1 ? 'day' : 'days'}`
}

/** Compact ring delays: "Pilot 0d · Broad 7d · Late 21d". */
export function formatRingDelays(delays: PatchRingDelays | undefined): string {
  return RING_ORDER.map((ring) => `${RING_LABEL[ring]} ${ringDelay(delays, ring)}d`).join(' · ')
}

export interface ApprovalDisplay {
  label: string
  tone: Tone
  /** `rule` or `manual` for approvals; null otherwise. */
  source: 'rule' | 'manual' | null
  detail: string
  /** A manual decision taken for one client, overriding the global one. */
  override: boolean
}

/** Badge text and a one-line explanation of an approval as the catalog shows it. */
export function describeApproval(approval: PatchApproval, now = Date.now()): ApprovalDisplay {
  // Rule approvals are always recorded per client; only manual client decisions are overrides.
  const override = Boolean(approval.client_id) && approval.source !== 'rule'
  const who = approval.by_name ? ` by ${approval.by_name}` : ''
  const when = approval.approved_at ?? approval.at
  if (approval.status === 'approved' && approval.scope === 'clients') {
    const clients = approval.clients ?? 0
    return {
      label: `Approved · rule (${clients} ${clients === 1 ? 'client' : 'clients'})`,
      tone: APPROVAL_TONE.approved,
      source: 'rule',
      override: false,
      detail: `No global decision: auto-approval rules approved it for ${clients} ${clients === 1 ? 'client' : 'clients'}${when ? ` since ${formatDate(when)}` : ''}. View a client to see its own decision; a global approval would cover every client.`,
    }
  }
  if (approval.status === 'approved') {
    const source = approval.source === 'rule' ? 'rule' : 'manual'
    return {
      label: source === 'rule' ? 'Approved · rule' : 'Approved',
      tone: APPROVAL_TONE.approved,
      source,
      override,
      detail:
        source === 'rule'
          ? `Approved automatically by an approval rule${when ? ` on ${formatDate(when)}` : ''}. Rings install after their delay.`
          : `Approved manually${who}${when ? ` on ${formatDate(when)}` : ''}. Installs at the next window, without ring delays.`,
    }
  }
  if (approval.status === 'deferred') {
    const until = approval.until ? new Date(approval.until).getTime() : null
    const active = until !== null && until > now
    return {
      label: active ? `Deferred · ${formatDate(until)}` : 'Deferral expired',
      tone: APPROVAL_TONE.deferred,
      source: null,
      override,
      detail: active ? `Deferred${who} until ${formatDate(until)}; it is not installed before then.` : 'The deferral has passed; decide again.',
    }
  }
  if (approval.status === 'declined')
    return { label: APPROVAL_LABEL.declined, tone: APPROVAL_TONE.declined, source: null, override, detail: `Declined${who}; it is never installed automatically.` }
  return { label: APPROVAL_LABEL.none, tone: APPROVAL_TONE.none, source: null, override, detail: 'No rule matched and nobody has decided yet.' }
}

/** Severity facet value, with `null` grouped as "Unrated". */
export function severityKey(severity: PatchSeverity | null): PatchSeverity | 'Unrated' {
  return severity ?? 'Unrated'
}

/** Default dates for the defer picker: a week out, as a `YYYY-MM-DD` value. */
export function defaultDeferDate(now = Date.now()): string {
  const date = new Date(now + 7 * DAY)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** A `YYYY-MM-DD` defer date as the end of that local day, in ISO form; null when invalid or not in the future. */
export function deferUntilIso(value: string, now = Date.now()): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 0, 0)
  if (Number.isNaN(date.getTime()) || date.getTime() <= now) return null
  return date.toISOString()
}
