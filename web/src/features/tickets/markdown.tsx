/* Safe Markdown display and a small Write/Preview editor with formatting shortcuts. */
import { useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import { Bold, Code, Eye, Italic, Link, List, ListOrdered, PenLine, Quote } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { assignRef } from '@/lib/assign-ref'
import { modKeyLabel } from '@/lib/hotkeys'
import { renderMarkdown } from '@/lib/tickets/markdown'
import { cn } from '@/lib/utils'

/** Renders Markdown through the sanitising pipeline (raw HTML never renders). */
export function Markdown({ source, className, empty }: { source: string; className?: string; empty?: ReactNode }) {
  const html = useMemo(() => renderMarkdown(source), [source])
  if (!source.trim()) return empty ? <div className={cn('text-dense text-subtle-foreground italic', className)}>{empty}</div> : null
  // `html` comes from renderMarkdown, which escapes raw HTML and sanitises the result with DOMPurify.
  return <div className={cn('ticket-markdown', className)} dangerouslySetInnerHTML={{ __html: html }} />
}

type Format = 'bold' | 'italic' | 'code' | 'link' | 'list' | 'ordered' | 'quote'

/** Wraps or prefixes the textarea selection; returns the new value and selection. */
function applyFormat(value: string, start: number, end: number, format: Format): { value: string; start: number; end: number } {
  const selected = value.slice(start, end)
  const wrap = (before: string, after: string, placeholder: string) => {
    const text = selected || placeholder
    const next = value.slice(0, start) + before + text + after + value.slice(end)
    return { value: next, start: start + before.length, end: start + before.length + text.length }
  }
  const prefix = (marker: (index: number) => string) => {
    const lineStart = value.lastIndexOf('\n', start - 1) + 1
    const block = value.slice(lineStart, end) || ''
    const lines = (block || 'Item').split('\n').map((line, index) => marker(index) + line)
    const replaced = lines.join('\n')
    return { value: value.slice(0, lineStart) + replaced + value.slice(end), start: lineStart, end: lineStart + replaced.length }
  }
  switch (format) {
    case 'bold':
      return wrap('**', '**', 'bold text')
    case 'italic':
      return wrap('_', '_', 'emphasis')
    case 'code':
      return selected.includes('\n') ? wrap('```\n', '\n```', 'code') : wrap('`', '`', 'code')
    case 'link':
      return wrap('[', '](https://)', selected || 'link text')
    case 'list':
      return prefix(() => '- ')
    case 'ordered':
      return prefix((index) => `${index + 1}. `)
    case 'quote':
      return prefix(() => '> ')
  }
}

const TOOLS: { format: Format; icon: ReactNode; label: string; keys?: string }[] = [
  { format: 'bold', icon: <Bold />, label: 'Bold', keys: 'B' },
  { format: 'italic', icon: <Italic />, label: 'Italic', keys: 'I' },
  { format: 'code', icon: <Code />, label: 'Code', keys: 'E' },
  { format: 'link', icon: <Link />, label: 'Link', keys: 'K' },
  { format: 'list', icon: <List />, label: 'Bulleted list' },
  { format: 'ordered', icon: <ListOrdered />, label: 'Numbered list' },
  { format: 'quote', icon: <Quote />, label: 'Quote' },
]

export interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  id?: string
  ariaLabel?: string
  ariaInvalid?: boolean
  /** Applied to the text before the preview renders (for example placeholder filling). */
  previewTransform?: (value: string) => string
  onSubmit?: () => void
  /** Extra controls at the right end of the toolbar. */
  toolbar?: ReactNode
  /** Content under the text area (attachments, hints). */
  footer?: ReactNode
  className?: string
  textareaClassName?: string
  textareaRef?: Ref<HTMLTextAreaElement>
  disabled?: boolean
  maxLength?: number
  tone?: 'default' | 'internal'
  onPasteFiles?: (files: File[]) => void
}

