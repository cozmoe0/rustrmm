/* Toolbar controls for the remote desktop viewer. */
import type { ReactNode } from 'react'

/** Where focus goes when a toolbar menu closes (the remote screen while controlling). */
export type ReturnFocus = () => HTMLElement | null

const finalFocus = (returnFocus?: ReturnFocus) => (returnFocus ? () => returnFocus() ?? true : undefined)
import { Check, ChevronDown, Gauge, Keyboard, Monitor } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { DesktopQuality, MonitorInfo } from '@/lib/desktop/control'
import { SPECIAL_KEYS, type SpecialKey } from '@/lib/desktop/input'
import { formatResolution, monitorMiniature } from '@/lib/desktop/viewport'
import { cn } from '@/lib/utils'
import { IS_MAC_CLIENT, QUALITY_OPTIONS } from './desktop-access'

export function ToolbarButton({
  label,
  onClick,
  disabled,
  pressed,
  children,
  className,
  shortcut,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  pressed?: boolean
  children: ReactNode
  className?: string
  shortcut?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onClick}
            className={cn(pressed && 'bg-surface-3 text-foreground', className)}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <span className="ml-1.5 text-subtle-foreground">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

export function ToolbarDivider({ className }: { className?: string }) {
  return <span className={cn('mx-0.5 h-5 w-px shrink-0 bg-border', className)} aria-hidden="true" />
}

function Miniature({ monitors, active, pending, onPick }: { monitors: MonitorInfo[]; active: number | null; pending: number | null; onPick?: (id: number) => void }) {
  const box = { width: 232, height: 84 }
  const tiles = monitorMiniature(monitors, box, 4)
  return (
    <div className="relative mx-1 mt-1 mb-2 rounded-md bg-surface-3/70 ring-1 ring-border" style={{ height: box.height + 12 }}>
      <div className="absolute inset-1.5" style={{ width: box.width, height: box.height }}>
        {tiles.map((tile) => {
          const monitor = monitors.find((item) => item.id === tile.id)!
          const selected = tile.id === (pending ?? active)
          return (
            <button
              type="button"
              key={tile.id}
              onClick={() => onPick?.(tile.id)}
              className={cn(
                'absolute flex items-center justify-center rounded-[3px] text-[10px] font-semibold ring-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected ? 'bg-primary/18 text-primary ring-primary/60' : 'bg-card text-muted-foreground ring-border-strong hover:bg-surface-4',
              )}
              style={{ left: tile.left, top: tile.top, width: tile.width, height: tile.height }}
              aria-label={`${monitor.name}${monitor.primary ? ' (primary)' : ''}`}
            >
              {tile.id + 1}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function MonitorPicker({
  monitors,
  active,
  pending,
  onPick,
  disabled,
  returnFocus,
}: {
  monitors: MonitorInfo[]
  active: number | null
  pending: number | null
  onPick: (id: number) => void
  disabled?: boolean
  returnFocus?: ReturnFocus
}) {
  const current = monitors.find((monitor) => monitor.id === active)
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="sm" disabled={disabled || monitors.length < 2} aria-label="Monitor" className="gap-1 px-2">
                  <Monitor />
                  <span className="tabular hidden text-micro font-semibold md:inline">
                    {active !== null ? active + 1 : '–'}/{monitors.length}
                  </span>
                  <ChevronDown className="size-3 text-subtle-foreground" />
                </Button>
              }
            />
          }
        />
        <TooltipContent>{monitors.length < 2 ? 'One monitor' : `Monitor: ${current?.name ?? '—'}`}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-64" finalFocus={finalFocus(returnFocus)}>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Monitors</DropdownMenuLabel>
          <Miniature monitors={monitors} active={active} pending={pending} onPick={onPick} />
          {monitors.map((monitor) => (
            <DropdownMenuItem key={monitor.id} onClick={() => onPick(monitor.id)} className="gap-2.5">
              <span
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-[4px] text-[10px] font-semibold ring-1',
                  monitor.id === active ? 'bg-primary/15 text-primary ring-primary/40' : 'bg-surface-3 text-muted-foreground ring-border',
                )}
              >
                {monitor.id + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{monitor.name}</span>
                <span className="tabular block text-micro text-subtle-foreground">
                  {formatResolution(monitor)}
                  {monitor.scale !== 1 ? ` · ${Math.round(monitor.scale * 100)}%` : ''}
                  {monitor.primary ? ' · primary' : ''}
                </span>
              </span>
              {monitor.id === (pending ?? active) && <Check className="size-4 text-primary" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function QualityMenu({ value, onChange, disabled, returnFocus }: { value: DesktopQuality; onChange: (value: DesktopQuality) => void; disabled?: boolean; returnFocus?: ReturnFocus }) {
  const current = QUALITY_OPTIONS.find((option) => option.value === value) ?? QUALITY_OPTIONS[0]
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="sm" disabled={disabled} aria-label={`Quality: ${current.label}`} className="gap-1 px-2">
                  <Gauge />
                  <span className="hidden text-micro font-semibold lg:inline">{current.label}</span>
                  <ChevronDown className="size-3 text-subtle-foreground" />
                </Button>
              }
            />
          }
        />
        <TooltipContent>Picture quality</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-56" finalFocus={finalFocus(returnFocus)}>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Picture quality</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as DesktopQuality)}>
            {QUALITY_OPTIONS.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                <span className="min-w-0">
                  <span className="block">{option.label}</span>
                  <span className="block text-micro text-subtle-foreground">{option.description}</span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const KEY_ORDER: SpecialKey[] = ['win', 'alt-tab', 'ctrl-esc', 'print-screen', 'ctrl-shift-esc', 'win-r', 'win-e', 'win-l']

export function KeysMenu({
  disabled,
  onCad,
  onSpecial,
  mapMetaToCtrl,
  onMapMetaToCtrl,
  windows,
  returnFocus,
}: {
  disabled?: boolean
  onCad: () => void
  onSpecial: (key: SpecialKey) => void
  mapMetaToCtrl: boolean
  onMapMetaToCtrl: (value: boolean) => void
  windows: boolean
  returnFocus?: ReturnFocus
}) {
  const keys = windows ? KEY_ORDER : (['win', 'alt-tab', 'print-screen'] as SpecialKey[])
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="sm" disabled={disabled} aria-label="Special keys" className="gap-1 px-2">
                  <Keyboard />
                  <ChevronDown className="size-3 text-subtle-foreground" />
                </Button>
              }
            />
          }
        />
        <TooltipContent>Ctrl+Alt+Del and special keys</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-64" finalFocus={finalFocus(returnFocus)}>
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={onCad} className="gap-2.5 py-2">
            <span className="min-w-0 flex-1">
              <span className="block font-medium">Ctrl+Alt+Del</span>
              <span className="block text-micro text-subtle-foreground">{windows ? 'Security screen · sign in · unlock' : 'Sent as key presses'}</span>
            </span>
            <KbdGroup>
              <Kbd>Ctrl</Kbd>
              <Kbd>Alt</Kbd>
              <Kbd>Del</Kbd>
            </KbdGroup>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Send keys</DropdownMenuLabel>
          {keys.map((key) => {
            const definition = SPECIAL_KEYS[key]
            return (
              <DropdownMenuItem key={key} onClick={() => onSpecial(key)} className="gap-2.5">
                <span className="min-w-0 flex-1 truncate">{definition.label}</span>
                <KbdGroup>
                  {definition.keys.map((cap) => (
                    <Kbd key={cap}>{cap}</Kbd>
                  ))}
                </KbdGroup>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
        {IS_MAC_CLIENT && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuCheckboxItem checked={mapMetaToCtrl} onCheckedChange={(value) => onMapMetaToCtrl(Boolean(value))}>
                Send ⌘ as Ctrl
              </DropdownMenuCheckboxItem>
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
