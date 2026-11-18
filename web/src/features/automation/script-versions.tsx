import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, BadgeCheck, Hourglass, RotateCcw, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { CopyButton } from '@/components/common/copy-button'
import { Mono, RelativeTime } from '@/components/common/misc'
import { SimpleSelect } from '@/components/common/simple-select'
import { scriptVersionQuery } from '@/lib/api/queries'
import type { Script, ScriptParameter, ScriptVersionDetail, ScriptVersionSummary } from '@/lib/api/types'
import { diffLines, diffStats } from '@/lib/automation/diff'
import { cn } from '@/lib/utils'
import { DiffView } from './diff-view'
import { SEGMENTED } from './styles'

function parameterChanges(before: ScriptParameter[], after: ScriptParameter[]): string[] {
  const out: string[] = []
  for (const param of after) {
    const old = before.find((item) => item.name === param.name)
    if (!old) out.push(`Added ${param.name}`)
    else if (JSON.stringify(old) !== JSON.stringify(param)) out.push(`Changed ${param.name}`)
  }
  for (const param of before) if (!after.some((item) => item.name === param.name)) out.push(`Removed ${param.name}`)
  return out
}

function VersionCard({
  version,
  script,
  active,
  base,
  onSelect,
  onApprove,
  canApprove,
  approving,
}: {
  version: ScriptVersionSummary
  script: Script
  active: boolean
  base: boolean
  onSelect: () => void
  onApprove: () => void
  canApprove: boolean
  approving: boolean
}) {
  const current = version.version === script.current_version
  const approved = Boolean(version.approved_by_name)
  const live = version.version === script.approved_version
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onSelect()
          }
        }}
        className={cn(
          'relative grid gap-1.5 rounded-lg px-3 py-2.5 transition-colors outline-none hover:bg-surface-3/60 focus-visible:ring-2 focus-visible:ring-ring',
          active && 'bg-primary/[0.07] ring-1 ring-primary/25 hover:bg-primary/10',
          base && !active && 'outline-1 outline-border-strong outline-dashed',
        )}
      >
        <div className="flex items-center gap-2">
          <span className="tabular font-mono text-[13px] font-semibold">v{version.version}</span>
          {current && <Badge variant="secondary">Current</Badge>}
          {live && (
            <Badge variant="success">
              <BadgeCheck />
              Runs
            </Badge>
          )}
          {base && <span className="text-micro text-subtle-foreground">base</span>}
          <span className="ml-auto text-micro text-subtle-foreground">
            <RelativeTime value={version.created_at} />
          </span>
        </div>
        <p className="line-clamp-2 text-dense">
          {version.notes || <span className="text-subtle-foreground">No notes</span>}
        </p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-muted-foreground">
          <span>{version.created_by_name}</span>
          <span className="text-subtle-foreground">·</span>
          <Mono className="text-[10.5px]" truncate={6}>
            {version.content_sha256}
          </Mono>
        </div>
        <div className="flex items-center gap-2 text-micro">
          {approved ? (
            <span className="inline-flex items-center gap-1 text-success">
              <ShieldCheck className="size-3.5" />
              Approved by {version.approved_by_name}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-warning">
              <Hourglass className="size-3.5" />
              Not approved
            </span>
          )}
          {!approved && canApprove && !script.builtin && (
            <Button
              size="xs"
              variant="outline"
              className="ml-auto"
              disabled={approving}
              onClick={(event) => {
                event.stopPropagation()
                onApprove()
              }}
            >
              <ShieldCheck data-icon="inline-start" />
              Approve
            </Button>
          )}
        </div>
      </div>
    </li>
  )
}

