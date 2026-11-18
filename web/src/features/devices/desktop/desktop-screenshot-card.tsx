/*
 * Device overview "Screen" card: a one-off screenshot of the console session's primary monitor
 * (`GET /devices/{id}/screenshot`). Captures are taken on request only: each one is audited and,
 * depending on policy, prompts the signed-in user for consent.
 */
import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Camera, CircleExclamationPoint, Lock, MonitorPlay, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { desktopApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { keys } from '@/lib/api/queries'
import type { DeviceDetail } from '@/lib/api/types'
import { formatBytes, formatRelative } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { useNow } from '../remote-hooks'
import { remoteToolAccess } from '../remote-access'
import { policyRefusal } from './desktop-access'

export interface ScreenshotData {
  /** An object URL for the JPEG. */
  url: string
  at: number
  width: number
  height: number
  bytes: number
}

async function capture(deviceId: string, signal: AbortSignal): Promise<ScreenshotData> {
  const blob = await desktopApi.screenshot(deviceId, signal)
  let width = 0
  let height = 0
  try {
    const bitmap = await createImageBitmap(blob)
    width = bitmap.width
    height = bitmap.height
    bitmap.close()
  } catch {
    // Dimensions are informational only.
  }
  return { url: URL.createObjectURL(blob), at: Date.now(), width, height, bytes: blob.size }
}

export function DesktopScreenshotCard({ device, onOpenDesktop, className }: { device: DeviceDetail; onOpenDesktop: () => void; className?: string }) {
  const me = useMe()
  const permitted = hasPermission(me, PERMISSIONS.remoteDesktop)
  const access = remoteToolAccess(device, me, 'desktop')
  const macos = device.os_family === 'macos'
  const shot = useQuery<ScreenshotData>({
    queryKey: keys.desktopScreenshot(device.id),
    queryFn: ({ signal }) => capture(device.id, signal),
    enabled: false,
    staleTime: Infinity,
    gcTime: 15 * 60_000,
    retry: false,
    meta: { silent: true },
  })
  useNow(30_000, Boolean(shot.data))

  // Release the previous image when a new capture replaces it.
  const previous = useRef<string | null>(null)
  const url = shot.data?.url ?? null
  useEffect(() => {
    if (previous.current && previous.current !== url) URL.revokeObjectURL(previous.current)
    previous.current = url
  }, [url])

  if (!permitted || device.status !== 'active') return null

  const refusal = policyRefusal(shot.error)
  const capturing = shot.isFetching
  const blockedReason = macos ? 'Screenshots aren’t available on macOS yet' : refusal ? 'Turned off by policy' : !access.ok ? access.reason : null
  const take = () => void shot.refetch()

  const captureLabel = shot.data ? 'Take a new screenshot' : 'Take a screenshot'
  const refreshIcon = <RefreshCw className={cn(capturing && 'animate-spin')} />

  return (
    <Card size="sm" className={cn('gap-3', className)}>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-sm [&_svg]:size-4 [&_svg]:text-subtle-foreground">
          <Camera />
          Screen
        </CardTitle>
        <div className="flex items-center gap-1.5">
          {shot.data && !capturing && <span className="text-micro text-subtle-foreground">{formatRelative(shot.data.at)}</span>}
          {blockedReason ? (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" tabIndex={0} aria-label={`${captureLabel} — ${blockedReason}`} />}>
                <Button variant="ghost" size="icon-xs" disabled aria-hidden="true" tabIndex={-1}>
                  {refreshIcon}
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-60">{blockedReason}</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={captureLabel} disabled={capturing} onClick={take} />}>{refreshIcon}</TooltipTrigger>
              <TooltipContent>{captureLabel}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </CardHeader>
      <CardContent className="min-w-0">
        <div className="relative aspect-video overflow-hidden rounded-lg bg-[#0e1014] ring-1 ring-border">
          {shot.data && (
            <button
              type="button"
              onClick={onOpenDesktop}
              disabled={!access.ok}
              className="group absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              aria-label="Open remote desktop"
            >
              <img src={shot.data.url} alt={`Screenshot of ${device.hostname}`} className={cn('size-full object-contain transition-[filter,opacity] duration-300', capturing && 'opacity-50 blur-[1px]')} />
              {access.ok && (
                <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-[opacity,background-color] group-hover:bg-black/45 group-hover:opacity-100 group-focus-visible:bg-black/45 group-focus-visible:opacity-100">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-white/95 px-3 py-1 text-micro font-semibold text-[#16181c] shadow-lg">
                    <MonitorPlay className="size-3.5" />
                    Open remote desktop
                  </span>
                </span>
              )}
            </button>
          )}

          {!shot.data && !capturing && !shot.error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 p-4 text-center">
              <Button size="sm" variant="outline" className="border-white/15 bg-white/[0.06] text-white hover:bg-white/[0.12] dark:bg-white/[0.06]" disabled={Boolean(blockedReason)} onClick={take}>
                <Camera data-icon="inline-start" />
                Take a screenshot
              </Button>
              <p className="max-w-60 text-micro text-white/55">{blockedReason ?? 'Captures are audited. Depending on policy, the user is asked first.'}</p>
            </div>
          )}

          {capturing && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center">
              <span className="inline-flex items-center gap-2 rounded-full bg-black/55 px-3 py-1 text-micro font-medium text-white backdrop-blur">
                <Spinner className="size-3" />
                Capturing…
              </span>
              {!shot.data && <p className="text-micro text-white/50">The user may be asked to allow it.</p>}
            </div>
          )}

          {shot.error && !capturing && !shot.data && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center">
              {refusal ? <Lock className="size-5 text-[oklch(0.82_0.13_80)]" /> : <CircleExclamationPoint className="size-5 text-[oklch(0.72_0.17_22)]" />}
              <p className="text-dense font-medium text-white">{refusal ? 'Turned off by policy' : 'No screenshot'}</p>
              <p className={cn('max-w-64 text-micro break-words text-white/60', isApiError(shot.error) && shot.error.code === 'device_error' && 'font-mono')}>
                {refusal ? (refusal.policyName ? `“${refusal.policyName}” disables screenshots on this device.` : 'A policy disables screenshots on this device.') : errorMessage(shot.error)}
              </p>
              {!refusal && (
                <Button size="xs" variant="outline" className="mt-1 border-white/15 bg-white/[0.06] text-white hover:bg-white/[0.12] dark:bg-white/[0.06]" onClick={take} disabled={Boolean(blockedReason)}>
                  Try again
                </Button>
              )}
            </div>
          )}
        </div>
        {shot.data && (
          <p className="tabular mt-2 flex items-center justify-between gap-2 text-micro text-subtle-foreground">
            <span>
              Console · primary monitor{shot.data.width ? ` · ${shot.data.width}×${shot.data.height}` : ''}
            </span>
            <span>{formatBytes(shot.data.bytes)}</span>
          </p>
        )}
        {shot.error && shot.data && !capturing && (
          <p className="mt-1.5 text-micro break-words text-critical">{refusal ? 'Turned off by policy' : errorMessage(shot.error)}</p>
        )}
      </CardContent>
    </Card>
  )
}
