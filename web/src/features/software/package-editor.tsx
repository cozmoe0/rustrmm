/* The library package editor: source (package manager or uploaded installer), platforms and detection. */
import { useReducer, useRef, useState, type DragEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CircleCheck, FileUp, Save, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { CopyButton } from '@/components/common/copy-button'
import { OsIcon } from '@/components/common/os-icon'
import { SimpleSelect } from '@/components/common/simple-select'
import { softwareApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { keys } from '@/lib/api/queries'
import type { DetectionRule, InstallerType, OsFamily, PackageSource, SoftwarePackage, SoftwarePackageInput } from '@/lib/api/types'
import { OS_LABEL } from '@/lib/devices'
import { formatBytes, formatRate } from '@/lib/format'
import { ARGS_MAX, compactDetection, defaultDetection, defaultSource, describeDetection, validatePackage, type FieldErrors } from '@/lib/software/detection'
import { DETECTION_LABEL, INSTALLER_META, INSTALLER_ORDER, SOURCE_META, SOURCE_ORDER, installerFromName, sourcePlatforms } from '@/lib/software/labels'
import { IDLE, formatEta, uploadEta, uploadPct, uploadProblem, uploadReducer } from '@/lib/software/upload'
import { cn } from '@/lib/utils'
import { SEGMENTED } from '@/features/automation/styles'
import { SourceTile } from './software-ui'

const PLATFORMS: OsFamily[] = ['windows', 'macos', 'linux']

function emptyInput(): SoftwarePackageInput {
  return { name: '', publisher: '', description: '', platforms: ['windows'], source: { type: 'winget', id: '' }, detection: { type: 'software_name', pattern: '' } }
}

function toInput(pkg: SoftwarePackage): SoftwarePackageInput {
  return { name: pkg.name, publisher: pkg.publisher, description: pkg.description, platforms: pkg.platforms, source: pkg.source, detection: pkg.detection }
}

/** Uploads an installer with XHR progress, then shows its SHA-256 and size. */
function UploadField({ source, onUploaded, disabled, error }: { source: Extract<PackageSource, { type: 'file' }>; onUploaded: (file: { file_id: string; file_name: string; sha256: string; size_bytes: number }) => void; disabled: boolean; error?: string }) {
  const [state, dispatch] = useReducer(uploadReducer, IDLE)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const abort = useRef<AbortController | null>(null)

  const start = (file: File) => {
    const problem = uploadProblem(file)
    if (problem) {
      toast.error(problem)
      return
    }
    const controller = new AbortController()
    abort.current = controller
    dispatch({ type: 'start', name: file.name, size: file.size, at: Date.now() })
    softwareApi
      .upload(file, { signal: controller.signal, onProgress: (loaded, total) => dispatch({ type: 'progress', loaded, total, at: Date.now() }) })
      .then((uploaded) => {
        dispatch({ type: 'done', file: uploaded, at: Date.now() })
        onUploaded(uploaded)
      })
      .catch((failure: unknown) => {
        if (failure instanceof DOMException && failure.name === 'AbortError') dispatch({ type: 'cancel' })
        else dispatch({ type: 'fail', error: errorMessage(failure) })
      })
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (file && !disabled) start(file)
  }

  const hasFile = Boolean(source.file_id)
  return (
    <div className="grid gap-2">
      <input ref={input} type="file" className="sr-only" tabIndex={-1} onChange={(event) => event.target.files?.[0] && start(event.target.files[0])} accept=".msi,.exe,.pkg,.deb,.rpm,.sh" />
      {state.phase === 'uploading' ? (
        <div className="grid gap-2 rounded-lg bg-surface-2 p-3 ring-1 ring-border">
          <div className="flex items-center gap-2">
            <Spinner className="size-4 text-primary" />
            <span className="min-w-0 flex-1 truncate text-dense font-medium">{state.name}</span>
            <span className="tabular text-dense font-semibold">{uploadPct(state)}%</span>
            <Button variant="ghost" size="icon-xs" aria-label="Cancel upload" onClick={() => abort.current?.abort()}>
              <X />
            </Button>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-4">
            <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${uploadPct(state)}%` }} />
          </div>
          <div className="tabular flex justify-between text-micro text-muted-foreground">
            <span>
              {formatBytes(state.loaded)} of {formatBytes(state.size)}
              {state.rate > 0 ? ` · ${formatRate(state.rate)}` : ''}
            </span>
            <span>{uploadPct(state) >= 100 ? 'Hashing on the server…' : formatEta(uploadEta(state))}</span>
          </div>
        </div>
      ) : hasFile ? (
        <div className="grid gap-2 rounded-lg bg-success/[0.05] p-3 ring-1 ring-success/25">
          <div className="flex items-center gap-2">
            <CircleCheck className="size-4 shrink-0 text-success" />
            <span className="min-w-0 flex-1 truncate text-dense font-medium">{source.file_name}</span>
            <span className="tabular text-micro text-muted-foreground">{formatBytes(source.size_bytes)}</span>
            {!disabled && (
              <Button variant="ghost" size="xs" onClick={() => input.current?.click()}>
                Replace
              </Button>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-micro text-muted-foreground">
            <span className="shrink-0">SHA-256</span>
            <code className="min-w-0 truncate font-mono text-[11px] text-secondary-foreground">{source.sha256}</code>
            <CopyButton value={source.sha256} label="Copy SHA-256" />
          </div>
          {state.phase === 'done' && <p className="text-micro text-subtle-foreground">Uploaded in {(state.durationMs / 1000).toFixed(1)} s. Agents verify this hash before running the installer.</p>}
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => input.current?.click()}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border-strong px-4 py-6 text-center outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring',
            dragging && 'border-primary bg-primary/[0.05]',
            error && 'border-critical/60',
          )}
        >
          <FileUp className="size-5 text-subtle-foreground" />
          <span className="text-dense font-medium">Drop an installer or choose a file</span>
          <span className="text-micro text-muted-foreground">MSI, EXE, PKG, DEB, RPM or shell script · up to 4 GiB</span>
        </button>
      )}
      {state.phase === 'failed' && <FieldError>Upload failed: {state.error}</FieldError>}
      {state.phase === 'cancelled' && <p className="text-micro text-muted-foreground">Upload cancelled.</p>}
      {error && state.phase !== 'uploading' && !hasFile && <FieldError>{error}</FieldError>}
    </div>
  )
}

function DetectionEditor({ rule, onChange, errors, disabled, name }: { rule: DetectionRule; onChange: (rule: DetectionRule) => void; errors: FieldErrors; disabled: boolean; name: string }) {
  return (
    <div className="grid gap-3">
      <ToggleGroup
        value={[rule.type]}
        onValueChange={(next: string[]) => next[0] && onChange(defaultDetection(next[0] as DetectionRule['type'], name))}
        variant="outline"
        spacing={0}
        size="sm"
        className={cn('w-full flex-wrap sm:w-auto', SEGMENTED)}
        disabled={disabled}
        aria-label="Detection"
      >
        {(['software_name', 'file', 'registry', 'none'] as const).map((type) => (
          <ToggleGroupItem key={type} value={type} className="flex-1 px-3 sm:flex-none">
            {{ software_name: 'Software name', file: 'File', registry: 'Registry', none: 'None' }[type]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {rule.type === 'software_name' && (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <Field data-invalid={Boolean(errors['detection.pattern']) || undefined}>
            <FieldLabel htmlFor="det-pattern">Name pattern</FieldLabel>
            <Input id="det-pattern" value={rule.pattern} disabled={disabled} placeholder="7-Zip*" onChange={(event) => onChange({ ...rule, pattern: event.target.value })} />
            {errors['detection.pattern'] ? <FieldError>{errors['detection.pattern']}</FieldError> : <FieldDescription>* and ? wildcards, case-insensitive, against the software inventory.</FieldDescription>}
          </Field>
          <Field data-invalid={Boolean(errors['detection.min_version']) || undefined}>
            <FieldLabel htmlFor="det-version">Minimum version</FieldLabel>
            <Input id="det-version" className="font-mono" value={rule.min_version ?? ''} disabled={disabled} placeholder="Any" onChange={(event) => onChange({ ...rule, min_version: event.target.value })} />
            <FieldError>{errors['detection.min_version']}</FieldError>
          </Field>
        </div>
      )}
      {rule.type === 'file' && (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <Field data-invalid={Boolean(errors['detection.path']) || undefined}>
            <FieldLabel htmlFor="det-path">File path</FieldLabel>
            <Input id="det-path" className="font-mono" value={rule.path} disabled={disabled} placeholder="C:\Program Files\7-Zip\7z.exe" onChange={(event) => onChange({ ...rule, path: event.target.value })} />
            {errors['detection.path'] ? <FieldError>{errors['detection.path']}</FieldError> : <FieldDescription>%VAR% is expanded. On Windows the minimum version is read from the file’s version resource.</FieldDescription>}
          </Field>
          <Field data-invalid={Boolean(errors['detection.min_version']) || undefined}>
            <FieldLabel htmlFor="det-file-version">Minimum version</FieldLabel>
            <Input id="det-file-version" className="font-mono" value={rule.min_version ?? ''} disabled={disabled} placeholder="Any" onChange={(event) => onChange({ ...rule, min_version: event.target.value })} />
            <FieldError>{errors['detection.min_version']}</FieldError>
          </Field>
        </div>
      )}
      {rule.type === 'registry' && (
        <div className="grid gap-3">
          <Field data-invalid={Boolean(errors['detection.key']) || undefined}>
            <FieldLabel htmlFor="det-key">Registry key</FieldLabel>
            <Input id="det-key" className="font-mono" value={rule.key} disabled={disabled} placeholder="HKLM\SOFTWARE\Vendor\Product" onChange={(event) => onChange({ ...rule, key: event.target.value })} />
            {errors['detection.key'] ? <FieldError>{errors['detection.key']}</FieldError> : <FieldDescription>The 64-bit view. Without a value, the key existing counts as installed.</FieldDescription>}
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field data-invalid={Boolean(errors['detection.value']) || undefined}>
              <FieldLabel htmlFor="det-value">Value name</FieldLabel>
              <Input id="det-value" className="font-mono" value={rule.value ?? ''} disabled={disabled} placeholder="Optional" onChange={(event) => onChange({ ...rule, value: event.target.value })} />
              <FieldError>{errors['detection.value']}</FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor="det-equals">Equals</FieldLabel>
              <Input id="det-equals" className="font-mono" value={rule.equals ?? ''} disabled={disabled} placeholder="Optional" onChange={(event) => onChange({ ...rule, equals: event.target.value })} />
              <FieldDescription>Compared as text; DWORDs as decimal.</FieldDescription>
            </Field>
          </div>
        </div>
      )}
      {rule.type === 'none' && <p className="text-dense text-muted-foreground">Without detection every target runs the action, and success is judged by the exit code alone.</p>}
      {((rule.type === 'software_name' && rule.pattern.trim()) || (rule.type === 'file' && rule.path.trim()) || (rule.type === 'registry' && rule.key.trim())) && (
        <p className="rounded-md bg-surface-2 px-3 py-2 text-micro text-muted-foreground ring-1 ring-border">
          <span className="font-medium text-foreground">{DETECTION_LABEL[rule.type]}:</span> {describeDetection(rule)}. Checked before (already installed → skipped) and after the action.
        </p>
      )}
    </div>
  )
}

export function PackageEditor({ pkg, open, onOpenChange }: { pkg: SoftwarePackage | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<SoftwarePackageInput>(() => (pkg ? toInput(pkg) : emptyInput()))
  const [attempted, setAttempted] = useState(false)
  const [serverIssue, setServerIssue] = useState<{ path: string; message: string } | null>(null)
  const errors = validatePackage(draft)
  const shown: FieldErrors = attempted ? { ...errors, ...(serverIssue ? { [serverIssue.path]: serverIssue.message } : {}) } : {}
  const supported = sourcePlatforms(draft.source)
  const set = (patch: Partial<SoftwarePackageInput>) => {
    setDraft((prev) => ({ ...prev, ...patch }))
    setServerIssue(null)
  }
  const setSource = (source: PackageSource) => {
    const platforms = sourcePlatforms(source)
    set({ source, platforms: draft.platforms.filter((os) => platforms.includes(os)).length ? draft.platforms.filter((os) => platforms.includes(os)) : platforms })
  }

  const save = useMutation({
    mutationFn: () => {
      const body: SoftwarePackageInput = { ...draft, name: draft.name.trim(), publisher: draft.publisher.trim(), description: draft.description.trim(), detection: compactDetection(draft.detection) }
      return pkg ? softwareApi.updatePackage(pkg.id, body) : softwareApi.createPackage(body)
    },
    meta: { silent: true },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: keys.packages })
      toast.success(pkg ? `Saved “${saved.name}”` : `Added “${saved.name}” to the library`)
      onOpenChange(false)
    },
    onError: (failure) => {
      if (isApiError(failure) && failure.status === 422) setServerIssue({ path: String((failure.details as { path?: string } | undefined)?.path ?? 'name'), message: failure.message })
      toast.error(errorMessage(failure))
    },
  })

  const source = draft.source
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-0 p-0 shadow-popover data-[side=right]:w-full data-[side=right]:sm:max-w-[640px]">
        <SheetHeader className="border-b border-border px-5 pt-5 pb-4">
          <SheetTitle>{pkg ? `Edit “${pkg.name}”` : 'New package'}</SheetTitle>
          <SheetDescription>Library packages are shared by every client. Deploy them from the library, the explorer or a device.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 gap-6 p-5">
            <section className="grid gap-3">
              <h3 className="eyebrow">Package</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field data-invalid={Boolean(shown.name) || undefined}>
                  <FieldLabel htmlFor="pkg-name">Name</FieldLabel>
                  <Input id="pkg-name" value={draft.name} maxLength={120} onChange={(event) => set({ name: event.target.value })} />
                  <FieldError>{shown.name}</FieldError>
                </Field>
                <Field>
                  <FieldLabel htmlFor="pkg-publisher">Publisher</FieldLabel>
                  <Input id="pkg-publisher" value={draft.publisher} maxLength={120} onChange={(event) => set({ publisher: event.target.value })} />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="pkg-description">Description</FieldLabel>
                <Textarea id="pkg-description" rows={2} value={draft.description} maxLength={500} onChange={(event) => set({ description: event.target.value })} />
              </Field>
            </section>

            <section className="grid gap-3">
              <h3 className="eyebrow">Source</h3>
              <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
                {SOURCE_ORDER.map((type) => (
                  <button
                    key={type}
                    type="button"
                    aria-pressed={source.type === type}
                    onClick={() => source.type !== type && setSource(defaultSource(type))}
                    className={cn(
                      'flex flex-col items-center gap-1.5 rounded-lg px-2 py-2.5 text-micro ring-1 ring-border outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring',
                      source.type === type && 'bg-primary/[0.06] font-medium text-foreground ring-primary/35',
                    )}
                  >
                    <SourceTile type={type} size="sm" />
                    {type === 'file' ? 'Upload' : SOURCE_META[type].label}
                  </button>
                ))}
              </div>
              {source.type === 'file' ? (
                <div className="grid gap-3">
                  <UploadField
                    source={source}
                    disabled={save.isPending}
                    error={shown['source.file'] ?? shown['source.file_id']}
                    onUploaded={(file) => {
                      const installer = installerFromName(file.file_name) ?? source.installer
                      const meta = INSTALLER_META[installer]
                      setSource({ ...source, ...file, installer, install_args: source.file_id ? source.install_args : meta.installArgs, uninstall_args: source.file_id ? source.uninstall_args : meta.uninstallArgs })
                      if (!draft.name.trim()) set({ name: file.file_name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ') })
                    }}
                  />
                  <Field>
                    <FieldLabel htmlFor="pkg-installer">Installer type</FieldLabel>
                    <SimpleSelect
                      id="pkg-installer"
                      value={source.installer}
                      onValueChange={(value) => {
                        const installer = value as InstallerType
                        setSource({ ...source, installer, install_args: INSTALLER_META[installer].installArgs, uninstall_args: INSTALLER_META[installer].uninstallArgs })
                      }}
                      options={INSTALLER_ORDER.map((installer) => ({ value: installer, label: INSTALLER_META[installer].label }))}
                    />
                    <FieldDescription>
                      Runs <code className="font-mono">{INSTALLER_META[source.installer].runs}</code>
                    </FieldDescription>
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field data-invalid={Boolean(shown['source.install_args']) || undefined}>
                      <FieldLabel htmlFor="pkg-install-args">Install arguments</FieldLabel>
                      <Input id="pkg-install-args" className="font-mono" value={source.install_args} maxLength={ARGS_MAX + 20} onChange={(event) => setSource({ ...source, install_args: event.target.value })} />
                      <FieldError>{shown['source.install_args']}</FieldError>
                    </Field>
                    <Field data-invalid={Boolean(shown['source.uninstall_args']) || undefined}>
                      <FieldLabel htmlFor="pkg-uninstall-args">Uninstall arguments</FieldLabel>
                      <Input id="pkg-uninstall-args" className="font-mono" value={source.uninstall_args} maxLength={ARGS_MAX + 20} onChange={(event) => setSource({ ...source, uninstall_args: event.target.value })} />
                      {shown['source.uninstall_args'] ? (
                        <FieldError>{shown['source.uninstall_args']}</FieldError>
                      ) : (
                        <FieldDescription>{source.installer === 'msi' ? 'Used with msiexec /x.' : source.installer === 'exe' || source.installer === 'sh' ? 'Leave empty if the installer can’t uninstall.' : 'Not used for this installer.'}</FieldDescription>
                      )}
                    </Field>
                  </div>
                </div>
              ) : (
                <div className="grid gap-3">
                  <Field data-invalid={Boolean(shown['source.id']) || undefined}>
                    <FieldLabel htmlFor="pkg-source-id">{SOURCE_META[source.type].idLabel}</FieldLabel>
                    <Input id="pkg-source-id" className="font-mono" value={source.id} placeholder={SOURCE_META[source.type].placeholder} onChange={(event) => setSource({ ...source, id: event.target.value })} />
                    {shown['source.id'] ? <FieldError>{shown['source.id']}</FieldError> : <FieldDescription>{SOURCE_META[source.type].hint}</FieldDescription>}
                  </Field>
                  {source.type === 'brew' && (
                    <label className="flex items-center gap-3 text-dense">
                      <Switch checked={Boolean(source.cask)} onCheckedChange={(cask) => setSource({ ...source, cask })} />
                      Cask (an app, not a command-line formula)
                    </label>
                  )}
                </div>
              )}
            </section>

            <section className="grid gap-3">
              <h3 className="eyebrow">Platforms</h3>
              <div className="flex flex-wrap gap-1.5">
                {PLATFORMS.map((os) => {
                  const allowed = supported.includes(os)
                  const active = draft.platforms.includes(os)
                  return (
                    <button
                      key={os}
                      type="button"
                      disabled={!allowed}
                      aria-pressed={active}
                      onClick={() => set({ platforms: active ? draft.platforms.filter((item) => item !== os) : [...draft.platforms, os] })}
                      className={cn(
                        'inline-flex h-8 items-center gap-2 rounded-md px-3 text-dense text-muted-foreground ring-1 ring-border transition-colors hover:bg-surface-3 disabled:pointer-events-none disabled:opacity-40',
                        active && 'bg-primary/10 font-medium text-foreground ring-primary/35',
                      )}
                    >
                      <OsIcon family={os} />
                      {OS_LABEL[os]}
                    </button>
                  )
                })}
              </div>
              {shown.platforms ? <FieldError>{shown.platforms}</FieldError> : <p className="text-micro text-muted-foreground">Devices on other platforms are skipped. Only platforms the source supports can be chosen.</p>}
            </section>

            <section className="grid gap-3">
              <h3 className="eyebrow">Detection</h3>
              <DetectionEditor rule={draft.detection} onChange={(detection) => set({ detection })} errors={shown} disabled={save.isPending} name={draft.name} />
            </section>
          </div>
        </div>
        <SheetFooter className="flex-row justify-end gap-2 border-t border-border bg-surface-2/60 px-5 py-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            disabled={save.isPending || (attempted && Object.keys(errors).length > 0)}
            onClick={() => {
              setAttempted(true)
              if (Object.keys(errors).length === 0) save.mutate()
            }}
          >
            {save.isPending ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
            {pkg ? 'Save package' : 'Add to library'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
