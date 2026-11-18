import type { ReactNode } from 'react'
import { BrandMark, ProductWordmark } from '@/components/brand/branding'
import { useTheme } from '@/lib/theme'
import { StatusDot } from '@/components/common/status-dot'
import { cn } from '@/lib/utils'

const POINTS = [
  { title: 'Signed, replay-proof commands', body: 'Every action reaching an endpoint is Ed25519-signed and expires.' },
  { title: 'Mandatory MFA and step-up', body: 'Sensitive actions re-verify you, even mid-session.' },
  { title: 'Tamper-evident audit trail', body: 'A hash-chained log you can verify with one click.' },
]

/** Split layout for login and setup: brand panel on the left, the task on the right. */
export function AuthLayout({
  children,
  aside,
  wide = false,
}: {
  children: ReactNode
  aside?: ReactNode
  wide?: boolean
}) {
  const { resolved } = useTheme()
  return (
    <div className="grid min-h-dvh bg-background lg:grid-cols-[minmax(420px,44%)_1fr]">
      <aside className="relative hidden overflow-hidden border-r border-border bg-surface-1 lg:flex lg:flex-col">
        <div className="bg-grid pointer-events-none absolute inset-0 opacity-80 [mask-image:linear-gradient(to_bottom,#000,transparent_85%)]" />
        <div className="surface-glow pointer-events-none absolute inset-0" />
        <div className="relative flex h-full flex-col justify-between p-10 xl:p-14">
          <div className="flex items-center gap-3">
            <BrandMark surface={resolved} className="h-9 max-w-40" fallbackClassName="size-9" />
            <div>
              <ProductWordmark className="block text-base" />
              <div className="text-micro text-subtle-foreground">Remote monitoring &amp; management</div>
            </div>
          </div>

          {aside ?? (
            <div className="max-w-md">
              <p className="eyebrow mb-3 flex items-center gap-2">
                <StatusDot tone="live" pulse /> Security-first by design
              </p>
              <h2 className="font-display text-[28px] leading-[1.15] font-semibold tracking-tight">
                Every endpoint, every client, <span className="text-primary">one calm console.</span>
              </h2>
              <ul className="mt-8 grid gap-5">
                {POINTS.map((point) => (
                  <li key={point.title} className="flex gap-3">
                    <span className="mt-1.5 h-px w-5 shrink-0 bg-primary" />
                    <div>
                      <div className="text-sm font-medium">{point.title}</div>
                      <div className="mt-0.5 text-dense text-muted-foreground">{point.body}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="text-micro text-subtle-foreground">Self-hosted · Your data never leaves your server</div>
        </div>
      </aside>

      <main className="relative flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="bg-grid bg-grid-fade pointer-events-none absolute inset-0 opacity-50 lg:hidden" />
        <div className={cn('relative w-full', wide ? 'max-w-xl' : 'max-w-[400px]')}>
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <BrandMark surface={resolved} />
            <ProductWordmark className="text-base" />
          </div>
          {children}
        </div>
      </main>
    </div>
  )
}
