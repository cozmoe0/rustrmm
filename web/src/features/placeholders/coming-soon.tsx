import type { LucideIcon } from 'lucide-react'
import { Check } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Illustration, type IllustrationName } from '@/components/common/illustrations'
import { PageContainer } from '@/components/common/page-header'
import { useTitle } from '@/lib/use-title'

export interface ComingSoonProps {
  title: string
  icon: LucideIcon
  phase: number
  illustration: IllustrationName
  summary: string
  capabilities: string[]
}

/** A polished placeholder for sections that arrive in later delivery phases. */
export function ComingSoon({ title, icon: Icon, phase, illustration, summary, capabilities }: ComingSoonProps) {
  useTitle(title)
  return (
    <div className="h-full overflow-y-auto">
      <PageContainer className="flex min-h-full items-center justify-center">
        <div className="relative w-full max-w-3xl overflow-hidden rounded-2xl bg-card shadow-card">
          <div className="bg-grid pointer-events-none absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_at_top,#000_20%,transparent_70%)]" />
          <div className="surface-glow pointer-events-none absolute inset-0 opacity-80" />
          <div className="relative grid gap-8 p-8 sm:grid-cols-[1fr_auto] sm:p-10">
            <div>
              <div className="mb-4 flex items-center gap-2">
                <span className="flex size-9 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/25">
                  <Icon className="size-[18px]" />
                </span>
                <Badge variant="outline">Arrives in Phase {phase}</Badge>
              </div>
              <h1 className="font-display text-[26px] leading-tight font-semibold tracking-tight">{title}</h1>
              <p className="mt-2 max-w-lg text-sm text-muted-foreground">{summary}</p>
              <ul className="mt-6 grid gap-2.5 sm:grid-cols-2">
                {capabilities.map((capability) => (
                  <li key={capability} className="flex items-start gap-2 text-dense">
                    <Check className="mt-0.5 size-3.5 shrink-0 text-live" />
                    <span className="text-secondary-foreground">{capability}</span>
                  </li>
                ))}
              </ul>
            </div>
            <Illustration name={illustration} className="hidden h-40 self-center sm:block" />
          </div>
        </div>
      </PageContainer>
    </div>
  )
}
