/* Remote file browser: listing, upload queue, download, new folder, rename and delete. */
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef, SortingState } from '@tanstack/react-table'
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  Copy,
  Download,
  Ellipsis,
  File,
  FileSymlink,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSymlink,
  HardDrive,
  House,
  Pencil,
  RefreshCw,
  RotateCcw,
  Trash,
  Upload,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { copyText } from '@/lib/clipboard'
import { remoteApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { keys } from '@/lib/api/queries'
import type { DeviceDetail, FileEntry, FileListing } from '@/lib/api/types'
import { deviceName } from '@/lib/devices'
import { formatBytes, formatDateTime, formatNumber, formatRate, formatRelative } from '@/lib/format'
import {
  baseName,
  isAbsolutePath,
  joinPath,
  normalizePath,
  parentPath,
  pathSegments,
  pathStyle,
  validateFileName,
  type PathStyle,
} from '@/lib/remote'
import { createStore, useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { toastRemoteError, useDeviceGoneHandler } from './remote-hooks'
import { InlineAlert, QueryError, SearchField } from './remote-ui'
import { uploadQueueFor, useUploadItems, type UploadItem, type UploadQueue } from './upload-queue'

const showHiddenStore = createStore(false, { key: 'rustrmm.files.hidden' })
const IS_MOCK = import.meta.env.VITE_MOCK === '1'

function compareEntries(a: FileEntry, b: FileEntry, sorting: SortingState): number {
  // Folders always come first, whichever way the column is sorted.
  if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
  const sort = sorting[0] ?? { id: 'name', desc: false }
  const byName = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  let result: number
  switch (sort.id) {
    case 'size':
      result = (a.size ?? -1) - (b.size ?? -1)
      break
    case 'modified':
      result = (a.modified ?? 0) - (b.modified ?? 0)
      break
    case 'attributes':
      result = attributes(a).join().localeCompare(attributes(b).join())
      break
    default:
      result = byName
  }
  if (result === 0) result = byName
  return sort.desc ? -result : result
}

function attributes(entry: FileEntry): string[] {
  const list: string[] = []
  if (entry.drive) list.push('drive')
  if (entry.is_link) list.push('link')
  if (entry.readonly) list.push('read-only')
  if (entry.hidden) list.push('hidden')
  return list
}

function EntryIcon({ entry }: { entry: FileEntry }) {
  if (entry.drive) return <HardDrive className="size-4 shrink-0 text-muted-foreground" />
  if (entry.is_dir) {
    return entry.is_link ? <FolderSymlink className="size-4 shrink-0 text-primary/80" /> : <Folder className="size-4 shrink-0 fill-primary/15 text-primary/80" />
  }
  return entry.is_link ? <FileSymlink className="size-4 shrink-0 text-subtle-foreground" /> : <File className="size-4 shrink-0 text-subtle-foreground" />
}

function quickPlaces(device: DeviceDetail, style: PathStyle): { label: string; path: string }[] {
  const user = device.last_user?.split('\\').pop()?.split('@')[0]
  if (style === 'windows') {
    const home = user ? `C:\\Users\\${user}` : null
    return [
      ...(home
        ? [
            { label: 'Desktop', path: `${home}\\Desktop` },
            { label: 'Documents', path: `${home}\\Documents` },
            { label: 'Downloads', path: `${home}\\Downloads` },
          ]
        : []),
      { label: 'Users', path: 'C:\\Users' },
      { label: 'Program Files', path: 'C:\\Program Files' },
      { label: 'ProgramData', path: 'C:\\ProgramData' },
      { label: 'Windows Temp', path: 'C:\\Windows\\Temp' },
    ]
  }
  const home = device.os_family === 'macos' ? (user ? `/Users/${user}` : '/Users') : '/home'
  return [
    { label: device.os_family === 'macos' ? 'Home' : 'Home folders', path: home },
    ...(device.os_family === 'macos' && user ? [{ label: 'Downloads', path: `${home}/Downloads` }] : []),
    { label: 'Logs', path: '/var/log' },
    { label: 'Configuration', path: '/etc' },
    { label: 'Temporary files', path: '/tmp' },
  ]
}

function downloadEntry(deviceId: string, entry: FileEntry) {
  if (IS_MOCK) {
    // The mock service worker can't answer browser navigations, so fetch the file instead.
    void remoteApi.downloadBlob(deviceId, entry.path, entry.name).catch((error: unknown) => toastRemoteError(error, `Couldn’t download ${entry.name}`))
    return
  }
  const anchor = document.createElement('a')
  anchor.href = remoteApi.downloadUrl(deviceId, entry.path)
  anchor.download = entry.name
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

// ------------------------------------------------------------------ path bar

function PathBar({
  style,
  path,
  onNavigate,
}: {
  style: PathStyle
  path: string
  onNavigate: (path: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(path)
  const [error, setError] = useState<string | null>(null)
  const segments = pathSegments(style, path)

  function begin() {
    setDraft(path)
    setError(null)
    setEditing(true)
  }

  function commit() {
    const next = normalizePath(style, draft)
    if (next && !isAbsolutePath(style, next)) {
      setError(style === 'windows' ? 'Enter a full path, like C:\\Users' : 'Enter a full path, like /var/log')
      return
    }
    setEditing(false)
    if (next !== path) onNavigate(next)
  }

  if (editing) {
    return (
      <div className="relative min-w-0 flex-1">
        <Input
          autoFocus
          value={draft}
          spellCheck={false}
          aria-label="Path"
          aria-invalid={Boolean(error) || undefined}
          className="h-8 font-mono text-[12.5px]"
          placeholder={style === 'windows' ? 'C:\\Users\\Public' : '/var/log'}
          onChange={(event) => {
            setDraft(event.target.value)
            setError(null)
          }}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={() => !error && setEditing(false)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') {
              event.stopPropagation()
              setEditing(false)
            }
          }}
        />
        {error && <p className="absolute top-full left-0 z-10 mt-1 rounded-md bg-popover px-2 py-1 text-micro text-critical shadow-popover">{error}</p>}
      </div>
    )
  }

  return (
    <div
      className="group/path flex h-8 min-w-0 flex-1 cursor-text items-center rounded-lg border border-input bg-surface-1 pr-1 pl-1 dark:bg-black/25"
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest('button')) begin()
      }}
    >
      <nav aria-label="Current folder" className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none]">
        <ol className="flex min-w-max items-center">
          {style === 'windows' && (
            <li className="flex items-center">
              <button
                type="button"
                onClick={() => onNavigate('')}
                className={cn('flex h-6 items-center gap-1 rounded-md px-1.5 text-dense hover:bg-surface-3', !path && 'font-medium text-foreground')}
              >
                <HardDrive className="size-3.5 text-subtle-foreground" />
                Drives
              </button>
              {segments.length > 0 && <ChevronRight className="size-3.5 text-subtle-foreground" />}
            </li>
          )}
          {segments.map((segment, index) => (
            <li key={segment.path} className="flex items-center">
              <button
                type="button"
                onClick={() => onNavigate(segment.path)}
                aria-current={index === segments.length - 1 ? 'location' : undefined}
                className={cn(
                  'h-6 max-w-48 truncate rounded-md px-1.5 font-mono text-[12px] hover:bg-surface-3',
                  index === segments.length - 1 ? 'font-medium text-foreground' : 'text-muted-foreground',
                )}
              >
                {segment.label}
              </button>
              {index < segments.length - 1 && segment.label !== '/' && <ChevronRight className="size-3.5 text-subtle-foreground" />}
            </li>
          ))}
        </ol>
      </nav>
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Edit path" onClick={begin} className="opacity-60 group-hover/path:opacity-100" />}>
          <Pencil />
        </TooltipTrigger>
        <TooltipContent>Type a path</TooltipContent>
      </Tooltip>
    </div>
  )
}

