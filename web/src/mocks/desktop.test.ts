import { describe, expect, it } from 'vitest'
import { RAW_MAX_PIXELS } from '@/lib/desktop/protocol'
import { consentRequired, type DesktopPolicy } from './desktop-data'
import { dirtyTileGrid, mergeTiles } from './desktop-encoder'

describe('mock agent tiling', () => {
  it('marks every 64×64 tile a dirty rect touches', () => {
    const { grid, cols, rows } = dirtyTileGrid([{ x: 60, y: 10, w: 10, h: 60 }], 256, 128)
    expect([cols, rows]).toEqual([4, 2])
    expect([...grid]).toEqual([1, 1, 0, 0, 1, 1, 0, 0])
  })

  it('merges into rectangles of at most 1024×256 px', () => {
    const width = 1920
    const height = 1080
    const { grid, cols, rows } = dirtyTileGrid([{ x: 0, y: 0, w: width, h: height }], width, height)
    const regions = mergeTiles(grid, cols, rows, width, height)
    expect(regions.every((region) => region.w <= 1024 && region.h <= 256)).toBe(true)
    expect(regions.reduce((sum, region) => sum + region.w * region.h, 0)).toBe(width * height)
    expect(regions[0]).toEqual({ x: 0, y: 0, w: 1024, h: 256 })
    // Edge tiles are clipped to the screen (1080 = 16 × 64 + 56).
    expect(regions.at(-1)).toEqual({ x: 1024, y: 1024, w: 896, h: 56 })
  })

  it('leaves isolated thin edge tiles small enough to be sent raw', () => {
    const width = 1600
    const height = 900
    const { grid, cols, rows } = dirtyTileGrid([{ x: 394, y: 897, w: 40, h: 3 }], width, height)
    const regions = mergeTiles(grid, cols, rows, width, height)
    expect(regions).toEqual([{ x: 384, y: 896, w: 64, h: 4 }])
    expect(regions[0].w * regions[0].h).toBeLessThanOrEqual(RAW_MAX_PIXELS)
  })
})

describe('mock consent rules', () => {
  const policy = (consent: DesktopPolicy['consent']): DesktopPolicy => ({ enabled: true, refusedBy: null, consent, timeoutSecs: 30, banner: true, viewOnly: false })
  const active = { session_id: 1, kind: 'console' as const, user: 'CORP\\alex', state: 'active' as const, monitors: 2 }

  it('asks a signed-in user on an unlocked session when a user is present', () => {
    expect(consentRequired(policy('when_user_present'), active)).toBe(true)
    expect(consentRequired(policy('when_user_present'), { ...active, state: 'locked' })).toBe(false)
  })

  it('never asks on the sign-in screen, and always asks a signed-in user under "always"', () => {
    expect(consentRequired(policy('always'), { ...active, user: null, state: 'login_screen' })).toBe(false)
    expect(consentRequired(policy('always'), { ...active, state: 'locked' })).toBe(true)
    expect(consentRequired(policy('never'), active)).toBe(false)
  })
})
