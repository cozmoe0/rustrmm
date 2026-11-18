import { cn } from '@/lib/utils'

/** The RustRMM mark: a copper "R" monogram with a verdigris live dot. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn('size-8', className)}>
      <defs>
        <linearGradient id="rr-copper" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="oklch(0.76 0.14 50)" />
          <stop offset="100%" stopColor="oklch(0.6 0.16 38)" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="#14171c" stroke="rgb(255 255 255 / 0.08)" />
      <path
        d="M9 22.5V9.5h7.6c3 0 5 1.8 5 4.4 0 2-1.2 3.4-3 4l3.7 4.6h-3.6l-3.3-4H12.3v4zm3.3-6.6h4.1c1.2 0 2-.7 2-1.7s-.8-1.7-2-1.7h-4.1z"
        fill="url(#rr-copper)"
      />
      <circle cx="24.2" cy="8.6" r="2.4" fill="oklch(0.76 0.11 185)" />
    </svg>
  )
}

export function Logo({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      {!compact && (
        <span className="font-display text-[15px] font-semibold tracking-tight">
          Rust<span className="text-primary">RMM</span>
        </span>
      )}
    </span>
  )
}
