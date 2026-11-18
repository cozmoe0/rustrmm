import { useState } from 'react'
import { toast } from 'sonner'
import { enrollmentApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import type { InstallerKind } from '@/lib/api/types'

export const INSTALLERS: { kind: InstallerKind; label: string; hint: string }[] = [
  { kind: 'powershell', label: 'Windows', hint: 'PowerShell script' },
  { kind: 'linux', label: 'Linux', hint: 'Shell script' },
  { kind: 'macos', label: 'macOS', hint: 'Shell script' },
  { kind: 'gpo', label: 'Group Policy', hint: 'Startup script' },
  { kind: 'deploy-key', label: 'deploy.key', hint: 'Sidecar for the MSI' },
]

/** Downloads an installer for a deploy key and tracks which one is in flight. */
export function useInstallerDownload() {
  const [pending, setPending] = useState<string | null>(null)
  async function download(tokenId: string, kind: InstallerKind) {
    setPending(`${tokenId}:${kind}`)
    try {
      await enrollmentApi.installer(tokenId, kind)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setPending(null)
    }
  }
  return { download, isPending: (tokenId: string, kind: InstallerKind) => pending === `${tokenId}:${kind}` }
}
