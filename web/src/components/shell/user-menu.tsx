import { useNavigate } from '@tanstack/react-router'
import { Keyboard, LogOut, Rows2, Rows3, ShieldCheck } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { UserAvatar } from '@/components/common/misc'
import { useMe } from '@/lib/permissions'
import { useDensity } from '@/lib/theme'
import { useSignOut } from '@/lib/use-sign-out'
import { shortcutsStore } from './ui-state'

export function UserMenu({ side = 'right' }: { side?: 'right' | 'bottom' }) {
  const me = useMe()
  const navigate = useNavigate()
  const signOut = useSignOut()
  const { density, toggle: toggleDensity } = useDensity()

  if (!me) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Account menu"
            className="mt-1 flex size-10 items-center justify-center rounded-lg outline-none hover:bg-rail-hover focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <UserAvatar name={me.user.name} size="sm" className="bg-primary/20 text-primary ring-primary/30" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align="end" sideOffset={10} className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center gap-3 py-2">
            <UserAvatar name={me.user.name} />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-foreground">{me.user.name}</div>
              <div className="truncate text-micro text-muted-foreground">{me.user.email}</div>
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => void navigate({ to: '/settings/security' })}>
            <ShieldCheck />
            Security &amp; sign-in
          </DropdownMenuItem>
          <DropdownMenuItem onClick={toggleDensity}>
            {density === 'compact' ? <Rows2 /> : <Rows3 />}
            {density === 'compact' ? 'Comfortable density' : 'Compact density'}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => shortcutsStore.set(true)}>
            <Keyboard />
            Keyboard shortcuts
            <DropdownMenuShortcut>?</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => void signOut()}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
