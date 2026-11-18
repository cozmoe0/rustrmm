import { describe, expect, it } from 'vitest'
import { IDLE, formatEta, uploadEta, uploadPct, uploadProblem, uploadReducer, type UploadState } from './upload'

const file = { file_id: 'f1', sha256: 'ab'.repeat(32), size_bytes: 1000, file_name: 'setup.msi' }

function run(events: Parameters<typeof uploadReducer>[1][]): UploadState {
  return events.reduce(uploadReducer, IDLE)
}

describe('upload progress state', () => {
  it('moves from idle through uploading to done', () => {
    const started = run([{ type: 'start', name: 'setup.msi', size: 1000, at: 0 }])
    expect(started).toMatchObject({ phase: 'uploading', loaded: 0, rate: 0 })
    expect(uploadPct(started)).toBe(0)
    const half = uploadReducer(started, { type: 'progress', loaded: 500, total: 1000, at: 1000 })
    expect(uploadPct(half)).toBe(50)
    expect(half).toMatchObject({ rate: 500 })
    expect(uploadEta(half)).toBe(1)
    const done = uploadReducer(half, { type: 'done', file, at: 2500 })
    expect(done).toEqual({ phase: 'done', file, durationMs: 2500 })
    expect(uploadPct(done)).toBe(100)
  })

  it('never goes backwards, clamps to the size and smooths the rate', () => {
    let state = run([{ type: 'start', name: 'a', size: 1000, at: 0 }, { type: 'progress', loaded: 400, total: 1000, at: 1000 }])
    state = uploadReducer(state, { type: 'progress', loaded: 300, total: 1000, at: 2000 })
    expect(state).toMatchObject({ loaded: 400 })
    state = uploadReducer(state, { type: 'progress', loaded: 5000, total: 1000, at: 3000 })
    expect(state).toMatchObject({ loaded: 1000 })
    expect(uploadPct(state)).toBe(100)
    if (state.phase !== 'uploading') throw new Error('expected uploading')
    // 400 B/s, then 0 B/s, then 600 B/s, blended 70/30.
    expect(state.rate).toBeCloseTo(400 * 0.7 * 0.7 + 600 * 0.3, 5)
  })

  it('records failures and cancellations only while uploading', () => {
    const uploading = run([{ type: 'start', name: 'big.iso', size: 10, at: 0 }])
    expect(uploadReducer(uploading, { type: 'fail', error: 'Network error' })).toEqual({ phase: 'failed', name: 'big.iso', error: 'Network error' })
    expect(uploadReducer(uploading, { type: 'cancel' })).toEqual({ phase: 'cancelled', name: 'big.iso' })
    expect(uploadReducer(IDLE, { type: 'cancel' })).toBe(IDLE)
    expect(uploadReducer(IDLE, { type: 'progress', loaded: 1, total: 1, at: 1 })).toBe(IDLE)
    expect(uploadReducer(uploading, { type: 'reset' })).toBe(IDLE)
  })

  it('refuses files the server would reject and formats the time left', () => {
    expect(uploadProblem({ name: 'empty.msi', size: 0 })).toMatch(/empty/)
    expect(uploadProblem({ name: 'huge.iso', size: 5 * 1024 ** 3 })).toMatch(/4 GiB/)
    expect(uploadProblem({ name: 'ok.msi', size: 10 })).toBeNull()
    expect(formatEta(null)).toBe('Estimating…')
    expect(formatEta(3)).toBe('Almost done')
    expect(formatEta(42)).toBe('About 42 s left')
    expect(formatEta(600)).toBe('About 10 min left')
  })
})
