import { useState } from 'react'
import { Copy, Download } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { saveBlob } from '@/lib/api/client'
import { copyText } from '@/lib/clipboard'

/** Shows one-time recovery codes with copy/download; reports when the user saved them. */
export function RecoveryCodes({ codes, onSaved }: { codes: string[]; onSaved?: () => void }) {
  const [saved, setSaved] = useState(false)

  function markSaved() {
    if (!saved) {
      setSaved(true)
      onSaved?.()
    }
  }

  async function copyAll() {
    if (await copyText(codes.join('\n'))) {
      toast.success('Recovery codes copied')
      markSaved()
    }
  }

  function downloadAll() {
    const body = [
      'RustRMM recovery codes',
      `Generated ${new Date().toISOString()}`,
      '',
      'Each code works once. Store them somewhere safe and offline.',
      '',
      ...codes,
      '',
    ].join('\n')
    saveBlob(new Blob([body], { type: 'text/plain' }), 'rustrmm-recovery-codes.txt')
    markSaved()
  }

  return (
    <div className="grid gap-3">
      <ol className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg bg-surface-2 p-4 font-mono text-[13px] shadow-raised">
        {codes.map((code, index) => (
          <li key={code} className="flex items-baseline gap-2.5">
            <span className="w-4 text-right text-micro text-subtle-foreground">{index + 1}</span>
            <span className="tracking-wider">{code}</span>
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={copyAll}>
          <Copy data-icon="inline-start" />
          Copy all
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={downloadAll}>
          <Download data-icon="inline-start" />
          Download .txt
        </Button>
      </div>
    </div>
  )
}