export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  id,
  ariaLabel,
  ariaInvalid,
  previewTransform,
  onSubmit,
  toolbar,
  footer,
  className,
  textareaClassName,
  textareaRef,
  disabled,
  maxLength,
  tone = 'default',
  onPasteFiles,
}: MarkdownEditorProps) {
  const [mode, setMode] = useState<'write' | 'preview'>('write')
  const local = useRef<HTMLTextAreaElement | null>(null)
  const setRef = (node: HTMLTextAreaElement | null) => {
    local.current = node
    assignRef(textareaRef, node)
  }

  const format = (kind: Format) => {
    const area = local.current
    if (!area) return
    const result = applyFormat(value, area.selectionStart, area.selectionEnd, kind)
    onChange(result.value)
    requestAnimationFrame(() => {
      area.focus()
      area.setSelectionRange(result.start, result.end)
    })
  }

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col rounded-lg border border-input bg-surface-1 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/40 dark:bg-input/20',
        tone === 'internal' && 'border-warning/40 bg-warning/[0.035] focus-within:border-warning/70 focus-within:ring-warning/25 dark:bg-warning/[0.05]',
        ariaInvalid && 'border-destructive ring-3 ring-destructive/20',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-0.5 border-b border-border px-1.5 py-1">
        <div role="tablist" aria-label="Editor mode" className="mr-1 flex shrink-0 items-center rounded-md bg-surface-3 p-0.5">
          {(['write', 'preview'] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={mode === item}
              onClick={() => setMode(item)}
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded-[4px] px-2 text-micro font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3',
                mode === item && 'bg-surface-1 text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08)] dark:bg-surface-4',
              )}
            >
              {item === 'write' ? <PenLine /> : <Eye />}
              {item === 'write' ? 'Write' : 'Preview'}
            </button>
          ))}
        </div>
        <div className={cn('flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]', mode === 'preview' && 'invisible')}>
          {TOOLS.map((tool) => (
            <Tooltip key={tool.format}>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={disabled}
                    aria-label={tool.label}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => format(tool.format)}
                    className={cn(tool.format === 'list' && 'max-sm:hidden', tool.format === 'ordered' && 'max-sm:hidden', tool.format === 'quote' && 'max-sm:hidden')}
                  />
                }
              >
                {tool.icon}
              </TooltipTrigger>
              <TooltipContent>
                {tool.label}
                {tool.keys && <span className="ml-1.5 text-muted-foreground">{modKeyLabel}+{tool.keys}</span>}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
        {toolbar && <div className="ml-auto flex shrink-0 items-center gap-1">{toolbar}</div>}
      </div>
      {mode === 'write' ? (
        <textarea
          ref={setRef}
          id={id}
          value={value}
          disabled={disabled}
          maxLength={maxLength}
          aria-label={ariaLabel}
          aria-invalid={ariaInvalid || undefined}
          placeholder={placeholder}
          spellCheck
          onChange={(event) => onChange(event.target.value)}
          onPaste={(event) => {
            const files = [...event.clipboardData.files]
            if (files.length && onPasteFiles) {
              event.preventDefault()
              onPasteFiles(files)
            }
          }}
          onKeyDown={(event) => {
            const mod = event.metaKey || event.ctrlKey
            if (mod && event.key === 'Enter' && onSubmit) {
              event.preventDefault()
              onSubmit()
              return
            }
            if (mod && !event.shiftKey && !event.altKey) {
              const map: Record<string, Format> = { b: 'bold', i: 'italic', e: 'code', k: 'link' }
              const kind = map[event.key.toLowerCase()]
              if (kind) {
                event.preventDefault()
                format(kind)
              }
            }
            if (event.key === 'Escape') (event.target as HTMLTextAreaElement).blur()
          }}
          className={cn(
            'min-h-28 w-full resize-y bg-transparent px-3 py-2.5 text-sm leading-relaxed outline-none placeholder:text-subtle-foreground disabled:cursor-not-allowed disabled:opacity-60',
            textareaClassName,
          )}
        />
      ) : (
        <div className={cn('min-h-28 overflow-auto px-3 py-2.5', textareaClassName)} aria-live="polite">
          <Markdown source={previewTransform ? previewTransform(value) : value} empty="Nothing to preview yet." />
        </div>
      )}
      {footer}
    </div>
  )
}
