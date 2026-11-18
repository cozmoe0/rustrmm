/* asciicast v2 player for recorded shell sessions, rendered with xterm.js. Lazy-loaded. */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Pause, Play, RotateCcw, SkipBack } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ErrorState } from '@/components/common/misc'
import { remoteApi } from '@/lib/api/endpoints'
import { keys } from '@/lib/api/queries'
import { compressIdle, eventIndexAt, parseAsciicast, playbackOps, sizeAt, type Asciicast, type AsciicastEvent } from '@/lib/asciicast'
import { formatClock, formatDateTime } from '@/lib/format'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { TERMINAL_FONT, TERMINAL_THEMES, loadTerminalFont, terminalCellRatio } from './terminal-theme'

const SPEEDS = [0.5, 1, 2, 4, 8]
const IDLE_LIMIT = 2

export default function RecordingPlayer({ sessionId }: { sessionId: string }) {
  const recording = useQuery({
    queryKey: keys.recording(sessionId),
    queryFn: () => remoteApi.recording(sessionId),
    staleTime: Infinity,
    meta: { silent: true },
  })

  const parsed = useMemo<{ cast: Asciicast | null; error: unknown }>(() => {
    if (recording.data === undefined) return { cast: null, error: null }
    try {
      return { cast: parseAsciicast(recording.data), error: null }
    } catch (error) {
      return { cast: null, error }
    }
  }, [recording.data])

  if (recording.isLoading) {
    return (
      <div className="grid gap-3">
        <Skeleton className="aspect-[16/8] w-full rounded-lg" />
        <Skeleton className="h-9 w-full rounded-lg" />
      </div>
    )
  }
  if (recording.error || parsed.error) {
    return <ErrorState error={recording.error ?? parsed.error} title="Couldn’t load this recording" onRetry={recording.error ? () => void recording.refetch() : undefined} />
  }
  if (!parsed.cast) return null
  return <Player cast={parsed.cast} />
}