export function ScriptVersions({
  script,
  canApprove,
  approving,
  onApprove,
  onRestore,
  canRestore,
}: {
  script: Script
  canApprove: boolean
  approving: boolean
  onApprove: (version: number) => void
  onRestore: (version: ScriptVersionDetail) => void
  canRestore: boolean
}) {
  const versions = script.versions
  const [target, setTarget] = useState(script.current_version)
  const [base, setBase] = useState<number | null>(null)
  const [layout, setLayout] = useState<'split' | 'unified'>(() =>
    typeof window !== 'undefined' && window.innerWidth < 900 ? 'unified' : 'split',
  )
  const effectiveBase =
    base !== null && base !== target ? base : (versions.find((version) => version.version < target)?.version ?? null)
  const targetQuery = useQuery(scriptVersionQuery(script.id, target))
  const baseQuery = useQuery({ ...scriptVersionQuery(script.id, effectiveBase ?? 0), enabled: effectiveBase !== null })
  const loading = targetQuery.isLoading || (effectiveBase !== null && baseQuery.isLoading)
  const oldText = effectiveBase === null ? '' : (baseQuery.data?.content ?? '')
  const newText = targetQuery.data?.content ?? ''
  const stats = diffStats(diffLines(oldText, newText))
  const paramChanges =
    targetQuery.data && (effectiveBase === null || baseQuery.data)
      ? parameterChanges(baseQuery.data?.parameters ?? [], targetQuery.data.parameters)
      : []

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <div className="grid grid-cols-1 content-start gap-2">
        <div className="flex items-center justify-between px-1">
          <h3 className="text-sm font-semibold">History</h3>
          <span className="text-micro text-muted-foreground">{versions.length} versions · immutable</span>
        </div>
        <ul className="grid grid-cols-1 gap-1 rounded-xl bg-card p-1.5 shadow-card lg:max-h-[640px] lg:overflow-y-auto">
          {versions.map((version) => (
            <VersionCard
              key={version.version}
              version={version}
              script={script}
              active={version.version === target}
              base={version.version === effectiveBase}
              onSelect={() => setTarget(version.version)}
              onApprove={() => onApprove(version.version)}
              canApprove={canApprove}
              approving={approving}
            />
          ))}
        </ul>
      </div>

      <div className="grid min-w-0 grid-cols-1 content-start gap-3">
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-card px-3 py-2.5 shadow-card">
          <div className="flex items-center gap-2">
            <SimpleSelect
              size="sm"
              className="w-28"
              ariaLabel="Compare from"
              value={effectiveBase === null ? 'none' : String(effectiveBase)}
              onValueChange={(value) => setBase(value === 'none' ? null : Number(value))}
              options={[
                { value: 'none', label: 'Empty' },
                ...versions
                  .filter((version) => version.version !== target)
                  .map((version) => ({ value: String(version.version), label: `v${version.version}` })),
              ]}
            />
            <ArrowRight className="size-4 text-subtle-foreground" />
            <SimpleSelect
              size="sm"
              className="w-28"
              ariaLabel="Compare to"
              value={String(target)}
              onValueChange={(value) => setTarget(Number(value))}
              options={versions.map((version) => ({ value: String(version.version), label: `v${version.version}` }))}
            />
          </div>
          {!loading && (
            <span className="tabular text-micro">
              <span className="text-success">+{stats.added}</span>{' '}
              <span className="text-critical">−{stats.removed}</span>
              {paramChanges.length > 0 && <span className="text-muted-foreground"> · {paramChanges.join(', ')}</span>}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {targetQuery.data && <CopyButton value={targetQuery.data.content} label={`Copy v${target}`} />}
            {canRestore && targetQuery.data && target !== script.current_version && (
              <Button size="xs" variant="outline" onClick={() => onRestore(targetQuery.data!)}>
                <RotateCcw data-icon="inline-start" />
                Restore v{target}
              </Button>
            )}
            <ToggleGroup
              className={SEGMENTED}
              value={[layout]}
              onValueChange={(next: string[]) => next[0] && setLayout(next[0] as 'split' | 'unified')}
              variant="outline"
              size="sm"
              spacing={0}
              aria-label="Diff layout"
            >
              <ToggleGroupItem value="split">Split</ToggleGroupItem>
              <ToggleGroupItem value="unified">Unified</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>
        {loading ? (
          <Skeleton className="h-96 rounded-xl" />
        ) : (
          <DiffView oldText={oldText} newText={newText} layout={layout} className="max-h-[640px]" />
        )}
      </div>
    </div>
  )
}
