/*
 * Upload progress as a small state machine: the package editor feeds XHR progress events in and
 * renders percentage, throughput and time remaining from the state.
 */
import type { SoftwareFileUpload } from '@/lib/api/types'

/** The server refuses bodies above 4 GiB. */
export const MAX_UPLOAD_BYTES = 4 * 1024 ** 3

export type UploadState =
  | { phase: 'idle' }
  | { phase: 'uploading'; name: string; size: number; loaded: number; startedAt: number; updatedAt: number; rate: number }
  | { phase: 'done'; file: SoftwareFileUpload; durationMs: number }
  | { phase: 'failed'; name: string; error: string }
  | { phase: 'cancelled'; name: string }

export type UploadEvent =
  | { type: 'start'; name: string; size: number; at: number }
  | { type: 'progress'; loaded: number; total: number; at: number }
  | { type: 'done'; file: SoftwareFileUpload; at: number }
  | { type: 'fail'; error: string }
  | { type: 'cancel' }
  | { type: 'reset' }

export const IDLE: UploadState = { phase: 'idle' }

/** Rejects files the server would refuse before any byte is sent; null when acceptable. */
export function uploadProblem(file: Pick<File, 'size' | 'name'>): string | null {
  if (file.size === 0) return 'The file is empty.'
  if (file.size > MAX_UPLOAD_BYTES) return 'Files larger than 4 GiB cannot be uploaded.'
  if (!file.name.trim()) return 'The file has no name.'
  return null
}

/**
 * Applies an event. Progress is clamped to the file size and never goes backwards; the transfer rate is
 * an exponential moving average so the estimate does not jump around.
 */
export function uploadReducer(state: UploadState, event: UploadEvent): UploadState {
  switch (event.type) {
    case 'start':
      return { phase: 'uploading', name: event.name, size: event.size, loaded: 0, startedAt: event.at, updatedAt: event.at, rate: 0 }
    case 'progress': {
      if (state.phase !== 'uploading') return state
      const size = event.total > 0 ? event.total : state.size
      const loaded = Math.min(size, Math.max(state.loaded, event.loaded))
      const elapsed = (event.at - state.updatedAt) / 1000
      const instant = elapsed > 0 ? (loaded - state.loaded) / elapsed : state.rate
      const rate = state.rate === 0 ? instant : state.rate * 0.7 + instant * 0.3
      return { ...state, size, loaded, updatedAt: elapsed > 0 ? event.at : state.updatedAt, rate: Math.max(0, rate) }
    }
    case 'done':
      return { phase: 'done', file: event.file, durationMs: state.phase === 'uploading' ? event.at - state.startedAt : 0 }
    case 'fail':
      return state.phase === 'uploading' ? { phase: 'failed', name: state.name, error: event.error } : state
    case 'cancel':
      return state.phase === 'uploading' ? { phase: 'cancelled', name: state.name } : state
    case 'reset':
      return IDLE
  }
}

/** Whole percent, 0–100 (100 only once every byte is sent). */
export function uploadPct(state: UploadState): number {
  if (state.phase === 'done') return 100
  if (state.phase !== 'uploading' || state.size === 0) return 0
  return Math.min(100, Math.floor((state.loaded / state.size) * 100))
}

/** Seconds left at the current rate; null until there is a rate. */
export function uploadEta(state: UploadState): number | null {
  if (state.phase !== 'uploading' || state.rate <= 0) return null
  return Math.max(0, Math.ceil((state.size - state.loaded) / state.rate))
}

/** "about 12 s left", "about 3 min left". */
export function formatEta(seconds: number | null): string {
  if (seconds === null) return 'Estimating…'
  if (seconds < 5) return 'Almost done'
  if (seconds < 90) return `About ${seconds} s left`
  return `About ${Math.round(seconds / 60)} min left`
}
