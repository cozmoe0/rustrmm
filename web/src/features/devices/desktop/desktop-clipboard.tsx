/* Clipboard panel: the device's clipboard (received) and text to send or type on the device. */
import { useState } from 'react'
import { ArrowDownToLine, ClipboardPaste, Copy, Keyboard, Send } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { copyText } from '@/lib/clipboard'
import { MAX_CLIPBOARD_BYTES, MAX_TYPED_CHARS, checkClipboard, utf8Length } from '@/lib/desktop/control'
import { formatBytes, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { setDesktopPref } from './desktop-access'

interface ClipboardPanelProps {
  disabled: boolean
  disabledReason?: string
  received: { text: string; at: number } | null
  unread: boolean
  autoCopy: boolean
  onOpenChange: (open: boolean) => void
  onSend: (text: string) => boolean
  onType: (text: string) => boolean
  returnFocus?: () => HTMLElement | null
}

export function ClipboardPanel({ disabled, disabledReason, received, unread, autoCopy, onOpenChange, onSend, onType, returnFocus }: ClipboardPanelProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const bytes = utf8Length(draft)
  const check = checkClipboard(draft)
  const tooLarge = !check.ok && check.reason === 'too_large'
  const typedChars = [...draft].length
  const tooLongToType = typedChars > MAX_TYPED_CHARS

  const readLocal = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text) toast.message('Your clipboard is empty')
      setDraft(text)
    } catch {
      toast.message('Clipboard access blocked', { description: 'Paste into the box with Ctrl+V (⌘V on macOS) instead.' })
    }
  }

  const send = () => {
    if (!check.ok) return
    if (onSend(draft)) toast.success('Clipboard sent to the device', { description: `${formatBytes(check.bytes)} · paste it there with Ctrl+V` })
  }

  const type = () => {
    if (!draft || tooLongToType) return
    if (onType(draft)) {
      toast.success('Typing on the device', { description: `${typedChars.toLocaleString()} characters` })
      setOpen(false)
      onOpenChange(false)
    }
  }

  const trigger = (
    <Button variant="ghost" size="icon-sm" aria-label="Clipboard" disabled={disabled} className="relative">
      <ClipboardPaste />
      {unread && !disabled && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-primary ring-2 ring-card" aria-label="New clipboard text from the device" />}
    </Button>
  )

  if (disabled) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" tabIndex={0} aria-label={`Clipboard — ${disabledReason ?? 'unavailable'}`} />}>{trigger}</TooltipTrigger>
        <TooltipContent>{disabledReason ?? 'Clipboard is unavailable'}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        onOpenChange(next)
      }}
    >
      <Tooltip>
        <TooltipTrigger render={<PopoverTrigger render={trigger} />} />
        <TooltipContent>Clipboard</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-1.5rem))] gap-3 p-3" finalFocus={returnFocus ? () => returnFocus() ?? true : undefined}>
        <section className="grid gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="eyebrow">From the device</h3>
            {received && <span className="text-micro text-subtle-foreground">{formatRelative(received.at)}</span>}
          </div>
          {received ? (
            <div className="grid gap-1.5">
              <pre className="max-h-28 overflow-auto rounded-md bg-surface-3 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-foreground/90 ring-1 ring-border">
                {received.text.length > 4000 ? `${received.text.slice(0, 4000)}…` : received.text}
              </pre>
              <div className="flex items-center justify-between gap-2">
                <span className="tabular text-micro text-subtle-foreground">{formatBytes(utf8Length(received.text))}</span>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={async () => {
                    if (await copyText(received.text)) toast.success('Copied to your clipboard')
                    else toast.error('The browser blocked clipboard access')
                  }}
                >
                  <Copy data-icon="inline-start" />
                  Copy to this computer
                </Button>
              </div>
            </div>
          ) : (
            <p className="rounded-md border border-dashed border-border-strong px-3 py-2.5 text-micro text-muted-foreground">
              Text copied on the device shows up here.
            </p>
          )}
          <label className="flex items-center justify-between gap-3 pt-0.5 text-micro text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <ArrowDownToLine className="size-3.5" />
              Copy to this computer automatically
            </span>
            <Switch size="sm" checked={autoCopy} onCheckedChange={(value) => setDesktopPref('autoClipboard', value)} />
          </label>
        </section>

        <div className="h-px bg-border" />

        <section className="grid gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="eyebrow">Send to the device</h3>
            <Button size="xs" variant="ghost" onClick={() => void readLocal()}>
              <ClipboardPaste data-icon="inline-start" />
              Use my clipboard
            </Button>
          </div>
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Paste or type text…"
            aria-label="Text to send to the device"
            className="max-h-40 min-h-20 font-mono text-[12px]"
            aria-invalid={tooLarge || undefined}
          />
          <div className="flex items-center justify-between gap-2">
            <span className={cn('tabular text-micro', tooLarge ? 'text-critical' : 'text-subtle-foreground')}>
              {formatBytes(bytes)} of {formatBytes(MAX_CLIPBOARD_BYTES)}
            </span>
            <div className="flex items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger render={<Button size="xs" variant="outline" disabled={!draft || tooLongToType} onClick={type} />}>
                  <Keyboard data-icon="inline-start" />
                  Type it
                </TooltipTrigger>
                <TooltipContent className="max-w-60">
                  {tooLongToType ? `Typing is limited to ${MAX_TYPED_CHARS.toLocaleString()} characters.` : 'Types the text as keystrokes, for fields that block pasting.'}
                </TooltipContent>
              </Tooltip>
              <Button size="xs" disabled={!check.ok} onClick={send}>
                <Send data-icon="inline-start" />
                Send
              </Button>
            </div>
          </div>
          {tooLarge && <p className="text-micro text-critical">The clipboard is limited to 1 MiB of text.</p>}
          <p className="text-micro text-subtle-foreground">Tip: Ctrl+V in the remote screen sends your clipboard and pastes it.</p>
        </section>
      </PopoverContent>
    </Popover>
  )
}
