import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/common/misc'
import { modKeyLabel } from '@/lib/hotkeys'
import { shortcutsStore, useShortcutsOpen } from './ui-state'

const GROUPS: { title: string; items: { keys: string[]; label: string }[] }[] = [
  {
    title: 'General',
    items: [
      { keys: [modKeyLabel, 'K'], label: 'Open command palette' },
      { keys: ['?'], label: 'Show keyboard shortcuts' },
      { keys: ['/'], label: 'Focus the page filter' },
      { keys: [modKeyLabel, '1–9'], label: 'Jump to workspace tab' },
    ],
  },
  {
    title: 'Go to',
    items: [
      { keys: ['g', 'h'], label: 'Home' },
      { keys: ['g', 'c'], label: 'Clients' },
      { keys: ['g', 'd'], label: 'Devices' },
      { keys: ['g', 'a'], label: 'Alerts' },
      { keys: ['g', 'u'], label: 'Automation' },
      { keys: ['g', 'p'], label: 'Patching' },
      { keys: ['g', 'w'], label: 'Software' },
      { keys: ['g', 't'], label: 'Tickets' },
      { keys: ['g', 'n'], label: 'Network' },
      { keys: ['g', 'k'], label: 'Secrets' },
      { keys: ['g', 's'], label: 'Settings' },
    ],
  },
  {
    title: 'Lists',
    items: [
      { keys: ['j', 'k'], label: 'Move between rows' },
      { keys: ['Enter'], label: 'Open the focused row' },
      { keys: ['Space'], label: 'Quick-look in the inspector' },
    ],
  },
  {
    title: 'Alerts inbox',
    items: [
      { keys: ['j', 'k'], label: 'Next / previous alert' },
      { keys: ['x'], label: 'Select for bulk actions' },
      { keys: ['a'], label: 'Acknowledge' },
      { keys: ['r'], label: 'Resolve with a note' },
      { keys: ['s'], label: 'Snooze' },
      { keys: ['Esc'], label: 'Clear selection' },
    ],
  },
  {
    title: 'Ticket queue',
    items: [
      { keys: ['j', 'k'], label: 'Next / previous ticket' },
      { keys: ['Enter'], label: 'Open the full ticket page' },
      { keys: ['x'], label: 'Select for bulk actions' },
      { keys: ['a'], label: 'Assign to me' },
      { keys: ['e'], label: 'Mark resolved' },
      { keys: ['r'], label: 'Reply' },
      { keys: ['c'], label: 'New ticket' },
      { keys: [modKeyLabel, 'Enter'], label: 'Send the reply' },
    ],
  },
]

export function ShortcutsDialog() {
  const open = useShortcutsOpen()
  return (
    <Dialog open={open} onOpenChange={(next) => shortcutsStore.set(next)}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>RustRMM is built to be driven from the keyboard.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 sm:grid-cols-2">
          {GROUPS.map((group) => (
            <section key={group.title} className={group.title === 'General' ? 'sm:col-span-2' : undefined}>
              <h3 className="eyebrow mb-2">{group.title}</h3>
              <ul className="grid gap-1.5">
                {group.items.map((item) => (
                  <li key={item.label} className="flex items-center justify-between gap-4 text-dense">
                    <span className="text-muted-foreground">{item.label}</span>
                    <span className="flex items-center gap-1">
                      {item.keys.map((key, index) => (
                        <Kbd key={`${key}-${index}`}>{key}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
