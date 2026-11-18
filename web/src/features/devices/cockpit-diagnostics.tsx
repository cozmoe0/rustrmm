/* Network diagnostics run from the device: ping, traceroute, DNS lookup and TCP port test. */
import { useState, type ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import { CircleCheck, CircleX, Clock, Globe, Play, Plug, Radar, Route, Timer } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { CopyButton } from '@/components/common/copy-button'
import { remoteApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import type { CommandDiagnostic, DeviceDetail, DiagnosticKind, DiagnosticResult, DnsDiagnostic, PortDiagnostic } from '@/lib/api/types'
import { deviceName } from '@/lib/devices'
import { formatClock, formatTime } from '@/lib/format'
import { validatePort, validateTarget } from '@/lib/remote'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { useDeviceGoneHandler, useNow } from './remote-hooks'
import { InlineAlert } from './remote-ui'
import { TERMINAL_THEMES } from './terminal-theme'

const KINDS: { value: DiagnosticKind; label: string; icon: typeof Radar; hint: string }[] = [
  { value: 'ping', label: 'Ping', icon: Radar, hint: 'Four ICMP echo requests' },
  { value: 'traceroute', label: 'Traceroute', icon: Route, hint: 'Hop-by-hop path; can take up to 90 s' },
  { value: 'dns', label: 'DNS lookup', icon: Globe, hint: 'Resolve with the device’s resolver' },
  { value: 'port', label: 'Port test', icon: Plug, hint: 'TCP connect from the device' },
]

const COMMON_PORTS = [22, 53, 80, 443, 445, 3389, 8443]

interface Run {
  id: number
  kind: DiagnosticKind
  target: string
  port?: number
  at: number
  result?: DiagnosticResult
  error?: unknown
}

let runCounter = 0

function Stat({ label, children, tone }: { label: string; children: ReactNode; tone?: 'good' | 'bad' }) {
  return (
    <div className="min-w-24">
      <div className="text-micro text-subtle-foreground">{label}</div>
      <div className={cn('tabular mt-0.5 text-[15px] font-semibold tracking-tight', tone === 'good' && 'text-live', tone === 'bad' && 'text-critical')}>{children}</div>
    </div>
  )
}

function ConsoleOutput({ result }: { result: CommandDiagnostic }) {
  const { resolved } = useTheme()
  const theme = TERMINAL_THEMES[resolved]
  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-border" style={{ background: theme.background, color: theme.foreground }}>
      <div className="flex items-center gap-2 border-b px-3 py-1.5 font-mono text-[11px]" style={{ borderColor: 'color-mix(in oklch, currentColor 12%, transparent)' }}>
        <span style={{ color: theme.brightBlack }}>$</span>
        <span className="min-w-0 flex-1 truncate">{result.command}</span>
        <span className="shrink-0" style={{ color: result.exit_code === 0 ? theme.green : theme.red }}>
          exit {result.exit_code ?? '—'}
        </span>
        <CopyButton value={result.output} label="Copy output" className="text-current opacity-70 hover:opacity-100" />
      </div>
      <pre className="max-h-[min(52vh,520px)] overflow-auto px-3 py-2.5 font-mono text-[12px] leading-[1.55] whitespace-pre">{result.output || '(no output)'}</pre>
    </div>
  )
}

function ResultView({ run }: { run: Run }) {
  if (run.error) {
    const agent = isApiError(run.error) && run.error.code === 'device_error'
    return (
      <InlineAlert title={agent ? 'The agent refused the test' : isApiError(run.error) && run.error.code === 'device_timeout' ? 'The agent didn’t answer in time' : 'The test failed'}>
        <span className={cn(agent && 'font-mono text-[12px] text-foreground/85')}>{errorMessage(run.error)}</span>
      </InlineAlert>
    )
  }
  const result = run.result
  if (!result) return null

  if (run.kind === 'ping' || run.kind === 'traceroute') {
    const command = result as CommandDiagnostic
    return (
      <div className="grid gap-3">
        <div className="flex flex-wrap items-end gap-x-7 gap-y-3">
          <Stat label="Result" tone={command.exit_code === 0 && !command.timed_out ? 'good' : 'bad'}>
            {command.timed_out ? 'Timed out' : command.exit_code === 0 ? (run.kind === 'ping' ? 'Reachable' : 'Completed') : run.kind === 'ping' ? 'Unreachable' : 'Incomplete'}
          </Stat>
          <Stat label="Exit code">{command.exit_code ?? '—'}</Stat>
          <Stat label="Duration">{(command.duration_ms / 1000).toFixed(1)} s</Stat>
          {command.timed_out && <Badge variant="warning">Stopped at the time limit</Badge>}
        </div>
        <ConsoleOutput result={command} />
      </div>
    )
  }

  if (run.kind === 'dns') {
    const dns = result as DnsDiagnostic
    return (
      <div className="grid gap-4">
        <div className="flex flex-wrap items-end gap-x-7 gap-y-3">
          <Stat label="Result" tone={dns.resolved ? 'good' : 'bad'}>
            {dns.resolved ? 'Resolved' : 'Not resolved'}
          </Stat>
          <Stat label="Addresses">{dns.addresses.length}</Stat>
          <Stat label="Lookup time">{dns.duration_ms} ms</Stat>
        </div>
        {dns.error && (
          <InlineAlert title="Resolver error">
            <span className="font-mono text-[12px]">{dns.error}</span>
          </InlineAlert>
        )}
        {dns.addresses.length > 0 && (
          <ul className="divide-y divide-border overflow-hidden rounded-lg ring-1 ring-border">
            {dns.addresses.map((address) => (
              <li key={address} className="flex items-center gap-3 bg-surface-2/50 px-3 py-2">
                <Badge variant={address.includes(':') ? 'info' : 'secondary'} className="w-10 justify-center font-mono">
                  {address.includes(':') ? 'AAAA' : 'A'}
                </Badge>
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{address}</span>
                <CopyButton value={address} label={`Copy ${address}`} />
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  const port = result as PortDiagnostic
  return (
    <div className="grid gap-4">
      <div className={cn('flex items-center gap-4 rounded-xl px-4 py-4 ring-1', port.open ? 'bg-live/[0.07] ring-live/25' : 'bg-critical/[0.06] ring-critical/25')}>
        <span className={cn('flex size-11 items-center justify-center rounded-xl', port.open ? 'bg-live/15 text-live' : 'bg-critical/12 text-critical')}>
          {port.open ? <CircleCheck className="size-5" /> : <CircleX className="size-5" />}
        </span>
        <div className="min-w-0">
          <p className="font-display text-lg font-semibold tracking-tight">
            Port {run.port} is {port.open ? 'open' : 'closed or filtered'}
          </p>
          <p className="text-dense text-muted-foreground">
            {port.open ? `${run.target} accepted a TCP connection` : `A TCP connection to ${run.target}:${run.port} didn’t complete`}
            {port.address && (
              <>
                {' '}
                via <span className="font-mono text-foreground">{port.address}</span>
              </>
            )}
            .
          </p>
        </div>
        {port.latency_ms !== null && port.latency_ms !== undefined && (
          <div className="ml-auto text-right">
            <div className="text-micro text-subtle-foreground">Connect time</div>
            <div className="tabular text-xl font-semibold">{port.latency_ms} ms</div>
          </div>
        )}
      </div>
      {port.error && (
        <InlineAlert tone="warning" title="Connection error">
          <span className="font-mono text-[12px]">{port.error}</span>
        </InlineAlert>
      )}
    </div>
  )
}

function RunningPanel({ run }: { run: Run }) {
  const now = useNow(250)
  const kind = KINDS.find((item) => item.value === run.kind)!
  const elapsed = (now - run.at) / 1000
  return (
    <div className="flex items-center gap-3 rounded-xl bg-info/[0.06] px-4 py-3 ring-1 ring-info/20" aria-live="polite">
      <Spinner className="size-4 text-info" />
      <div className="min-w-0 flex-1">
        <p className="text-dense font-medium">
          Running {kind.label.toLowerCase()} to <span className="font-mono">{run.target}</span>
          {run.kind === 'port' && `:${run.port}`}
        </p>
        <p className="text-micro text-muted-foreground">{run.kind === 'traceroute' ? 'Traceroutes can take up to 90 seconds.' : 'Waiting for the agent…'}</p>
      </div>
      <span className="tabular font-mono text-[12px] text-muted-foreground">{formatClock(elapsed)}</span>
    </div>
  )
}

export function DiagnosticsTool({ device }: { device: DeviceDetail }) {
  const onDeviceGone = useDeviceGoneHandler(device.id)
  const [kind, setKind] = useState<DiagnosticKind>('ping')
  const [target, setTarget] = useState('')
  const [port, setPort] = useState('443')
  const [touched, setTouched] = useState(false)
  const [runs, setRuns] = useState<Run[]>([])
  const [shown, setShown] = useState<number | null>(null)

  const targetError = validateTarget(target)
  const portError = kind === 'port' ? validatePort(port) : null

  const mutation = useMutation({
    mutationFn: (run: Run) => remoteApi.diagnostics(device.id, { kind: run.kind, target: run.target, port: run.port }),
    meta: { silent: true },
    onSuccess: (result, run) => setRuns((prev) => prev.map((item) => (item.id === run.id ? { ...item, result } : item))),
    onError: (error, run) => {
      onDeviceGone(error)
      setRuns((prev) => prev.map((item) => (item.id === run.id ? { ...item, error } : item)))
    },
  })

  function start() {
    setTouched(true)
    if (targetError || portError || mutation.isPending) return
    runCounter += 1
    const run: Run = { id: runCounter, kind, target: target.trim(), port: kind === 'port' ? Number(port) : undefined, at: Date.now() }
    setRuns((prev) => [run, ...prev].slice(0, 12))
    setShown(run.id)
    mutation.mutate(run)
  }

  const current = runs.find((run) => run.id === shown) ?? null
  const running = current && !current.result && !current.error
  const kindMeta = KINDS.find((item) => item.value === kind)!

  return (
    <div className="grid gap-4 [&>*]:min-w-0 xl:grid-cols-[1fr_17rem]">
      <div className="grid content-start gap-4 [&>*]:min-w-0">
        <form
          noValidate
          className="grid gap-4 rounded-xl bg-card p-4 shadow-card"
          onSubmit={(event) => {
            event.preventDefault()
            start()
          }}
        >
          <ToggleGroup
            value={[kind]}
            onValueChange={(value: string[]) => value[0] && setKind(value[0] as DiagnosticKind)}
            aria-label="Test"
            className="flex-wrap"
          >
            {KINDS.map((item) => {
              const Icon = item.icon
              return (
                <ToggleGroupItem key={item.value} value={item.value} size="sm" className="gap-1.5 aria-pressed:bg-surface-3 aria-pressed:text-foreground">
                  <Icon />
                  {item.label}
                </ToggleGroupItem>
              )
            })}
          </ToggleGroup>
          <div className="flex flex-wrap items-start gap-3">
            <Field className="min-w-0 flex-[1_1_16rem]" data-invalid={(touched && Boolean(targetError)) || undefined}>
              <FieldLabel htmlFor="diag-target">Target</FieldLabel>
              <Input
                id="diag-target"
                value={target}
                autoComplete="off"
                spellCheck={false}
                placeholder="example.com or 192.0.2.10"
                className="font-mono text-[13px]"
                aria-invalid={(touched && Boolean(targetError)) || undefined}
                onChange={(event) => setTarget(event.target.value)}
              />
              {touched && targetError ? <FieldError>{targetError}</FieldError> : <p className="text-micro text-muted-foreground">{kindMeta.hint}, run on {deviceName(device)}.</p>}
            </Field>
            {kind === 'port' && (
              <Field className="w-32" data-invalid={(touched && Boolean(portError)) || undefined}>
                <FieldLabel htmlFor="diag-port">Port</FieldLabel>
                <Input
                  id="diag-port"
                  inputMode="numeric"
                  value={port}
                  className="tabular font-mono text-[13px]"
                  aria-invalid={(touched && Boolean(portError)) || undefined}
                  onChange={(event) => setPort(event.target.value.replace(/[^\d]/g, '').slice(0, 5))}
                />
                {touched && portError && <FieldError>{portError}</FieldError>}
              </Field>
            )}
            <Button type="submit" className="mt-6" disabled={mutation.isPending}>
              {mutation.isPending ? <Spinner data-icon="inline-start" /> : <Play data-icon="inline-start" />}
              Run {kindMeta.label.toLowerCase()}
            </Button>
          </div>
          {kind === 'port' && (
            <div className="-mt-1 flex flex-wrap items-center gap-1.5">
              <span className="text-micro text-subtle-foreground">Common:</span>
              {COMMON_PORTS.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setPort(String(value))}
                  className={cn(
                    'h-6 rounded-md px-2 font-mono text-[11px] ring-1 transition-colors',
                    port === String(value) ? 'bg-primary/10 text-foreground ring-primary/30' : 'text-muted-foreground ring-border hover:bg-surface-3',
                  )}
                >
                  {value}
                </button>
              ))}
            </div>
          )}
        </form>

        {current ? (
          running ? (
            <RunningPanel run={current} />
          ) : (
            <section className="grid gap-3 rounded-xl bg-card p-4 shadow-card" aria-label="Result">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">
                  {KINDS.find((item) => item.value === current.kind)?.label} <span className="font-mono font-medium">{current.target}</span>
                  {current.kind === 'port' && <span className="font-mono font-medium">:{current.port}</span>}
                </h3>
                <span className="text-micro text-subtle-foreground">from {deviceName(device)} · {formatTime(current.at)}</span>
              </div>
              <ResultView run={current} />
            </section>
          )
        ) : (
          <div className="relative flex flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border border-dashed border-border-strong px-6 py-12 text-center">
            <div className="bg-grid bg-grid-fade pointer-events-none absolute inset-0 opacity-70" />
            <Radar className="relative size-6 text-subtle-foreground" />
            <p className="relative text-dense font-medium">Test the network from the device’s point of view</p>
            <p className="relative max-w-md text-micro text-muted-foreground">
              Useful when a user can’t reach a site, a printer drops off, or a line-of-business app can’t find its server.
            </p>
          </div>
        )}
      </div>

      {/* History */}
      <aside className="grid content-start gap-2" aria-label="Recent tests">
        <div className="eyebrow px-1">Recent tests</div>
        {runs.length === 0 ? (
          <p className="px-1 text-micro text-muted-foreground">Tests you run in this session appear here.</p>
        ) : (
          <ul className="grid gap-1">
            {runs.map((run) => {
              const Icon = KINDS.find((item) => item.value === run.kind)!.icon
              const ok = run.result
                ? 'open' in run.result
                  ? run.result.open
                  : 'resolved' in run.result
                    ? run.result.resolved
                    : run.result.exit_code === 0 && !run.result.timed_out
                : null
              return (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => setShown(run.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
                      shown === run.id ? 'bg-surface-3 text-foreground' : 'text-muted-foreground hover:bg-surface-3/60 hover:text-foreground',
                    )}
                  >
                    <Icon className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                      {run.target}
                      {run.kind === 'port' && `:${run.port}`}
                    </span>
                    {run.error ? (
                      <CircleX className="size-3.5 shrink-0 text-critical" />
                    ) : ok === null ? (
                      <Spinner className="size-3 shrink-0" />
                    ) : ok ? (
                      <CircleCheck className="size-3.5 shrink-0 text-live" />
                    ) : (
                      <CircleX className="size-3.5 shrink-0 text-critical" />
                    )}
                    <span className="tabular flex shrink-0 items-center gap-0.5 text-[10.5px] text-subtle-foreground">
                      {run.kind === 'traceroute' ? <Timer className="size-3" /> : <Clock className="size-3" />}
                      {formatTime(run.at)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </aside>
    </div>
  )
}
