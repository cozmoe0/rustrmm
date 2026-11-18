import type { DeploymentAction, JobTargetInput } from '@/lib/api/types'
import { createStore, useStore } from '@/lib/store'

export interface DeployRequest {
  open: boolean
  /** Preselects the package (the picker stays available). */
  packageId?: string
  action?: DeploymentAction
  /** Preselects the targets, e.g. the current device or the devices running an old version. */
  target?: JobTargetInput
  nonce: number
}

/** The app-wide deploy dialog: the library, the explorer, the device page and the palette open it. */
export const deployDialogStore = createStore<DeployRequest | null>(null)

export function openDeployDialog(request: Omit<DeployRequest, 'nonce' | 'open'> = {}) {
  deployDialogStore.set({ ...request, open: true, nonce: Date.now() })
}

export function closeDeployDialog() {
  deployDialogStore.set((prev) => (prev ? { ...prev, open: false } : prev))
}

export function useDeployRequest() {
  return useStore(deployDialogStore)
}
