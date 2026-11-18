/*
 * Geometry for the remote desktop viewer: how the remote screen is laid out in the stage (fit or
 * 1:1) and how pointer positions map to remote pixels of the active monitor.
 */
import type { MonitorInfo } from './control'

export type ScaleMode = 'fit' | 'actual'

export interface Size {
  width: number
  height: number
}

export interface Rect extends Size {
  left: number
  top: number
}

export interface ViewportLayout {
  /** CSS pixels per remote pixel. */
  scale: number
  /** CSS size of the screen. */
  width: number
  height: number
  /** CSS offset that centres the screen in the stage (0 when it overflows). */
  offsetX: number
  offsetY: number
  /** Whether the screen is larger than the stage (1:1 on a big monitor). */
  overflows: boolean
}

/**
 * CSS pixels per remote pixel. `fit` shrinks the screen to the stage but never enlarges it beyond
 * one remote pixel per CSS pixel; `actual` (1:1) maps one remote pixel to one device pixel so text
 * stays crisp on high-DPI displays.
 */
export function viewportScale(stage: Size, remote: Size, mode: ScaleMode, devicePixelRatio = 1): number {
  if (remote.width <= 0 || remote.height <= 0) return 1
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1
  if (mode === 'actual') return 1 / dpr
  if (stage.width <= 0 || stage.height <= 0) return 1
  return Math.min(1, stage.width / remote.width, stage.height / remote.height)
}

export function layoutViewport(stage: Size, remote: Size, mode: ScaleMode, devicePixelRatio = 1): ViewportLayout {
  const scale = viewportScale(stage, remote, mode, devicePixelRatio)
  const width = Math.max(1, Math.round(remote.width * scale))
  const height = Math.max(1, Math.round(remote.height * scale))
  return {
    scale,
    width,
    height,
    offsetX: Math.max(0, Math.floor((stage.width - width) / 2)),
    offsetY: Math.max(0, Math.floor((stage.height - height) / 2)),
    overflows: width > stage.width + 0.5 || height > stage.height + 0.5,
  }
}

/**
 * Maps a client (viewport) position to remote pixels of the active monitor, given the screen
 * element's bounding rect. Positions outside the screen are clamped to its edge unless `clamp` is
 * false, so a drag that leaves the canvas keeps tracking along the border.
 */
export function clientToRemote(clientX: number, clientY: number, rect: Rect, remote: Size, clamp = true): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 }
  let x = Math.floor(((clientX - rect.left) * remote.width) / rect.width)
  let y = Math.floor(((clientY - rect.top) * remote.height) / rect.height)
  if (clamp) {
    x = Math.min(remote.width - 1, Math.max(0, x))
    y = Math.min(remote.height - 1, Math.max(0, y))
  }
  return { x, y }
}

/** The inverse of `clientToRemote` relative to the screen element (CSS pixels from its top-left). */
export function remoteToElement(x: number, y: number, element: Size, remote: Size): { x: number; y: number } {
  if (remote.width <= 0 || remote.height <= 0) return { x: 0, y: 0 }
  return { x: (x * element.width) / remote.width, y: (y * element.height) / remote.height }
}

export interface MonitorTile extends Rect {
  id: number
}

/**
 * Lays the monitors out inside `box` for the monitor picker's miniature, preserving their
 * arrangement on the virtual desktop.
 */
export function monitorMiniature(monitors: readonly MonitorInfo[], box: Size, gap = 2): MonitorTile[] {
  if (monitors.length === 0) return []
  const minX = Math.min(...monitors.map((monitor) => monitor.x))
  const minY = Math.min(...monitors.map((monitor) => monitor.y))
  const maxX = Math.max(...monitors.map((monitor) => monitor.x + monitor.width))
  const maxY = Math.max(...monitors.map((monitor) => monitor.y + monitor.height))
  const scale = Math.min(box.width / Math.max(1, maxX - minX), box.height / Math.max(1, maxY - minY))
  const usedW = (maxX - minX) * scale
  const usedH = (maxY - minY) * scale
  const padX = (box.width - usedW) / 2
  const padY = (box.height - usedH) / 2
  return monitors.map((monitor) => ({
    id: monitor.id,
    left: padX + (monitor.x - minX) * scale + gap / 2,
    top: padY + (monitor.y - minY) * scale + gap / 2,
    width: Math.max(4, monitor.width * scale - gap),
    height: Math.max(4, monitor.height * scale - gap),
  }))
}

/** "2560 × 1440" */
export function formatResolution(size: Size | null | undefined): string {
  return size ? `${size.width} × ${size.height}` : '—'
}
