import type { SVGProps } from 'react'
import { Command } from 'lucide-react'
import type { OsFamily } from '@/lib/api/types'
import { cn } from '@/lib/utils'

function WindowsGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" {...props}>
      <path fill="currentColor" d="M1.5 2.9 6.9 2.2v5.2H1.5zM7.9 2.05 14.5 1.2v6.2H7.9zM1.5 8.4h5.4v5.3l-5.4-.7zM7.9 8.4h6.6v6.4l-6.6-.9z" />
    </svg>
  )
}

function MacGlyph(props: SVGProps<SVGSVGElement>) {
  // The command-key mark rather than any vendor logo.
  return <Command strokeWidth={2.2} {...(props as object)} />
}

function LinuxGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" {...props}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M8 1.2c-1.9 0-3 1.5-3 3.4 0 .9.2 1.6-.4 2.6C3.8 8.5 3 9.9 3 11.4c0 1.1.4 2 1 2.6-.6.3-1.1.6-1 1 .1.5 1.4.6 2.6.4.7-.1 1.4-.4 2.4-.4s1.7.3 2.4.4c1.2.2 2.5.1 2.6-.4.1-.4-.4-.7-1-1 .6-.6 1-1.5 1-2.6 0-1.5-.8-2.9-1.6-4.2-.6-1-.4-1.7-.4-2.6 0-1.9-1.1-3.4-3-3.4Zm0 6.3c-1.5 0-2.6 1.6-2.6 3.6S6.5 14 8 14s2.6-.9 2.6-2.9-1.1-3.6-2.6-3.6ZM6.9 4.3a.55.55 0 1 0 0 1.1.55.55 0 0 0 0-1.1Zm2.2 0a.55.55 0 1 0 0 1.1.55.55 0 0 0 0-1.1Z"
      />
    </svg>
  )
}

const OS_TONE: Record<OsFamily, string> = {
  windows: 'text-info',
  macos: 'text-foreground/80',
  linux: 'text-warning',
}

export function OsIcon({ family, className }: { family: OsFamily; className?: string }) {
  const Glyph = family === 'windows' ? WindowsGlyph : family === 'macos' ? MacGlyph : LinuxGlyph
  return <Glyph className={cn('size-3.5 shrink-0', OS_TONE[family], className)} />
}