// ------------------------------------------------------------------ dialogs

function NameDialog({
  open,
  onOpenChange,
  title,
  description,
  initial,
  submitLabel,
  style,
  pending,
  error,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  initial: string
  submitLabel: string
  style: PathStyle
  pending: boolean
  error: unknown
  onSubmit: (name: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {open && (
          <NameForm initial={initial} submitLabel={submitLabel} style={style} pending={pending} error={error} onSubmit={onSubmit} onCancel={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function NameForm({
  initial,
  submitLabel,
  style,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initial: string
  submitLabel: string
  style: PathStyle
  pending: boolean
  error: unknown
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial)
  const [touched, setTouched] = useState(false)
  const invalid = validateFileName(style, name)
  const unchanged = initial !== '' && name.trim() === initial
  return (
    <>
      <form
        id="file-name-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          setTouched(true)
          if (!invalid && !unchanged) onSubmit(name.trim())
        }}
      >
        <Field data-invalid={(touched && Boolean(invalid)) || undefined}>
          <FieldLabel htmlFor="file-name">Name</FieldLabel>
          <Input
            id="file-name"
            autoFocus
            spellCheck={false}
            value={name}
            aria-invalid={(touched && Boolean(invalid)) || undefined}
            onChange={(event) => setName(event.target.value)}
            onFocus={(event) => {
              // Select the name without its extension, like a desktop file manager.
              const dot = event.currentTarget.value.lastIndexOf('.')
              event.currentTarget.setSelectionRange(0, dot > 0 ? dot : event.currentTarget.value.length)
            }}
          />
          {touched && invalid ? <FieldError>{invalid}</FieldError> : <FieldDescription>{style === 'windows' ? 'Names are not case-sensitive on Windows.' : 'Names are case-sensitive.'}</FieldDescription>}
        </Field>
        {Boolean(error) && (
          <InlineAlert className="mt-3" title="The agent refused">
            <span className="font-mono text-[12px]">{errorMessage(error)}</span>
          </InlineAlert>
        )}
      </form>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" form="file-name-form" disabled={pending || unchanged}>
          {pending && <Spinner data-icon="inline-start" />}
          {submitLabel}
        </Button>
      </DialogFooter>
    </>
  )
}

// ------------------------------------------------------------------ uploads

function UploadRow({ item, queue }: { item: UploadItem; queue: UploadQueue }) {
  const pct = item.total > 0 ? Math.min(100, Math.round((item.loaded / item.total) * 100)) : item.status === 'done' ? 100 : 0
  const active = item.status === 'uploading' || item.status === 'finishing'
  return (
    <li className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 px-3 py-2">
      <span className="row-span-2 flex size-7 items-center justify-center rounded-md bg-surface-3">
        {item.status === 'done' ? (
          <CircleCheck className="size-4 text-live" />
        ) : item.status === 'failed' ? (
          <CircleX className="size-4 text-critical" />
        ) : active ? (
          <Upload className="size-3.5 text-info" />
        ) : (
          <File className="size-3.5 text-subtle-foreground" />
        )}
      </span>
      <div className="min-w-0">
        <p className="truncate text-dense font-medium" title={item.target}>
          {item.file.name}
        </p>
      </div>
      <div className="row-span-2 flex items-center gap-0.5">
        {(item.status === 'failed' || item.status === 'cancelled') && (
          <Button variant="ghost" size="icon-xs" aria-label={`Retry ${item.file.name}`} onClick={() => queue.retry(item.id)}>
            <RotateCcw />
          </Button>
        )}
        {(active || item.status === 'queued' || item.status === 'conflict') && (
          <Button variant="ghost" size="icon-xs" aria-label={`Cancel ${item.file.name}`} onClick={() => queue.cancel(item.id)}>
            <X />
          </Button>
        )}
      </div>
      <div className="min-w-0">
        {active || item.status === 'queued' ? (
          <div className="flex items-center gap-2">
            <span className="relative h-1 flex-1 overflow-hidden rounded-full bg-surface-4">
              <span
                className={cn('absolute inset-y-0 left-0 rounded-full bg-primary transition-[width] duration-200', item.status === 'finishing' && 'animate-pulse')}
                style={{ width: `${item.status === 'queued' ? 0 : pct}%` }}
              />
            </span>
            <span className="tabular shrink-0 text-micro text-muted-foreground">
              {item.status === 'queued'
                ? 'Waiting'
                : item.status === 'finishing'
                  ? 'Writing on device…'
                  : `${pct}% · ${formatBytes(item.loaded)} of ${formatBytes(item.total)}${item.rate ? ` · ${formatRate(item.rate)}` : ''}`}
            </span>
          </div>
        ) : (
          <p className={cn('truncate text-micro', item.status === 'failed' ? 'text-critical' : 'text-muted-foreground')}>
            {item.status === 'done'
              ? `${formatBytes(item.total)} · uploaded`
              : item.status === 'failed'
                ? item.error
                : item.status === 'conflict'
                  ? 'Already exists — waiting for your choice'
                  : item.status === 'skipped'
                    ? 'Skipped (already exists)'
                    : 'Cancelled'}
          </p>
        )}
      </div>
    </li>
  )
}

function UploadPanel({ queue, items }: { queue: UploadQueue; items: UploadItem[] }) {
  const [collapsed, setCollapsed] = useState(false)
  if (items.length === 0) return null
  const done = items.filter((item) => item.status === 'done').length
  const active = items.filter((item) => item.status === 'uploading' || item.status === 'finishing' || item.status === 'queued').length
  const failed = items.filter((item) => item.status === 'failed').length
  const totalBytes = items.reduce((sum, item) => sum + item.total, 0)
  const sentBytes = items.reduce((sum, item) => sum + (item.status === 'done' ? item.total : item.loaded), 0)
  const pct = totalBytes > 0 ? Math.round((sentBytes / totalBytes) * 100) : 100
  return (
    <section aria-label="Uploads" className="border-t border-border bg-surface-2/50">
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed}>
          <ChevronDown className={cn('size-4 shrink-0 text-subtle-foreground transition-transform', collapsed && '-rotate-90')} />
          <span className="text-dense font-medium">{active > 0 ? `Uploading ${active} ${active === 1 ? 'file' : 'files'}` : 'Uploads'}</span>
          <span className="tabular truncate text-micro text-muted-foreground">
            {done} of {items.length} done{failed > 0 && ` · ${failed} failed`}
          </span>
        </button>
        {active > 0 && (
          <span className="relative hidden h-1 w-24 overflow-hidden rounded-full bg-surface-4 sm:block">
            <span className="absolute inset-y-0 left-0 rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
          </span>
        )}
        {active === 0 && (
          <Button variant="ghost" size="xs" onClick={() => queue.clearFinished()}>
            Clear
          </Button>
        )}
      </div>
      {!collapsed && <ul className="max-h-56 divide-y divide-border overflow-y-auto border-t border-border">{items.map((item) => <UploadRow key={item.id} item={item} queue={queue} />)}</ul>}
    </section>
  )
}

function ConflictPrompt({ queue, items }: { queue: UploadQueue; items: UploadItem[] }) {
  const conflicts = items.filter((item) => item.status === 'conflict')
  const current = conflicts[0]
  const [applyAll, setApplyAll] = useState(false)
  const others = conflicts.length - 1 + items.filter((item) => item.status === 'queued').length
  return (
    <AlertDialog open={Boolean(current)}>
      <AlertDialogContent>
        {current && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Replace “{current.file.name}”?</AlertDialogTitle>
              <AlertDialogDescription>
                A file with this name already exists in <span className="font-mono break-all text-foreground">{current.dir}</span>. Replacing it overwrites the
                existing file on the device.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {others > 0 && (
              <Label className="flex items-center gap-2 text-dense font-normal">
                <Checkbox checked={applyAll} onCheckedChange={(checked) => setApplyAll(checked === true)} />
                Do this for the other conflicts in this upload
              </Label>
            )}
            <AlertDialogFooter>
              <Button variant="ghost" onClick={() => queue.resolve(current.id, 'skip', applyAll)}>
                Skip
              </Button>
              <Button onClick={() => queue.resolve(current.id, 'replace', applyAll)}>Replace</Button>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ------------------------------------------------------------------ tool

type Dialogs = { kind: 'mkdir' } | { kind: 'rename'; entry: FileEntry } | { kind: 'delete'; entry: FileEntry } | null

export function FilesTool({ device }: { device: DeviceDetail }) {
  const queryClient = useQueryClient()
  const onDeviceGone = useDeviceGoneHandler(device.id)
  const style = pathStyle(device.os_family)
  const [path, setPath] = useState(style === 'windows' ? 'C:\\' : '/')
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sorting, setSorting] = useState<SortingState>([{ id: 'name', desc: false }])
  const [dialog, setDialog] = useState<Dialogs>(null)
  const [recursive, setRecursive] = useState(false)
  const [dragging, setDragging] = useState(false)
  const showHidden = useStore(showHiddenStore)
  const fileInput = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)

  const queue = uploadQueueFor(device.id, style)
  const uploads = useUploadItems(queue)
  useEffect(() => queue.onUploaded((dir) => void queryClient.invalidateQueries({ queryKey: keys.files(device.id, dir) })), [queue, queryClient, device.id])

  const listing = useQuery({
    queryKey: keys.files(device.id, path),
    queryFn: () => remoteApi.files(device.id, path),
    staleTime: 10_000,
    meta: { silent: true },
  })
  const rootsQuery = useQuery({
    queryKey: keys.files(device.id, ''),
    queryFn: () => remoteApi.files(device.id, ''),
    staleTime: 5 * 60_000,
    enabled: style === 'windows',
    meta: { silent: true },
  })

  useEffect(() => {
    if (listing.error) onDeviceGone(listing.error)
  }, [listing.error, onDeviceGone])

  const navigate = (next: string) => {
    setPath(next)
    setSelected(null)
    setQuery('')
  }

  const data: FileListing | undefined = listing.data
  const isRoots = path === '' || (style === 'posix' && data?.path === '')
  // Show the agent's canonical spelling of a typed path (c:/users becomes C:\Users).
  const displayPath = data && data.path && data.path.toLowerCase() === path.toLowerCase() ? data.path : path
  const canWrite = !isRoots
  const parent = data?.parent ?? parentPath(style, path)

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (data?.entries ?? [])
      .filter((entry) => showHidden || !entry.hidden)
      .filter((entry) => !needle || entry.name.toLowerCase().includes(needle))
      .sort((a, b) => compareEntries(a, b, sorting))
  }, [data, showHidden, query, sorting])

  const hiddenCount = (data?.entries ?? []).filter((entry) => entry.hidden).length
  const folders = visible.filter((entry) => entry.is_dir).length
  const totalSize = visible.reduce((sum, entry) => sum + (entry.is_dir ? 0 : (entry.size ?? 0)), 0)
  const selectedEntry = visible.find((entry) => entry.path === selected) ?? null

  const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.files(device.id, path) })

  const operation = useMutation({
    mutationFn: async (action: { kind: 'mkdir'; name: string } | { kind: 'rename'; entry: FileEntry; name: string } | { kind: 'delete'; entry: FileEntry; recursive: boolean }) => {
      if (action.kind === 'mkdir') {
        const target = joinPath(style, path, action.name)
        await remoteApi.fileOp(device.id, { op: 'mkdir', path: target })
        return { message: `Created ${action.name}`, select: target }
      }
      if (action.kind === 'rename') {
        const target = joinPath(style, parentPath(style, action.entry.path) ?? path, action.name)
        await remoteApi.fileOp(device.id, { op: 'rename', from: action.entry.path, to: target })
        return { message: `Renamed to ${action.name}`, select: target }
      }
      await remoteApi.fileOp(device.id, { op: 'delete', path: action.entry.path, recursive: action.recursive })
      return { message: `Deleted ${action.entry.name}`, select: null }
    },
    meta: { silent: true },
    onSuccess: (result) => {
      toast.success(result.message)
      setDialog(null)
      setSelected(result.select)
      refresh()
    },
    onError: (error) => onDeviceGone(error),
  })

  function openDialog(next: Dialogs) {
    operation.reset()
    setRecursive(false)
    setDialog(next)
  }

  function addFiles(files: FileList | File[] | null) {
    if (!files || files.length === 0) return
    if (!canWrite) {
      toast.message('Open a folder first', { description: 'Uploads go into the folder you are viewing.' })
      return
    }
    queue.add([...files], path)
  }

  function onDragEnter(event: DragEvent) {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }

  function onDragLeave(event: DragEvent) {
    if (!event.dataTransfer.types.includes('Files')) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  function onDrop(event: DragEvent) {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    addFiles(event.dataTransfer.files)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('input, textarea, [role="dialog"]')) return
    if (event.key === 'Backspace' && parent !== null && parent !== undefined) {
      event.preventDefault()
      navigate(parent)
    } else if (event.key === 'Delete' && selectedEntry && canWrite) {
      event.preventDefault()
      openDialog({ kind: 'delete', entry: selectedEntry })
    } else if (event.key === 'F2' && selectedEntry && canWrite) {
      event.preventDefault()
      openDialog({ kind: 'rename', entry: selectedEntry })
    }
  }

  const open = (entry: FileEntry) => {
    if (entry.is_dir) navigate(entry.path)
    else downloadEntry(device.id, entry)
  }

  const columns = useMemo<ColumnDef<FileEntry>[]>(
    () => [
      {
        id: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <span className={cn('flex min-w-0 items-center gap-2.5', row.original.hidden && 'opacity-60')}>
            <EntryIcon entry={row.original} />
            <span className={cn('max-w-[min(46vw,34rem)] truncate', row.original.is_dir && 'font-medium')} title={row.original.name}>
              {row.original.name}
            </span>
          </span>
        ),
      },
      {
        id: 'size',
        header: 'Size',
        meta: { align: 'right' },
        cell: ({ row }) => (
          <span className="tabular text-muted-foreground">{row.original.is_dir ? <span className="text-subtle-foreground">—</span> : formatBytes(row.original.size)}</span>
        ),
      },
      {
        id: 'modified',
        header: 'Modified',
        meta: { className: 'hidden md:table-cell', headerClassName: 'hidden md:table-cell' },
        cell: ({ row }) =>
          row.original.modified ? (
            <Tooltip>
              <TooltipTrigger render={<span className="tabular text-muted-foreground" />}>{formatDateTime(row.original.modified)}</TooltipTrigger>
              <TooltipContent>{formatRelative(row.original.modified)}</TooltipContent>
            </Tooltip>
          ) : (
            <span className="text-subtle-foreground">—</span>
          ),
      },
      {
        id: 'attributes',
        header: 'Attributes',
        meta: { className: 'hidden lg:table-cell', headerClassName: 'hidden lg:table-cell' },
        cell: ({ row }) => {
          const list = attributes(row.original)
          return list.length === 0 ? (
            <span className="text-subtle-foreground">—</span>
          ) : (
            <span className="flex gap-1">
              {list.map((item) => (
                <span key={item} className="inline-flex h-[18px] items-center rounded-[4px] bg-surface-3 px-1.5 font-mono text-[10px] text-muted-foreground ring-1 ring-border">
                  {item}
                </span>
              ))}
            </span>
          )
        },
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        size: 44,
        meta: { align: 'right' },
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Actions for ${row.original.name}`}
                  className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                />
              }
            >
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="truncate">{row.original.name}</DropdownMenuLabel>
                {row.original.is_dir ? (
                  <DropdownMenuItem onClick={() => navigate(row.original.path)}>
                    <FolderOpen />
                    Open
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={() => downloadEntry(device.id, row.original)}>
                    <Download />
                    Download
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={async () => {
                    if (await copyText(row.original.path)) toast.success('Path copied')
                  }}
                >
                  <Copy />
                  Copy path
                </DropdownMenuItem>
              </DropdownMenuGroup>
              {!row.original.drive && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => openDialog({ kind: 'rename', entry: row.original })}>
                    <Pencil />
                    Rename…
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={() => openDialog({ kind: 'delete', entry: row.original })}>
                    <Trash />
                    Delete…
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [device.id],
  )

  const places = quickPlaces(device, style)
  const drives = rootsQuery.data?.entries ?? []
  const deleteEntry = dialog?.kind === 'delete' ? dialog.entry : null

  return (
    <div className="grid gap-3 [&>*]:min-w-0" onKeyDown={onKeyDown}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-[1_1_28rem] items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="outline" size="icon-sm" aria-label="Up one level" disabled={parent === null || parent === undefined} onClick={() => parent !== null && parent !== undefined && navigate(parent)} />}
            >
              <ArrowUp />
            </TooltipTrigger>
            <TooltipContent>Up one level (Backspace)</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="icon-sm" aria-label="Locations" />}>
              <House />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60">
              {style === 'windows' && drives.length > 0 && (
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Drives</DropdownMenuLabel>
                  {drives.map((drive) => (
                    <DropdownMenuItem key={drive.path} onClick={() => navigate(drive.path)}>
                      <HardDrive />
                      <span className="font-mono text-[12px]">{drive.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              )}
              {style === 'windows' && drives.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuGroup>
                <DropdownMenuLabel>Quick access</DropdownMenuLabel>
                {places.map((place) => (
                  <DropdownMenuItem key={place.path} onClick={() => navigate(place.path)}>
                    <Folder />
                    <span className="min-w-0 flex-1 truncate">{place.label}</span>
                    <span className="max-w-24 truncate font-mono text-[10.5px] text-subtle-foreground">{baseName(style, place.path)}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <PathBar key={displayPath} style={style} path={displayPath} onNavigate={navigate} />
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" size="icon-sm" aria-label="Refresh" onClick={refresh} disabled={listing.isFetching} />}>
              <RefreshCw className={cn(listing.isFetching && 'animate-spin')} />
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SearchField value={query} onChange={setQuery} label="Filter this folder" placeholder="Filter this folder…" className="sm:w-52" />
          <Label className="flex h-8 items-center gap-2 rounded-lg px-1 text-dense font-normal text-muted-foreground">
            <Switch size="sm" checked={showHidden} onCheckedChange={(checked) => showHiddenStore.set(checked)} />
            Hidden
            {hiddenCount > 0 && <span className="tabular text-micro text-subtle-foreground">{hiddenCount}</span>}
          </Label>
          <Button variant="outline" size="sm" disabled={!canWrite} onClick={() => openDialog({ kind: 'mkdir' })}>
            <FolderPlus data-icon="inline-start" />
            New folder
          </Button>
          <Button size="sm" disabled={!canWrite} onClick={() => fileInput.current?.click()}>
            <Upload data-icon="inline-start" />
            Upload
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              addFiles(event.target.files)
              event.target.value = ''
            }}
          />
        </div>
      </div>

      {data?.truncated && (
        <InlineAlert tone="warning" title={`Showing the first ${formatNumber(data.entries.length)} items`}>
          This folder is larger than a listing can return. Type a more specific path to reach a subfolder directly.
        </InlineAlert>
      )}

      {/* Listing */}
      <div
        className="relative overflow-hidden rounded-xl bg-card shadow-card"
        onDragEnter={onDragEnter}
        onDragOver={(event) => event.dataTransfer.types.includes('Files') && event.preventDefault()}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {listing.error ? (
          <div className="p-4">
            <QueryError error={listing.error} what="this folder" onRetry={() => void listing.refetch()} />
            {parent !== null && parent !== undefined && (
              <Button variant="ghost" size="sm" className="mt-3" onClick={() => navigate(parent)}>
                <ArrowUp data-icon="inline-start" />
                Back to {parent === '' ? 'drives' : baseName(style, parent)}
              </Button>
            )}
          </div>
        ) : (
          <DataTable
            data={visible}
            columns={columns}
            getRowId={(entry) => entry.path}
            loading={listing.isLoading}
            manualSorting
            sorting={sorting}
            onSortingChange={setSorting}
            activeRowId={selected}
            onRowClick={(entry) => setSelected(entry.path)}
            onRowActivate={open}
            virtualHeight={visible.length > 150 ? 'min(64vh, 680px)' : undefined}
            caption={`Contents of ${path || 'drives'}`}
            className="rounded-none shadow-none"
            empty={
              query ? (
                <div className="px-4 py-10 text-center text-dense text-muted-foreground">Nothing in this folder matches “{query}”.</div>
              ) : !showHidden && hiddenCount > 0 ? (
                <div className="px-4 py-10 text-center text-dense text-muted-foreground">
                  Only hidden items here.{' '}
                  <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={() => showHiddenStore.set(true)}>
                    Show hidden files
                  </button>
                </div>
              ) : (
                <EmptyState
                  compact
                  className="m-4 border-border"
                  title="This folder is empty"
                  description={canWrite ? 'Drop files here or use Upload to copy them to the device.' : 'No drives were reported.'}
                  actions={
                    canWrite && (
                      <>
                        <Button variant="outline" size="sm" onClick={() => openDialog({ kind: 'mkdir' })}>
                          <FolderPlus data-icon="inline-start" />
                          New folder
                        </Button>
                        <Button size="sm" onClick={() => fileInput.current?.click()}>
                          <Upload data-icon="inline-start" />
                          Upload files
                        </Button>
                      </>
                    )
                  }
                />
              )
            }
          />
        )}

        {/* Footer */}
        {!listing.error && data && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-2 text-micro text-muted-foreground">
            <span className="tabular">
              {isRoots
                ? `${formatNumber(visible.length)} ${visible.length === 1 ? 'drive' : 'drives'}`
                : `${formatNumber(folders)} ${folders === 1 ? 'folder' : 'folders'} · ${formatNumber(visible.length - folders)} ${visible.length - folders === 1 ? 'file' : 'files'}${totalSize > 0 ? ` · ${formatBytes(totalSize)}` : ''}`}
            </span>
            {selectedEntry && (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="text-subtle-foreground">·</span>
                <span className="truncate font-mono text-[11px] text-foreground/80">{selectedEntry.name}</span>
                {!selectedEntry.is_dir && <span className="tabular">{formatBytes(selectedEntry.size)}</span>}
                {!selectedEntry.is_dir && (
                  <Button variant="ghost" size="xs" onClick={() => downloadEntry(device.id, selectedEntry)}>
                    <Download data-icon="inline-start" />
                    Download
                  </Button>
                )}
              </span>
            )}
            <span className="ml-auto hidden text-subtle-foreground md:inline">Double-click to open · F2 rename · Del delete</span>
          </div>
        )}

        <UploadPanel queue={queue} items={uploads} />

        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-primary/[0.06] p-4 ring-2 ring-primary ring-inset backdrop-blur-[1px]">
            <div className="rounded-xl bg-card px-5 py-4 text-center shadow-popover">
              <Upload className="mx-auto size-6 text-primary" />
              <p className="mt-2 text-dense font-medium">{canWrite ? 'Drop to upload' : 'Open a folder to upload'}</p>
              {canWrite && <p className="mt-0.5 max-w-xs truncate font-mono text-[11px] text-muted-foreground">{path}</p>}
            </div>
          </div>
        )}
      </div>

      <ConflictPrompt queue={queue} items={uploads} />

      <NameDialog
        open={dialog?.kind === 'mkdir'}
        onOpenChange={(next) => !next && setDialog(null)}
        title="New folder"
        description={
          <>
            Creates a folder in <span className="font-mono break-all text-foreground">{path}</span> on {deviceName(device)}.
          </>
        }
        initial=""
        submitLabel="Create folder"
        style={style}
        pending={operation.isPending}
        error={operation.error}
        onSubmit={(name) => operation.mutate({ kind: 'mkdir', name })}
      />
      <NameDialog
        open={dialog?.kind === 'rename'}
        onOpenChange={(next) => !next && setDialog(null)}
        title={`Rename ${dialog?.kind === 'rename' && dialog.entry.is_dir ? 'folder' : 'file'}`}
        description={
          dialog?.kind === 'rename' ? (
            <>
              Renames <span className="font-mono break-all text-foreground">{dialog.entry.path}</span>.
            </>
          ) : null
        }
        initial={dialog?.kind === 'rename' ? dialog.entry.name : ''}
        submitLabel="Rename"
        style={style}
        pending={operation.isPending}
        error={operation.error}
        onSubmit={(name) => dialog?.kind === 'rename' && operation.mutate({ kind: 'rename', entry: dialog.entry, name })}
      />
      <ConfirmDialog
        open={Boolean(deleteEntry)}
        onOpenChange={(next) => !next && setDialog(null)}
        title={`Delete ${deleteEntry?.name ?? ''}?`}
        description={
          <>
            Permanently deletes <span className="font-mono break-all text-foreground">{deleteEntry?.path}</span> from {deviceName(device)}. It doesn’t go to the{' '}
            {style === 'windows' ? 'Recycle Bin' : 'Trash'} and can’t be undone.
          </>
        }
        confirmLabel={deleteEntry?.is_dir ? (recursive ? 'Delete folder and contents' : 'Delete folder') : 'Delete file'}
        pending={operation.isPending}
        onConfirm={() => deleteEntry && operation.mutate({ kind: 'delete', entry: deleteEntry, recursive })}
      >
        {deleteEntry?.is_dir && (
          <Label className="flex items-start gap-2.5 rounded-lg bg-surface-2 px-3 py-2.5 text-dense font-normal ring-1 ring-border">
            <Checkbox className="mt-0.5" checked={recursive} onCheckedChange={(checked) => setRecursive(checked === true)} />
            <span>
              <span className="font-medium">Delete everything inside</span>
              <span className="block text-micro text-muted-foreground">Without this, only an empty folder can be deleted.</span>
            </span>
          </Label>
        )}
        {Boolean(operation.error) && dialog?.kind === 'delete' && (
          <InlineAlert title="The agent refused">
            <span className="font-mono text-[12px]">{errorMessage(operation.error)}</span>
            {isApiError(operation.error) && /not empty/i.test(operation.error.message) && !recursive && (
              <span className="mt-1 block font-sans">Tick “Delete everything inside” to remove its contents too.</span>
            )}
          </InlineAlert>
        )}
      </ConfirmDialog>
    </div>
  )
}
