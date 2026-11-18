import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { copyText } from '@/lib/clipboard'
import { cn } from '@/lib/utils'

export function CopyButton({
  value,
  label = 'Copy',
  className,
  onCopied,
}: {
  value: string
  label?: string
  className?: string
  onCopied?: () => void
}) {
  const [copied, setCopied] = useState(false)

  async function onClick() {
    if (await copyText(value)) {
      setCopied(true)
      onCopied?.()
      window.setTimeout(() => setCopied(false), 1500)
    } else {
      toast.error('Clipboard access was blocked by the browser.')
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            className={cn('text-muted-foreground', className)}
            onClick={onClick}
          />
        }
      >
        {copied ? <Check className="text-success" /> : <Copy />}
      </TooltipTrigger>
      <TooltipContent>{copied ? 'Copied' : label}</TooltipContent>
    </Tooltip>
  )
}