function Player({ cast }: { cast: Asciicast }) {
  const { resolved } = useTheme()
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [skipIdle, setSkipIdle] = useState(true)
  const [time, setTime] = useState(0)
  const [ready, setReady] = useState(false)

  const wrapRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const indexRef = useRef(0)
  const timeRef = useRef(0)
  const sizeRef = useRef({ cols: cast.header.width, rows: cast.header.height })

  const timeline = useMemo<AsciicastEvent[]>(() => (skipIdle ? compressIdle(cast.events, IDLE_LIMIT) : cast.events), [cast, skipIdle])
  const timelineRef = useRef(timeline)
  useEffect(() => {
    timelineRef.current = timeline
  }, [timeline])
  const duration = timeline.at(-1)?.time ?? 0
  const savedSeconds = cast.duration - (compressIdle(cast.events, IDLE_LIMIT).at(-1)?.time ?? 0)

  /** Scales the font so the recorded width fits the player. */
  const fitFont = useCallback(() => {
    const term = termRef.current
    const wrap = wrapRef.current
    if (!term || !wrap) return
    const width = wrap.clientWidth - 24
    const size = Math.max(6, Math.min(14, Math.floor((width / (sizeRef.current.cols * terminalCellRatio())) * 10) / 10))
    if (term.options.fontSize !== size) term.options.fontSize = size
  }, [])

  const resizeTerm = useCallback(
    (cols: number, rows: number) => {
      sizeRef.current = { cols, rows }
      termRef.current?.resize(cols, rows)
      fitFont()
    },
    [fitFont],
  )

  /** Brings the terminal to the state at `target` seconds, replaying from the start when seeking back. */
  const applyTo = useCallback(
    (target: number) => {
      const term = termRef.current
      if (!term) return
      const events = timelineRef.current
      const next = eventIndexAt(events, target)
      if (next < indexRef.current) {
        term.reset()
        const size = sizeAt(cast.header, events, 0)
        resizeTerm(size.cols, size.rows)
        indexRef.current = 0
      }
      for (const op of playbackOps(events, indexRef.current, next)) {
        if (op.kind === 'output') term.write(op.data)
        else resizeTerm(op.cols, op.rows)
      }
      indexRef.current = next
      timeRef.current = target
    },
    [cast.header, resizeTerm],
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    const term = new Terminal({
      cols: cast.header.width,
      rows: cast.header.height,
      fontFamily: TERMINAL_FONT,
      fontSize: 12,
      lineHeight: 1.15,
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: 'bar',
      scrollback: 0,
      theme: TERMINAL_THEMES[document.documentElement.classList.contains('dark') ? 'dark' : 'light'],
    })
    termRef.current = term
    const observer = new ResizeObserver(() => fitFont())
    void loadTerminalFont(12).then(() => {
      if (disposed) return
      term.open(host)
      fitFont()
      observer.observe(wrapRef.current ?? host)
      setReady(true)
      setPlaying(true)
    })
    return () => {
      disposed = true
      observer.disconnect()
      term.dispose()
      termRef.current = null
    }
  }, [cast.header.width, cast.header.height, fitFont])

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = TERMINAL_THEMES[resolved]
  }, [resolved])

  // Playback loop.
  useEffect(() => {
    if (!playing || !ready) return
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      const end = timelineRef.current.at(-1)?.time ?? 0
      const next = Math.min(end, timeRef.current + ((now - last) / 1000) * speed)
      last = now
      applyTo(next)
      setTime(next)
      if (next >= end) {
        setPlaying(false)
        return
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, ready, speed, applyTo])

  const seek = (target: number) => {
    const clamped = Math.max(0, Math.min(duration, target))
    applyTo(clamped)
    setTime(clamped)
  }

  const togglePlay = () => {
    if (!ready) return
    if (!playing && timeRef.current >= duration) seek(0)
    setPlaying((value) => !value)
  }

  const toggleIdle = (next: boolean) => {
    // Keep the same position in the recording when the timeline is re-timed.
    const index = indexRef.current
    const nextTimeline = next ? compressIdle(cast.events, IDLE_LIMIT) : cast.events
    const mapped = index > 0 ? nextTimeline[index - 1].time : 0
    timelineRef.current = nextTimeline
    timeRef.current = mapped
    setTime(mapped)
    setSkipIdle(next)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('input, button, [role="radio"], [role="switch"]') && event.key !== ' ') return
    if (event.key === ' ' || event.key === 'k') {
      event.preventDefault()
      togglePlay()
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      seek(timeRef.current + 5)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      seek(timeRef.current - 5)
    } else if (event.key === 'Home') {
      event.preventDefault()
      seek(0)
    }
  }

  const theme = TERMINAL_THEMES[resolved]
  const finished = ready && !playing && time >= duration && duration > 0
  const progress = duration > 0 ? (time / duration) * 100 : 0

  return (
    <div className="grid gap-3 outline-none" tabIndex={0} onKeyDown={onKeyDown} aria-label="Recording player. Space plays or pauses, arrow keys seek.">
      <div ref={wrapRef} className="relative overflow-hidden rounded-lg ring-1 ring-border" style={{ background: theme.background }}>
        <div className="max-h-[62vh] overflow-auto p-3">
          <div ref={hostRef} className="rustrmm-terminal w-max" />
        </div>
        {!playing && ready && (
          <button
            type="button"
            onClick={togglePlay}
            aria-label={finished ? 'Replay' : 'Play'}
            className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors hover:bg-black/10"
          >
            <span className="flex size-14 items-center justify-center rounded-full bg-card/90 text-foreground shadow-popover ring-1 ring-border backdrop-blur">
              {finished ? <RotateCcw className="size-6" /> : <Play className="ml-0.5 size-6" />}
            </span>
          </button>
        )}
      </div>

      {/* Transport */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Back to start" onClick={() => seek(0)} disabled={!ready} />}>
              <SkipBack />
            </TooltipTrigger>
            <TooltipContent>Back to start (Home)</TooltipContent>
          </Tooltip>
          <Button size="icon-sm" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay} disabled={!ready}>
            {playing ? <Pause /> : <Play />}
          </Button>
        </div>
        <span className="tabular w-[92px] font-mono text-[11.5px] text-muted-foreground">
          {formatClock(time)} / {formatClock(duration)}
        </span>
        <div className="relative flex h-6 min-w-40 flex-1 items-center">
          <div className="pointer-events-none absolute inset-x-0 h-1 rounded-full bg-surface-4">
            <div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
          </div>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.01}
            value={time}
            aria-label="Seek"
            aria-valuetext={`${formatClock(time)} of ${formatClock(duration)}`}
            disabled={!ready || duration === 0}
            onChange={(event) => seek(Number(event.target.value))}
            className={cn(
              'relative h-6 w-full cursor-pointer appearance-none bg-transparent focus-visible:outline-none',
              '[&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-[0_0_0_3px_var(--card)]',
              '[&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary',
              'focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-ring',
            )}
          />
        </div>
        <ToggleGroup value={[String(speed)]} onValueChange={(value: string[]) => value[0] && setSpeed(Number(value[0]))} aria-label="Playback speed" variant="outline" spacing={0} size="sm">
          {SPEEDS.map((value) => (
            <ToggleGroupItem key={value} value={String(value)} size="sm" className="px-2 font-mono text-[11px]">
              {value}×
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger render={<Label className="flex items-center gap-2 text-dense font-normal text-muted-foreground" />}>
            <Switch size="sm" checked={skipIdle} onCheckedChange={toggleIdle} />
            Skip idle
          </TooltipTrigger>
          <TooltipContent>
            Shortens pauses longer than {IDLE_LIMIT} s{savedSeconds >= 1 ? ` (saves ${formatClock(savedSeconds)})` : ''}
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-micro text-subtle-foreground">
        {cast.header.timestamp && <span>Recorded {formatDateTime(cast.header.timestamp * 1000)}</span>}
        <span className="tabular">
          {cast.header.width}×{cast.header.height}
        </span>
        <span className="tabular">Real length {formatClock(cast.duration)}</span>
        <span className="ml-auto hidden sm:inline">Space play/pause · ←/→ seek 5 s</span>
      </div>
    </div>
  )
}
