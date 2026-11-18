/* Presentational pieces shared by the software screens. */
import { Box, FileArchive, LoaderCircle, Terminal } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { DeploymentAction, DeploymentResultStatus, DeploymentStatus, PackageSource, PackageSourceType } from '@/lib/api/types'
import { ACTION_LABEL, DEPLOYMENT_STATUS_LABEL, DEPLOYMENT_STATUS_TONE, RESULT_LABEL, RESULT_TONE, SOURCE_META } from '@/lib/software/labels'
import { cn } from '@/lib/utils'
import { TONE_VARIANT } from '@/features/patching/patching-styles'

const SOURCE_TINT: Record<PackageSourceType, string> = {
  winget: 'bg-info/12 text-info ring-info/25',
  choco: 'bg-chart-3/12 text-chart-3 ring-chart-3/25',
  brew: 'bg-chart-5/14 text-chart-5 ring-chart-5/25',
  apt: 'bg-chart-6/12 text-chart-6 ring-chart-6/25',
  dnf: 'bg-chart-1/12 text-chart-1 ring-chart-1/25',
  zypper: 'bg-success/12 text-success ring-success/25',
  pacman: 'bg-chart-2/12 text-chart-2 ring-chart-2/25',
  apk: 'bg-chart-2/12 text-chart-2 ring-chart-2/25',
  file: 'bg-primary/12 text-primary ring-primary/25',
}

/** A tinted tile for a package source. */
export function SourceTile({ type, size = 'md', className }: { type: PackageSourceType; size?: 'sm' | 'md'; className?: string }) {
  const Icon = type === 'file' ? FileArchive : type === 'winget' || type === 'choco' || type === 'brew' ? Box : Terminal
  return (
    <span
      title={SOURCE_META[type].label}
      className={cn('flex shrink-0 items-center justify-center ring-1 ring-inset', size === 'sm' ? 'size-6 rounded-md [&_svg]:size-3.5' : 'size-8 rounded-lg [&_svg]:size-4', SOURCE_TINT[type], className)}
    >
      <Icon aria-hidden="true" />
    </span>
  )
}

export function SourceText({ source }: { source: PackageSource }) {
  return (
    <span className="flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden">
      <span className="shrink-0 text-muted-foreground">{SOURCE_META[source.type].label}{source.type === 'brew' && source.cask ? ' cask' : ''}</span>
      <span className="truncate font-mono text-[11.5px]">{source.type === 'file' ? source.file_name : source.id}</span>
    </span>
  )
}

export function ActionBadge({ action }: { action: DeploymentAction }) {
  return <Badge variant={action === 'install' ? 'default' : 'warning'}>{ACTION_LABEL[action]}</Badge>
}

export function DeploymentStatusBadge({ status, failed = 0 }: { status: DeploymentStatus; failed?: number }) {
  if (status === 'running')
    return (
      <Badge variant="live">
        <span className="inline-flex size-1.5 animate-pulse-ring rounded-full bg-live" />
        Running
      </Badge>
    )
  if (status === 'completed' && failed > 0) return <Badge variant="warning">Completed</Badge>
  return <Badge variant={TONE_VARIANT[DEPLOYMENT_STATUS_TONE[status]]}>{DEPLOYMENT_STATUS_LABEL[status]}</Badge>
}

export function ResultBadge({ status }: { status: DeploymentResultStatus }) {
  return (
    <Badge variant={TONE_VARIANT[RESULT_TONE[status]]}>
      {status === 'running' && <LoaderCircle className="animate-spin" />}
      {RESULT_LABEL[status]}
    </Badge>
  )
}

interface Counts {
  total: number
  succeeded: number
  failed: number
  pending: number
  skipped?: number
  cancelled?: number
}

/** Deployment progress split by outcome. */
export function DeploymentBar({ counts, height = 'h-1.5', className }: { counts: Counts; height?: string; className?: string }) {
  const rest = Math.max(0, counts.total - counts.succeeded - counts.failed - counts.pending)
  const segments = [
    { key: 'succeeded', value: counts.succeeded, className: 'bg-success' },
    { key: 'failed', value: counts.failed, className: 'bg-critical' },
    { key: 'pending', value: counts.pending, className: 'bg-live/70 animate-pulse' },
    { key: 'rest', value: rest, className: 'bg-subtle-foreground/35' },
  ]
  const total = Math.max(1, counts.total)
  return (
    <div className={cn('flex w-full gap-px overflow-hidden rounded-full bg-surface-3', height, className)} role="img" aria-label={`${counts.succeeded} succeeded, ${counts.failed} failed, ${counts.pending} pending, ${rest} skipped or cancelled`}>
      {segments.map((segment) =>
        segment.value ? <span key={segment.key} className={cn('h-full transition-[flex-grow] duration-500', segment.className)} style={{ flexGrow: segment.value, flexBasis: 0, minWidth: 3, maxWidth: `${(segment.value / total) * 100}%` }} /> : null,
      )}
    </div>
  )
}
