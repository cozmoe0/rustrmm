import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, CircleCheck, CircleX, TriangleExclamationPoint } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CopyButton } from '@/components/common/copy-button'
import { ErrorState, Mono } from '@/components/common/misc'
import { OsIcon } from '@/components/common/os-icon'
import { jobResultQuery } from '@/lib/api/queries'
import { RESULT_STATUS, formatDurationMs } from '@/lib/automation/labels'
import { formatDateTime } from '@/lib/format'
import { InlineAlert } from '@/features/devices/remote-ui'
import { MetaItem, OutputBlock, ResultStatusBadge } from './automation-ui'

/** stdout, stderr and applied directives for one device in one run. */
export function OutputDrawer({
  runId,
  deviceId,
  title,
  onClose,
}: {
  runId: string | null
  deviceId: string | null
  title?: string
  onClose: () => void
}) {
  const open = Boolean(runId && deviceId)
  const { data, isLoading, error, refetch } = useQuery({
    ...jobResultQuery(runId ?? '', deviceId ?? ''),
    enabled: open,
    // Results that are still in flight are polled until the device reports back.
    refetchInterval: (query) => (query.state.data && !RESULT_STATUS[query.state.data.status].done ? 1500 : false),
  })
  const [tab, setTab] = useState('stdout')
  const stdoutLines = data?.stdout ? data.stdout.split('\n').length : 0
  const stderrLines = data?.stderr ? data.stderr.split('\n').length : 0

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose()
          setTab('stdout')
        }
      }}
    >
      <SheetContent
        side="right"
        className="gap-0 p-0 shadow-popover data-[side=right]:w-full data-[side=right]:sm:max-w-[760px]"
      >
        <SheetHeader className="gap-3 border-b border-border px-5 pt-5 pb-4">
          <div className="flex items-start gap-3 pr-8">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 shadow-raised ring-1 ring-border">
              {data ? <OsIcon family={data.os_family} className="size-4.5" /> : null}
            </span>
            <div className="min-w-0">
              <SheetTitle className="truncate text-base">{data?.hostname ?? 'Device output'}</SheetTitle>
              <SheetDescription className="truncate">
                {data ? `${data.client_name}${title ? ` · ${title}` : ''}` : title}
              </SheetDescription>
            </div>
          </div>
          {data && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              <MetaItem label="Status">
                <ResultStatusBadge status={data.status} />
              </MetaItem>
              <MetaItem label="Exit code">
                {data.exit_code === null ? (
                  '—'
                ) : (
                  <span className={data.exit_code === 0 ? 'text-success' : 'text-critical'}>{data.exit_code}</span>
                )}
              </MetaItem>
              <MetaItem label="Duration">{formatDurationMs(data.duration_ms)}</MetaItem>
              <MetaItem label="Finished">
                {data.finished_at
                  ? formatDateTime(data.finished_at)
                  : RESULT_STATUS[data.status].done
                    ? '—'
                    : 'In progress'}
              </MetaItem>
            </div>
          )}
          {data && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                render={
                  <Link to="/devices/$deviceId" params={{ deviceId: data.device_id }} search={{ tab: 'scripts' }} />
                }
                nativeButton={false}
              >
                Open device
                <ArrowUpRight data-icon="inline-end" />
              </Button>
            </div>
          )}
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
          {error ? (
            <ErrorState error={error} onRetry={() => void refetch()} />
          ) : isLoading || !data ? (
            <div className="grid grid-cols-1 gap-3">
              <Skeleton className="h-8 w-60" />
              <Skeleton className="h-80 rounded-lg" />
            </div>
          ) : (
            <>
              {data.error && (
                <InlineAlert
                  tone={data.status === 'skipped' || data.status === 'cancelled' ? 'info' : 'critical'}
                  title={
                    data.status === 'timed_out'
                      ? 'The script timed out'
                      : data.status === 'skipped'
                        ? 'Skipped'
                        : 'The agent reported an error'
                  }
                >
                  {data.error}
                </InlineAlert>
              )}
              {data.truncated && (
                <InlineAlert tone="warning" title="Output truncated">
                  The output exceeded the per-stream cap set in automation settings, so only the beginning was kept.
                </InlineAlert>
              )}
              {!RESULT_STATUS[data.status].done ? (
                <div className="rounded-lg bg-surface-2 px-4 py-10 text-center text-dense text-muted-foreground ring-1 ring-border">
                  {data.status === 'running'
                    ? 'The script is running. Output appears when it finishes.'
                    : data.status === 'waiting_offline'
                      ? 'Waiting for the device to come online.'
                      : 'Queued — waiting for a free slot.'}
                </div>
              ) : (
                <Tabs value={tab} onValueChange={(value) => setTab(String(value))} className="min-h-0 flex-1 gap-3">
                  <div className="flex items-center gap-2">
                    <TabsList>
                      <TabsTrigger value="stdout" className="px-2.5">
                        Output
                        <span className="tabular text-micro text-subtle-foreground">{stdoutLines}</span>
                      </TabsTrigger>
                      <TabsTrigger value="stderr" className="px-2.5">
                        Errors
                        {stderrLines > 0 && <span className="tabular text-micro text-critical">{stderrLines}</span>}
                      </TabsTrigger>
                      <TabsTrigger value="directives" className="px-2.5">
                        Directives
                        {data.directives.length > 0 && (
                          <span className="tabular text-micro text-subtle-foreground">{data.directives.length}</span>
                        )}
                      </TabsTrigger>
                    </TabsList>
                    {tab !== 'directives' && (
                      <CopyButton
                        value={tab === 'stdout' ? data.stdout : data.stderr}
                        label={tab === 'stdout' ? 'Copy output' : 'Copy errors'}
                        className="ml-auto"
                      />
                    )}
                  </div>
                  <TabsContent value="stdout">
                    <OutputBlock
                      text={data.stdout}
                      numbered
                      empty="The script wrote nothing to stdout."
                      className="max-h-[calc(100dvh-360px)] min-h-48"
                    />
                  </TabsContent>
                  <TabsContent value="stderr">
                    <OutputBlock
                      text={data.stderr}
                      numbered
                      empty="Nothing on stderr."
                      className="max-h-[calc(100dvh-360px)] min-h-48 text-critical/90"
                    />
                  </TabsContent>
                  <TabsContent value="directives" className="grid grid-cols-1 content-start gap-3">
                    <p className="text-dense text-muted-foreground">
                      Lines like <Mono>::rustrmm::set-field key=value</Mono> set a device custom field when it exists,
                      is a device field and is writable by scripts.
                    </p>
                    {data.directives.length === 0 ? (
                      <div className="rounded-lg bg-surface-2 px-4 py-6 text-center text-dense text-subtle-foreground ring-1 ring-border">
                        No directives in this output.
                      </div>
                    ) : (
                      <ul className="divide-y divide-border overflow-hidden rounded-lg ring-1 ring-border">
                        {data.directives.map((directive, index) => (
                          <li
                            key={`${directive.field}-${index}`}
                            className="flex items-center gap-3 px-3 py-2.5 text-dense"
                          >
                            {directive.applied ? (
                              <CircleCheck className="size-4 shrink-0 text-success" />
                            ) : (
                              <CircleX className="size-4 shrink-0 text-subtle-foreground" />
                            )}
                            <Mono>{directive.field}</Mono>
                            <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{directive.value}</span>
                            {directive.applied ? (
                              <Badge variant="success">Applied</Badge>
                            ) : (
                              <Badge variant="outline">
                                <TriangleExclamationPoint />
                                Refused
                              </Badge>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </TabsContent>
                </Tabs>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
