/* Presentational pieces for escrowed secrets: kind marks, the revealed-secret display and the countdown ring. */
import type { LucideIcon } from 'lucide-react'
import { HardDrive, KeyRound, Laptop, Lock } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { EscrowItem, EscrowKind } from '@/lib/api/types'
import { charClass, KIND_LABEL, KIND_SHORT, secretGroups } from '@/lib/escrow/secret'
import { cn } from '@/lib/utils'

const KIND_ICON: Record<EscrowKind, LucideIcon> = { bitlocker: HardDrive, laps: KeyRound, filevault: Laptop, luks: Lock }
const KIND_TONE: Record<EscrowKind, string> = {
  bitlocker: 'bg-info/12 text-info ring-info/25',
  laps: 'bg-primary/12 text-primary ring-primary/25',
  filevault: 'bg-chart-4/12 text-chart-4 ring-chart-4/25',
  luks: 'bg-warning/12 text-warning ring-warning/25',
}

export function KindTile({ kind, size = 'md' }: { kind: EscrowKind; size?: 'sm' | 'md' | 'lg' }) {
  const Icon = KIND_ICON[kind]
  const box = size === 'sm' ? 'size-6 rounded-md [&_svg]:size-3.5' : size === 'lg' ? 'size-10 rounded-xl [&_svg]:size-5' : 'size-7 rounded-lg [&_svg]:size-4'
  return (
    <span className={cn('inline-flex shrink-0 items-center justify-center ring-1', box, KIND_TONE[kind])} role="img" aria-label={KIND_LABEL[kind]}>
      <Icon />
    </span>
  )
}

export function KindLabel({ kind }: { kind: EscrowKind }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <KindTile kind={kind} size="sm" />
      <span className="truncate">{KIND_SHORT[kind]}</span>
    </span>
  )
}

export function ItemStateBadge({ item }: { item: Pick<EscrowItem, 'superseded_at' | 'device_id'> }) {
  if (item.superseded_at) return <Badge variant="secondary">Superseded</Badge>
  if (!item.device_id) return <Badge variant="outline">Device deleted</Badge>
  return <Badge variant="success">Current</Badge>
}

const CHAR_TONE = {
  digit: 'text-info',
  upper: 'text-foreground',
  lower: 'text-secondary-foreground',
  symbol: 'text-primary',
} as const

/**
 * The revealed value, grouped for reading aloud or typing: BitLocker keys as eight numbered 6-digit
 * blocks, passwords in 4-character chunks with digits and symbols tinted.
 */
export function SecretDisplay({ kind, secret }: { kind: EscrowKind; secret: string }) {
  const groups = secretGroups(kind, secret)
  if (kind === 'bitlocker' && groups.length === 8) {
    return (
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Recovery key, eight groups of six digits">
        {groups.map((group, index) => (
          <li key={index} className="rounded-lg bg-surface-2 px-2 pt-1 pb-1.5 text-center ring-1 ring-border">
            <span className="block text-[9.5px] font-medium tracking-wide text-subtle-foreground">{index + 1}</span>
            <span className="tabular block font-mono text-[17px] leading-tight tracking-[0.06em] text-foreground">{group}</span>
          </li>
        ))}
      </ol>
    )
  }
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1.5 rounded-lg bg-surface-2 px-3 py-3 ring-1 ring-border" aria-label={`${secret.length} characters`}>
      {groups.map((group, index) => (
        <span key={index} className="font-mono text-[19px] leading-none tracking-[0.04em]">
          {[...group].map((char, position) => (
            <span key={position} className={CHAR_TONE[charClass(char)]}>
              {char}
            </span>
          ))}
        </span>
      ))}
    </div>
  )
}

/** A ring that empties as the reveal window runs out. */
export function CountdownRing({ seconds, fraction }: { seconds: number; fraction: number }) {
  const radius = 17
  const circumference = 2 * Math.PI * radius
  const urgent = seconds <= 10
  return (
    <span className="relative inline-flex size-11 shrink-0 items-center justify-center" role="timer" aria-label={`Hidden in ${seconds} seconds`}>
      <svg viewBox="0 0 40 40" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx="20" cy="20" r={radius} fill="none" strokeWidth="3" className="stroke-surface-4" />
        <circle
          cx="20"
          cy="20"
          r={radius}
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          className={cn('transition-[stroke-dashoffset] duration-300 ease-linear', urgent ? 'stroke-critical' : 'stroke-primary')}
        />
      </svg>
      <span className={cn('tabular text-[12px] font-semibold', urgent ? 'text-critical' : 'text-foreground')}>{seconds}</span>
    </span>
  )
}
