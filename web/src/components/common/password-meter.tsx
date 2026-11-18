import { passwordStrength } from '@/lib/password'
import { cn } from '@/lib/utils'

const COLORS = ['bg-critical', 'bg-critical', 'bg-warning', 'bg-live', 'bg-success']
const TEXT = ['text-critical', 'text-critical', 'text-warning', 'text-live', 'text-success']

export function PasswordMeter({ password, className }: { password: string; className?: string }) {
  const strength = passwordStrength(password)
  const filled = password ? strength.score + 1 : 0

  return (
    <div className={cn('grid gap-1.5', className)} aria-live="polite">
      <div className="grid grid-cols-5 gap-1" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => (
          <span
            key={index}
            className={cn(
              'h-1 rounded-full transition-colors duration-200',
              index < filled ? COLORS[strength.score] : 'bg-surface-4',
            )}
          />
        ))}
      </div>
      <div className="flex items-center justify-between text-micro">
        <span className={cn('font-medium', password ? TEXT[strength.score] : 'text-subtle-foreground')}>
          {password ? strength.label : 'At least 12 characters'}
        </span>
        {strength.hints[0] && password && <span className="text-subtle-foreground">{strength.hints[0]}</span>}
      </div>
    </div>
  )
}
