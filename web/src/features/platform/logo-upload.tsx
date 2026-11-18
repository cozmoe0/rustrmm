/* Upload a PNG or SVG logo (≤ 512 KB) to the branding file store, with a preview and the sanitiser notice. */
import { useId, useRef, useState } from 'react'
import { ImageUp, ShieldCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { brandingApi } from '@/lib/api/endpoints'
import { errorMessage } from '@/lib/api/errors'
import type { BrandingFile } from '@/lib/api/types'
import { logoFileError } from '@/lib/branding'
import { cn } from '@/lib/utils'

export function LogoUpload({
  label,
  hint,
  url,
  surface = 'light',
  disabled,
  onUploaded,
  onRemove,
}: {
  label: string
  hint?: string
  url: string | null
  surface?: 'light' | 'dark'
  disabled?: boolean
  onUploaded: (file: BrandingFile) => void
  onRemove?: () => void
}) {
  const inputId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sanitized, setSanitized] = useState(false)

  async function upload(file: File) {
    const problem = logoFileError(file)
    setError(problem)
    setSanitized(false)
    if (problem) return
    setProgress(0)
    try {
      const result = await brandingApi.upload(file, { onProgress: (loaded, total) => setProgress(total ? Math.round((loaded / total) * 100) : 0) })
      setSanitized(result.sanitized)
      onUploaded(result)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setProgress(null)
      if (input.current) input.current.value = ''
    }
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={inputId} className="text-dense font-medium">
          {label}
        </label>
        {hint && <span className="text-micro text-subtle-foreground">{hint}</span>}
      </div>
      <div
        onDragOver={(event) => {
          if (disabled) return
          event.preventDefault()
        }}
        onDrop={(event) => {
          if (disabled) return
          event.preventDefault()
          const file = event.dataTransfer.files[0]
          if (file) void upload(file)
        }}
        className={cn('flex min-w-0 items-center gap-3 rounded-xl border border-dashed border-border-strong p-3', disabled && 'opacity-60')}
      >
        <div className={cn('flex h-14 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg ring-1', surface === 'dark' ? 'bg-[#15181d] ring-white/10' : 'bg-white ring-black/10')}>
          {url ? <img src={url} alt={`${label} preview`} className="max-h-10 max-w-20 object-contain" /> : <ImageUp className={cn('size-5', surface === 'dark' ? 'text-white/40' : 'text-black/30')} />}
        </div>
        <div className="grid min-w-0 flex-1 gap-1.5">
          {progress !== null ? (
            <Progress value={progress} aria-label="Upload progress" />
          ) : (
            <p className="text-micro text-muted-foreground">PNG (up to 4096×4096) or SVG, at most 512 KB. Drop a file here or choose one.</p>
          )}
          <div className="flex flex-wrap gap-1.5">
            <input ref={input} id={inputId} type="file" accept=".png,.svg,image/png,image/svg+xml" className="sr-only" disabled={disabled || progress !== null} onChange={(event) => event.target.files?.[0] && void upload(event.target.files[0])} />
            <Button type="button" size="xs" variant="outline" disabled={disabled || progress !== null} onClick={() => input.current?.click()}>
              <ImageUp data-icon="inline-start" />
              {url ? 'Replace' : 'Upload'}
            </Button>
            {url && onRemove && (
              <Button type="button" size="xs" variant="ghost" className="hover:text-critical" disabled={disabled} onClick={onRemove}>
                <Trash2 data-icon="inline-start" />
                Remove
              </Button>
            )}
          </div>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-dense text-critical">
          {error}
        </p>
      )}
      {sanitized && (
        <p className="flex items-start gap-1.5 text-micro text-info">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
          The SVG contained scripts, styles, links or external references; they were removed for safety. Check that it still looks right.
        </p>
      )}
    </div>
  )
}
