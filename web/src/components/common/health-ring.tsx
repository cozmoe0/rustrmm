import { cn } from '@/lib/utils'

/** Composite health score ring (0–100). `null` renders a neutral "no data" ring. */
export function HealthRing({
  score,
  size = 44,
  strokeWidth = 4,
  className,
  label = 'Health score',
}: {
  score: number | null
  size?: number
  strokeWidth?: number
  className?: string
  label?: string
}) {
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const value = score === null ? 0 : Math.max(0, Math.min(100, score))
  const offset = circumference * (1 - value / 100)
  const tone =
    score === null ? 'text-subtle-foreground' : value >= 85 ? 'text-live' : value >= 65 ? 'text-warning' : 'text-critical'

  return (
    <div
      role="img"
      aria-label={score === null ? `${label}: no data yet` : `${label}: ${value} of 100`}
      className={cn('relative inline-flex shrink-0 items-center justify-center', tone, className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          className="fill-none stroke-surface-4"
        />
        {score !== null && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className="fill-none stroke-current transition-[stroke-dashoffset] duration-700 ease-(--ease-snappy)"
          />
        )}
      </svg>
      <span className="tabular absolute text-[11px] font-semibold text-foreground">{score === null ? '—' : value}</span>
    </div>
  )
}
