import type { JobTargetInput } from '@/lib/api/types'
import { createStore, useStore } from '@/lib/store'

export interface RunRequest {
  open: boolean
  /** Preselects (and locks) the script. */
  scriptId?: string
  /** Preselects the targets, e.g. the current device or a bulk selection. */
  target?: JobTargetInput
  nonce: number
}

/** The app-wide run dialog: the script page, the device page, bulk selection and the palette all open it. */
export const runDialogStore = createStore<RunRequest | null>(null)

export function openRunDialog(request: Omit<RunRequest, 'nonce' | 'open'> = {}) {
  runDialogStore.set({ ...request, open: true, nonce: Date.now() })
}

/** Closes the dialog but keeps its request so the closing animation still has content. */
export function closeRunDialog() {
  runDialogStore.set((prev) => (prev ? { ...prev, open: false } : prev))
}

export function useRunRequest() {
  return useStore(runDialogStore)
}
