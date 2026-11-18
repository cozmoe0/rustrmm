import { describe, expect, it } from 'vitest'
import type { MonitorInfo } from './control'
import { clientToRemote, layoutViewport, monitorMiniature, remoteToElement, viewportScale } from './viewport'

const FHD = { width: 1920, height: 1080 }

describe('scale', () => {
  it('fits by shrinking, never by enlarging', () => {
    expect(viewportScale({ width: 960, height: 1000 }, FHD, 'fit')).toBe(0.5)
    expect(viewportScale({ width: 3000, height: 540 }, FHD, 'fit')).toBe(0.5)
    expect(viewportScale({ width: 4000, height: 3000 }, FHD, 'fit')).toBe(1)
  })

  it('maps one remote pixel to one device pixel at 1:1', () => {
    expect(viewportScale({ width: 100, height: 100 }, FHD, 'actual', 1)).toBe(1)
    expect(viewportScale({ width: 100, height: 100 }, FHD, 'actual', 2)).toBe(0.5)
    expect(viewportScale({ width: 100, height: 100 }, FHD, 'actual', 1.25)).toBe(0.8)
  })

  it('centres a fitted screen and flags overflow at 1:1', () => {
    expect(layoutViewport({ width: 1000, height: 1000 }, FHD, 'fit')).toEqual({ scale: 1000 / 1920, width: 1000, height: 563, offsetX: 0, offsetY: 218, overflows: false })
    const actual = layoutViewport({ width: 1000, height: 600 }, FHD, 'actual', 1)
    expect(actual).toMatchObject({ width: 1920, height: 1080, offsetX: 0, offsetY: 0, overflows: true })
    expect(layoutViewport({ width: 1000, height: 600 }, FHD, 'actual', 2)).toMatchObject({ width: 960, height: 540, offsetX: 20, offsetY: 30, overflows: false })
  })
})

describe('pointer mapping', () => {
  it('maps a fitted canvas to remote pixels', () => {
    const rect = { left: 100, top: 50, width: 960, height: 540 }
    expect(clientToRemote(100, 50, rect, FHD)).toEqual({ x: 0, y: 0 })
    expect(clientToRemote(580, 320, rect, FHD)).toEqual({ x: 960, y: 540 })
    expect(clientToRemote(100 + 959.9, 50 + 539.9, rect, FHD)).toEqual({ x: 1919, y: 1079 })
  })

  it('maps 1:1 on a high-DPI display (CSS size is half the remote size)', () => {
    const rect = { left: 0, top: 0, width: 960, height: 540 }
    expect(clientToRemote(10, 10, rect, FHD)).toEqual({ x: 20, y: 20 })
  })

  it('maps 1:1 when the screen is scrolled inside the stage', () => {
    // The screen's rect moves left/up as the stage scrolls.
    const rect = { left: -400, top: -200, width: 1920, height: 1080 }
    expect(clientToRemote(0, 0, rect, FHD)).toEqual({ x: 400, y: 200 })
  })

  it('clamps positions outside the screen unless asked not to', () => {
    const rect = { left: 0, top: 0, width: 960, height: 540 }
    expect(clientToRemote(-50, 9999, rect, FHD)).toEqual({ x: 0, y: 1079 })
    expect(clientToRemote(-50, 600, rect, FHD, false)).toEqual({ x: -100, y: 1200 })
  })

  it('uses the active monitor size after a switch', () => {
    const second = { width: 1600, height: 900 }
    const rect = { left: 0, top: 0, width: 800, height: 450 }
    expect(clientToRemote(400, 225, rect, second)).toEqual({ x: 800, y: 450 })
  })

  it('maps remote positions back onto the element (cursor overlay)', () => {
    expect(remoteToElement(960, 540, { width: 960, height: 540 }, FHD)).toEqual({ x: 480, y: 270 })
    expect(remoteToElement(-20, 0, { width: 960, height: 540 }, FHD)).toEqual({ x: -10, y: 0 })
  })
})

describe('monitor miniature', () => {
  it('keeps the arrangement of the virtual desktop', () => {
    const monitors: MonitorInfo[] = [
      { id: 0, name: 'A', x: 0, y: 0, width: 1920, height: 1080, primary: true, scale: 1 },
      { id: 1, name: 'B', x: 1920, y: 90, width: 1600, height: 900, primary: false, scale: 1 },
    ]
    const [a, b] = monitorMiniature(monitors, { width: 352, height: 108 }, 0)
    expect(b.left).toBeCloseTo(a.left + a.width)
    expect(b.top).toBeGreaterThan(a.top)
    expect(a.width / a.height).toBeCloseTo(1920 / 1080)
    expect(monitorMiniature([], { width: 10, height: 10 })).toEqual([])
  })
})
