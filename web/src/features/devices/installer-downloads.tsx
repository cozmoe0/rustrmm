import { Download, FileKey, ScrollText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { OsIcon } from '@/components/common/os-icon'
import type { InstallerKind } from '@/lib/api/types'
import { cn } from '@/lib/utils'
import { INSTALLERS, useInstallerDownload } from './installers'

export function InstallerIcon({ kind, className }: { kind: InstallerKind; className?: string }) {
  if (kind === 'powershell') return <OsIcon family="windows" className={className} />
  if (kind === 'linux') return <OsIcon family="linux" className={className} />
  if (kind === 'macos') return <OsIcon family="macos" className={className} />
  if (kind === 'gpo') return <ScrollText className={cn('size-3.5 text-muted-foreground', className)} />
  return <FileKey className={cn('size-3.5 text-muted-foreground', className)} />
}

export function InstallerDownloads({ tokenId, className }: { tokenId: string; className?: string }) {
  const { download, isPending } = useInstallerDownload()
  return (
    <div className={cn('grid grid-cols-2 gap-2', className)}>
      {INSTALLERS.map((item) => (
        <Button
          key={item.kind}
          variant="outline"
          className="h-auto justify-start gap-2.5 py-2 text-left"
          disabled={isPending(tokenId, item.kind)}
          onClick={() => void download(tokenId, item.kind)}
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-2 ring-1 ring-border">
            {isPending(tokenId, item.kind) ? <Spinner /> : <InstallerIcon kind={item.kind} />}
          </span>
          <span className="grid min-w-0 leading-tight">
            <span className="truncate text-dense font-medium">{item.label}</span>
            <span className="truncate text-micro font-normal text-muted-foreground">{item.hint}</span>
          </span>
          <Download className="ml-auto size-3.5 shrink-0 text-subtle-foreground" />
        </Button>
      ))}
    </div>
  )
}
