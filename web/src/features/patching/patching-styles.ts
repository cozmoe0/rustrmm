/* Tone and severity class maps shared by the patching and software screens. */
import type { ComplianceSeverityKey } from '@/lib/api/types'
import type { Tone } from '@/lib/patching/labels'

export const TONE_VARIANT: Record<Tone, 'live' | 'success' | 'warning' | 'critical' | 'info' | 'secondary' | 'default'> = {
  live: 'live',
  success: 'success',
  warning: 'warning',
  critical: 'critical',
  info: 'info',
  neutral: 'secondary',
  primary: 'default',
}

export const TONE_TEXT: Record<Tone, string> = {
  live: 'text-live',
  success: 'text-success',
  warning: 'text-warning',
  critical: 'text-critical',
  info: 'text-info',
  neutral: 'text-muted-foreground',
  primary: 'text-primary',
}

export const TONE_BG: Record<Tone, string> = {
  live: 'bg-live',
  success: 'bg-success',
  warning: 'bg-warning',
  critical: 'bg-critical',
  info: 'bg-info',
  neutral: 'bg-subtle-foreground/45',
  primary: 'bg-primary',
}

/** Severity colours, most to least severe; `Unspecified` covers unrated patches. */
export const SEVERITY_BAR: Record<ComplianceSeverityKey, string> = {
  Critical: 'bg-critical',
  Important: 'bg-warning',
  Moderate: 'bg-info',
  Low: 'bg-subtle-foreground/55',
  Unspecified: 'bg-subtle-foreground/30',
}
