import { REGEXP_ONLY_DIGITS } from 'input-otp'
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from '@/components/ui/input-otp'
import { cn } from '@/lib/utils'

/** Six segmented digits; calls `onComplete` as soon as the last digit is entered. */
export function TotpInput({
  value,
  onChange,
  onComplete,
  disabled,
  invalid,
  autoFocus = true,
  className,
  id,
}: {
  value: string
  onChange: (value: string) => void
  onComplete?: (value: string) => void
  disabled?: boolean
  invalid?: boolean
  autoFocus?: boolean
  className?: string
  id?: string
}) {
  const slot = cn(
    'size-11 bg-surface-1 font-mono text-lg font-medium dark:bg-black/25',
    invalid && 'border-critical/60',
  )
  return (
    <InputOTP
      id={id}
      maxLength={6}
      pattern={REGEXP_ONLY_DIGITS}
      inputMode="numeric"
      autoComplete="one-time-code"
      autoFocus={autoFocus}
      disabled={disabled}
      value={value}
      onChange={onChange}
      onComplete={onComplete}
      aria-invalid={invalid || undefined}
      aria-label="Six-digit authentication code"
      containerClassName={cn('justify-center gap-2', className)}
    >
      <InputOTPGroup>
        <InputOTPSlot index={0} className={slot} />
        <InputOTPSlot index={1} className={slot} />
        <InputOTPSlot index={2} className={slot} />
      </InputOTPGroup>
      <InputOTPSeparator className="text-subtle-foreground" />
      <InputOTPGroup>
        <InputOTPSlot index={3} className={slot} />
        <InputOTPSlot index={4} className={slot} />
        <InputOTPSlot index={5} className={slot} />
      </InputOTPGroup>
    </InputOTP>
  )
}
