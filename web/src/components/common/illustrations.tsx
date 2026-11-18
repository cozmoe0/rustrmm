import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/*
 * Custom line-art illustrations for empty states. Strokes use theme tokens so they adapt to
 * light and dark: hairline structure in `--border-strong`, highlights in copper and verdigris.
 */

export type IllustrationName =
  | 'devices'
  | 'clients'
  | 'alerts'
  | 'automation'
  | 'patching'
  | 'software'
  | 'tickets'
  | 'network'
  | 'reports'
  | 'audit'
  | 'backups'
  | 'users'
  | 'search'
  | 'launch'
  | 'security'

function Frame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 160 120"
      fill="none"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn('h-28 w-auto', className)}
    >
      <circle cx="80" cy="60" r="52" className="fill-surface-2" />
      <circle cx="80" cy="60" r="52" className="stroke-border-strong" strokeDasharray="2 5" />
      {children}
    </svg>
  )
}

const base = 'stroke-[var(--border-strong)]'
const ink = 'stroke-[var(--muted-foreground)]'
const copper = 'stroke-primary'
const verdigris = 'stroke-live'

const ART: Record<IllustrationName, ReactNode> = {
  devices: (
    <>
      <rect x="42" y="34" width="56" height="38" rx="4" className={cn(ink, 'fill-surface-1')} />
      <path d="M62 80h16M70 72v8" className={ink} />
      <rect x="92" y="48" width="26" height="40" rx="4" className={cn(ink, 'fill-surface-1')} />
      <path d="M101 82h8" className={ink} />
      <path d="M50 44h22M50 51h34M50 58h16" className={base} />
      <circle cx="113" cy="40" r="4" className={cn(verdigris, 'fill-live/20')} />
      <path d="M88 26c6 0 10 4 10 10" className={copper} />
    </>
  ),
  clients: (
    <>
      <path d="M46 88V42l22-10v56" className={cn(ink, 'fill-surface-1')} />
      <path d="M68 88V48l30 8v32" className={cn(ink, 'fill-surface-1')} />
      <path d="M53 50h8M53 60h8M53 70h8M76 62h14M76 72h14" className={base} />
      <path d="M38 88h86" className={ink} />
      <rect x="104" y="64" width="16" height="24" rx="2" className={cn(copper, 'fill-primary/10')} />
      <circle cx="112" cy="40" r="5" className={verdigris} />
    </>
  ),
  alerts: (
    <>
      <path d="M80 30l30 52H50z" className={cn(ink, 'fill-surface-1')} />
      <path d="M80 50v14" className={copper} strokeWidth={2.5} />
      <circle cx="80" cy="72" r="1.6" className={cn(copper, 'fill-primary')} />
      <path d="M40 46c-4 6-4 14 0 20M120 46c4 6 4 14 0 20" className={base} />
      <path d="M33 40c-7 10-7 22 0 32M127 40c7 10 7 22 0 32" className={verdigris} />
    </>
  ),
  automation: (
    <>
      <rect x="40" y="38" width="28" height="20" rx="4" className={cn(ink, 'fill-surface-1')} />
      <rect x="92" y="38" width="28" height="20" rx="4" className={cn(ink, 'fill-surface-1')} />
      <rect x="66" y="70" width="28" height="20" rx="4" className={cn(copper, 'fill-primary/10')} />
      <path d="M68 48h24M54 58v8a4 4 0 0 0 4 4h8M106 58v8a4 4 0 0 1-4 4h-8" className={ink} />
      <path d="M86 44l6 4-6 4" className={verdigris} />
    </>
  ),
  patching: (
    <>
      <path d="M80 28l28 10v20c0 18-12 28-28 34-16-6-28-16-28-34V38z" className={cn(ink, 'fill-surface-1')} />
      <path d="M68 60l8 8 16-17" className={verdigris} strokeWidth={2.5} />
      <path d="M108 36l10-6M112 48h10" className={copper} />
    </>
  ),
  software: (
    <>
      <path d="M80 30l30 14v32L80 90 50 76V44z" className={cn(ink, 'fill-surface-1')} />
      <path d="M50 44l30 14 30-14M80 58v32" className={ink} />
      <path d="M65 37l30 14" className={copper} />
      <circle cx="116" cy="34" r="4" className={verdigris} />
    </>
  ),
  tickets: (
    <>
      <path
        d="M44 42h72v10a8 8 0 0 0 0 16v10H44V68a8 8 0 0 0 0-16z"
        className={cn(ink, 'fill-surface-1')}
      />
      <path d="M92 44v32" className={base} strokeDasharray="3 4" />
      <path d="M56 54h24M56 62h18" className={ink} />
      <path d="M100 55l5 5 7-8" className={verdigris} />
      <circle cx="112" cy="34" r="3" className={copper} />
    </>
  ),
  network: (
    <>
      <circle cx="80" cy="60" r="9" className={cn(copper, 'fill-primary/10')} />
      <circle cx="46" cy="40" r="6" className={cn(ink, 'fill-surface-1')} />
      <circle cx="114" cy="40" r="6" className={cn(ink, 'fill-surface-1')} />
      <circle cx="50" cy="86" r="6" className={cn(ink, 'fill-surface-1')} />
      <circle cx="112" cy="84" r="6" className={cn(verdigris, 'fill-live/15')} />
      <path d="M51 44l21 11M109 44l-21 11M55 82l18-16M106 80l-18-15" className={base} />
    </>
  ),
  reports: (
    <>
      <rect x="46" y="30" width="68" height="60" rx="5" className={cn(ink, 'fill-surface-1')} />
      <path d="M58 78V64M70 78V54M82 78V60M94 78V46" className={ink} strokeWidth={4} />
      <path d="M58 46l12-6 12 6 14-10" className={copper} />
      <circle cx="96" cy="36" r="2.5" className={cn(copper, 'fill-primary')} />
    </>
  ),
  audit: (
    <>
      <path d="M52 30h44l12 12v48H52z" className={cn(ink, 'fill-surface-1')} />
      <path d="M96 30v12h12" className={ink} />
      <path d="M62 52h30M62 60h36M62 68h24" className={base} />
      <circle cx="102" cy="80" r="11" className={cn(verdigris, 'fill-surface-2')} />
      <path d="M97 80l3.5 3.5 6-7" className={verdigris} />
      <path d="M62 44h14" className={copper} />
    </>
  ),
  backups: (
    <>
      <ellipse cx="80" cy="38" rx="24" ry="8" className={cn(ink, 'fill-surface-1')} />
      <path d="M56 38v36c0 4.4 10.7 8 24 8s24-3.6 24-8V38" className={ink} />
      <path d="M56 56c0 4.4 10.7 8 24 8s24-3.6 24-8" className={base} />
      <path d="M112 70a14 14 0 1 1-6-11.5" className={copper} />
      <path d="M106 54v5h5" className={copper} />
    </>
  ),
  users: (
    <>
      <circle cx="70" cy="50" r="11" className={cn(ink, 'fill-surface-1')} />
      <path d="M48 86c2-13 11-20 22-20s20 7 22 20" className={ink} />
      <circle cx="100" cy="46" r="8" className={cn(copper, 'fill-primary/10')} />
      <path d="M92 64c10 0 17 6 19 16" className={copper} />
      <circle cx="112" cy="32" r="3" className={verdigris} />
    </>
  ),
  search: (
    <>
      <circle cx="74" cy="56" r="20" className={cn(ink, 'fill-surface-1')} />
      <path d="M89 71l18 18" className={copper} strokeWidth={3} />
      <path d="M64 52h20M64 60h12" className={base} />
    </>
  ),
  launch: (
    <>
      <path d="M80 28c14 8 20 22 18 40H62c-2-18 4-32 18-40z" className={cn(ink, 'fill-surface-1')} />
      <circle cx="80" cy="50" r="6" className={cn(verdigris, 'fill-live/15')} />
      <path d="M62 68l-10 10 12 2M98 68l10 10-12 2" className={ink} />
      <path d="M74 80c0 8 6 12 6 12s6-4 6-12" className={copper} />
    </>
  ),
  security: (
    <>
      <rect x="54" y="52" width="52" height="38" rx="6" className={cn(ink, 'fill-surface-1')} />
      <path d="M64 52V42a16 16 0 0 1 32 0v10" className={ink} />
      <circle cx="80" cy="69" r="5" className={copper} />
      <path d="M80 74v6" className={copper} />
      <path d="M114 36l6-4M116 46h7" className={verdigris} />
    </>
  ),
}

export function Illustration({ name, className }: { name: IllustrationName; className?: string }) {
  return <Frame className={className}>{ART[name]}</Frame>
}
