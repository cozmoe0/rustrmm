/* Small shared pieces of the Reports area: run status badges and the format chip. */
import { CircleAlert, CircleCheck, Clock, LoaderCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ReportFormat, ReportRun } from '@/lib/api/types'
import { cn } from '@/lib/utils'
import { FORMAT_LABEL, reportMeta } from './report-meta'

export function RunStatus({ run, className }: { run: Pick<ReportRun, 'status' | 'error'>; className?: string }) {
  if (run.status === 'failed') {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className={cn('inline-flex', className)} />}>
          <Badge variant="critical">
            <CircleAlert />
            Failed
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">{run.error ?? 'The report could not be generated.'}</TooltipContent>
      </Tooltip>
    )
  }
  if (run.status === 'completed')
    return (
      <Badge variant="success" className={className}>
        <CircleCheck />
        Ready
      </Badge>
    )
  if (run.status === 'running')
    return (
      <Badge variant="live" className={className}>
        <LoaderCircle className="animate-spin" />
        Generating
      </Badge>
    )
  return (
    <Badge variant="secondary" className={className}>
      <Clock />
      Queued
    </Badge>
  )
}

export function FormatChip({ format }: { format: ReportFormat }) {
  return (
    <span className="inline-flex h-5 items-center rounded-[5px] bg-surface-3 px-1.5 font-mono text-[10.5px] font-medium tracking-wide text-secondary-foreground uppercase ring-1 ring-border">
      {format === 'json' ? FORMAT_LABEL.json : format}
    </span>
  )
}

export function ReportTypeIcon({ type, className }: { type: string; className?: string }) {
  const meta = reportMeta(type)
  return (
    <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-md ring-1 [&_svg]:size-3.5', meta.tone, className)}>
      <meta.icon />
    </span>
  )
}
