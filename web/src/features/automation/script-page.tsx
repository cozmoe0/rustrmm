import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import {
  Archive,
  ArrowLeft,
  Copy,
  CopyPlus,
  Ellipsis,
  FileCode,
  Lock,
  Play,
  Save,
  ShieldCheck,
  Undo2,
  WrapText,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { CopyButton } from '@/components/common/copy-button'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, Mono, RelativeTime } from '@/components/common/misc'
import { OsIcon } from '@/components/common/os-icon'
import { PageContainer } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { copyText } from '@/lib/clipboard'
import { jobsApi, scriptsApi } from '@/lib/api/endpoints'
import { isApiError } from '@/lib/api/errors'
import { keys, scriptCategoriesQuery, scriptQuery } from '@/lib/api/queries'
import type { JobSummary, OsFamily, ParameterValue, Script, ScriptInput, ScriptLanguage } from '@/lib/api/types'
import { LANGUAGES, LANGUAGE_ORDER, PLATFORM_ORDER, describeSchedule, formatTimeout } from '@/lib/automation/labels'
import { defaultParameterValues, hasParameterIssues, validateParameterDefinitions } from '@/lib/automation/params'
import { OS_LABEL } from '@/lib/devices'
import { formatNumber, truncateMiddle } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import {
  ApprovalBadge,
  BuiltinBadge,
  JobStatusBadge,
  LanguageMark,
  PlatformIcons,
  RiskBadge,
  SegmentedProgress,
  TargetLabel,
} from './automation-ui'
import { CodeEditor } from './code-editor'
import { ParameterBuilder } from './parameter-builder'
import { ParameterForm } from './parameter-form'
import { openRunDialog } from './run-dialog-store'
import { ScriptVersions } from './script-versions'
import { UnsavedChangesGuard } from './unsaved-guard'
import { SEGMENTED } from './styles'

export type ScriptTab = 'script' | 'parameters' | 'versions' | 'runs'

type Draft = Omit<ScriptInput, 'notes'>

const NEW_DRAFT: Draft = {
  name: '',
  description: '',
  category: 'Maintenance',
  language: 'powershell',
  platforms: ['windows'],
  timeout_secs: 600,
  risk: 'normal',
  content: LANGUAGES.powershell.template,
  parameters: [],
}

function toDraft(script: Script): Draft {
  return {
    name: script.name,
    description: script.description,
    category: script.category,
    language: script.language,
    platforms: script.platforms,
    timeout_secs: script.timeout_secs,
    risk: script.risk,
    content: script.content,
    parameters: script.parameters,
  }
}

function slug(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'script'
  )
}

function draftProblems(draft: Draft) {
  return {
    name: !draft.name.trim() ? 'Enter a name' : draft.name.trim().length > 120 ? 'Keep it under 120 characters' : null,
    category: !draft.category.trim() ? 'Enter a category' : null,
    platforms: draft.platforms.length === 0 ? 'Choose at least one platform' : null,
    timeout:
      !Number.isInteger(draft.timeout_secs) || draft.timeout_secs < 10 || draft.timeout_secs > 86_400
        ? '10–86400 seconds'
        : null,
    content: !draft.content.trim() ? 'The script is empty' : null,
  }
}

function PlatformToggle({
  value,
  onChange,
  disabled,
}: {
  value: OsFamily[]
  onChange: (value: OsFamily[]) => void
  disabled: boolean
}) {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {PLATFORM_ORDER.map((os) => {
        const active = value.includes(os)
        return (
          <button
            key={os}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(active ? value.filter((item) => item !== os) : [...value, os])}
            className={cn(
              'flex h-(--control-h) items-center justify-center gap-1.5 rounded-lg border text-dense transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-70',
              active
                ? 'border-primary/40 bg-primary/10 font-medium text-foreground'
                : 'border-border-strong text-muted-foreground hover:bg-surface-3',
            )}
          >
            <OsIcon family={os} />
            {OS_LABEL[os]}
          </button>
        )
      })}
    </div>
  )
}

function DetailsCard({
  draft,
  setDraft,
  readOnly,
  problems,
  attempted,
}: {
  draft: Draft
  setDraft: (patch: Partial<Draft>) => void
  readOnly: boolean
  problems: ReturnType<typeof draftProblems>
  attempted: boolean
}) {
  const { data: categories = [] } = useQuery(scriptCategoriesQuery)
  const show = (message: string | null) => (attempted ? message : null)
  return (
    <div className="grid grid-cols-1 content-start gap-4 rounded-xl bg-card p-4 shadow-card">
      <h2 className="text-sm font-semibold">Details</h2>
      <fieldset disabled={readOnly} className="grid grid-cols-1 gap-3.5">
        <Field data-invalid={Boolean(show(problems.name)) || undefined}>
          <FieldLabel htmlFor="script-name">Name</FieldLabel>
          <Input
            id="script-name"
            value={draft.name}
            maxLength={120}
            placeholder="Restart print spooler"
            onChange={(event) => setDraft({ name: event.target.value })}
          />
          <FieldError>{show(problems.name)}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="script-description">Description</FieldLabel>
          <Textarea
            id="script-description"
            rows={3}
            value={draft.description}
            maxLength={600}
            placeholder="What it does and when to use it"
            onChange={(event) => setDraft({ description: event.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field data-invalid={Boolean(show(problems.category)) || undefined}>
            <FieldLabel htmlFor="script-category">Category</FieldLabel>
            <Input
              id="script-category"
              list="script-categories"
              value={draft.category}
              maxLength={40}
              onChange={(event) => setDraft({ category: event.target.value })}
            />
            <datalist id="script-categories">
              {categories.map((category) => (
                <option key={category.name} value={category.name} />
              ))}
            </datalist>
            <FieldError>{show(problems.category)}</FieldError>
          </Field>
          <Field data-invalid={Boolean(problems.timeout) || undefined}>
            <FieldLabel htmlFor="script-timeout">Timeout (s)</FieldLabel>
            <Input
              id="script-timeout"
              type="number"
              min={10}
              max={86400}
              className="tabular"
              value={draft.timeout_secs}
              onChange={(event) => setDraft({ timeout_secs: Number(event.target.value) })}
            />
            <FieldDescription>{problems.timeout ?? formatTimeout(draft.timeout_secs)}</FieldDescription>
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="script-language">Language</FieldLabel>
          <SimpleSelect
            id="script-language"
            value={draft.language}
            disabled={readOnly}
            onValueChange={(value) => {
              const language = value as ScriptLanguage
              const untouched =
                LANGUAGE_ORDER.some((key) => LANGUAGES[key].template === draft.content) || !draft.content.trim()
              setDraft({
                language,
                ...(untouched
                  ? { content: LANGUAGES[language].template, platforms: LANGUAGES[language].platforms }
                  : {}),
              })
            }}
            options={LANGUAGE_ORDER.map((language) => ({
              value: language,
              label: LANGUAGES[language].label,
              icon: <LanguageMark language={language} size="sm" />,
            }))}
          />
        </Field>
        <Field data-invalid={Boolean(show(problems.platforms)) || undefined}>
          <FieldLabel>Platforms</FieldLabel>
          <PlatformToggle
            value={draft.platforms}
            onChange={(platforms) => setDraft({ platforms })}
            disabled={readOnly}
          />
          <FieldError>{show(problems.platforms)}</FieldError>
          {!problems.platforms && (
            <FieldDescription>Devices on other platforms are skipped when the script runs.</FieldDescription>
          )}
        </Field>
        <Field>
          <FieldLabel>Risk</FieldLabel>
          <ToggleGroup
            value={[draft.risk]}
            onValueChange={(next: string[]) => next[0] && setDraft({ risk: next[0] as Draft['risk'] })}
            variant="outline"
            spacing={0}
            className={cn('w-full', SEGMENTED)}
            disabled={readOnly}
          >
            <ToggleGroupItem value="normal" className="flex-1">
              Normal
            </ToggleGroupItem>
            <ToggleGroupItem value="high" className="flex-1 data-[pressed]:text-critical">
              High
            </ToggleGroupItem>
          </ToggleGroup>
          <FieldDescription>
            High-risk scripts always need a typed confirmation and re-authentication, and four-eyes approval when it is
            on.
          </FieldDescription>
        </Field>
      </fieldset>
    </div>
  )
}

function ScriptRuns({ scriptId }: { scriptId: string }) {
  const navigate = useNavigate()
  const { data, isLoading } = useQuery({
    queryKey: ['jobs', 'list', { script_id: scriptId }],
    queryFn: () => jobsApi.list({ script_id: scriptId, limit: 50 }),
  })
  const columns = useMemo<ColumnDef<JobSummary>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (job) => job.name.toLowerCase(),
        header: 'Job',
        cell: ({ row }) => <span className="block max-w-72 truncate font-medium">{row.original.name}</span>,
      },
      {
        id: 'target',
        accessorFn: (job) => job.target.label,
        header: 'Target',
        cell: ({ row }) => (
          <TargetLabel
            type={row.original.target.type}
            label={row.original.target.label}
            className="max-w-56 text-muted-foreground"
          />
        ),
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => <JobStatusBadge status={row.original.status} />,
      },
      {
        id: 'last',
        accessorFn: (job) => job.last_run?.started_at ?? '',
        header: 'Last run',
        cell: ({ row }) =>
          row.original.last_run ? (
            <div className="flex w-44 items-center gap-2">
              <SegmentedProgress counts={row.original.last_run} />
              <RelativeTime value={row.original.last_run.started_at} className="text-micro text-muted-foreground" />
            </div>
          ) : (
            <span className="text-subtle-foreground">Not yet</span>
          ),
      },
      {
        id: 'schedule',
        accessorFn: (job) => job.schedule.type,
        header: 'Schedule',
        cell: ({ row }) => (
          <span className="block max-w-56 truncate text-muted-foreground">
            {describeSchedule(row.original.schedule)}
          </span>
        ),
      },
    ],
    [],
  )
  return (
    <DataTable
      data={data?.items ?? []}
      columns={columns}
      loading={isLoading}
      getRowId={(job) => job.id}
      onRowClick={(job) => void navigate({ to: '/automation/jobs/$jobId', params: { jobId: job.id } })}
      caption="Jobs using this script"
      empty={
        <div className="p-6">
          <EmptyState
            compact
            illustration="automation"
            title="No jobs yet"
            description="Run this script to create its first job."
          />
        </div>
      }
    />
  )
}

export function ScriptPage({ scriptId, tab }: { scriptId: string | null; tab: ScriptTab }) {
  const isNew = scriptId === null
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const me = useMe()
  const { data: script, isLoading, error, refetch } = useQuery({ ...scriptQuery(scriptId ?? ''), enabled: !isNew })
  const base = useMemo(() => (script ? toDraft(script) : NEW_DRAFT), [script])
  const [edits, setEdits] = useState<{ for: string; draft: Draft } | null>(null)
  const [notes, setNotes] = useState('')
  const [attempted, setAttempted] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [cursor, setCursor] = useState({ line: 1, column: 1, lines: 1 })
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [preview, setPreview] = useState<Record<string, ParameterValue>>({})
  const key = scriptId ?? 'new'
  const draft = edits && edits.for === key ? edits.draft : base
  useTitle(isNew ? 'New script' : script?.name)

  const canManage = hasPermission(me, PERMISSIONS.scriptsManage)
  const canRun = hasPermission(me, PERMISSIONS.scriptsRun)
  const canApprove = hasPermission(me, PERMISSIONS.scriptsApprove)
  const readOnly = !canManage || Boolean(script?.builtin) || Boolean(script?.archived)
  const dirty = JSON.stringify(draft) !== JSON.stringify(base)
  const contentChanged =
    Boolean(script) &&
    (draft.content !== script!.content || JSON.stringify(draft.parameters) !== JSON.stringify(script!.parameters))
  const problems = draftProblems(draft)
  const paramIssues = validateParameterDefinitions(draft.parameters)
  const invalid = Object.values(problems).some(Boolean) || hasParameterIssues(paramIssues)

  const setDraft = (patch: Partial<Draft>) => setEdits({ for: key, draft: { ...draft, ...patch } })
  const discard = () => {
    setEdits(null)
    setNotes('')
    setAttempted(false)
  }
  const setTab = (next: string) => {
    const value = next === 'script' ? undefined : (next as ScriptTab)
    if (isNew)
      void navigate({ to: '/automation/scripts/new', search: (prev) => ({ ...prev, tab: value }), replace: true })
    else
      void navigate({
        to: '/automation/scripts/$scriptId',
        params: { scriptId: scriptId! },
        search: (prev) => ({ ...prev, tab: value }),
        replace: true,
      })
  }

  const afterChange = (updated: Script) => {
    queryClient.setQueryData(keys.script(updated.id), updated)
    void queryClient.invalidateQueries({ queryKey: keys.scripts })
  }

  const save = useMutation({
    mutationFn: () => {
      const body: ScriptInput = {
        ...draft,
        name: draft.name.trim(),
        category: draft.category.trim(),
        notes: notes.trim() || undefined,
      }
      return isNew ? scriptsApi.create(body) : scriptsApi.update(scriptId!, body)
    },
    onSuccess: (updated) => {
      afterChange(updated)
      discard()
      if (isNew) {
        toast.success(`Created “${updated.name}”`)
        void navigate({ to: '/automation/scripts/$scriptId', params: { scriptId: updated.id }, replace: true })
      } else toast.success(contentChanged ? `Saved as version ${updated.current_version}` : 'Details saved')
    },
  })

  const approve = useMutation({
    mutationFn: (version: number) => scriptsApi.approve(scriptId!, version),
    onSuccess: (updated, version) => {
      afterChange(updated)
      toast.success(`Version ${version} approved`)
    },
  })

  const duplicate = useMutation({
    mutationFn: () => scriptsApi.duplicate(scriptId!),
    onSuccess: (copy) => {
      afterChange(copy)
      toast.success(`Created “${copy.name}” — edit it freely`)
      void navigate({ to: '/automation/scripts/$scriptId', params: { scriptId: copy.id } })
    },
  })

  const archive = useMutation({
    mutationFn: () => scriptsApi.archive(scriptId!),
    onSuccess: () => {
      setArchiveOpen(false)
      void queryClient.invalidateQueries({ queryKey: keys.scripts })
      toast.success(`Archived “${script?.name}”`)
      void navigate({ to: '/automation/scripts' })
    },
  })

  if (error) {
    return (
      <PageContainer>
        <ErrorState
          error={error}
          title={isApiError(error) && error.status === 404 ? 'Script not found' : 'Could not load this script'}
          onRetry={() => void refetch()}
        />
      </PageContainer>
    )
  }

  if (!isNew && (isLoading || !script)) {
    return (
      <PageContainer className="grid grid-cols-1 gap-4">
        <Skeleton className="h-20 rounded-xl" />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <Skeleton className="h-[520px] rounded-xl" />
          <Skeleton className="h-[520px] rounded-xl" />
        </div>
      </PageContainer>
    )
  }

  const unapproved = script && !script.builtin && script.approved_version !== script.current_version
  const filename = `${slug(draft.name || 'new-script')}${LANGUAGES[draft.language].extension}`

  return (
    <div className="flex min-h-full flex-col">
      <UnsavedChangesGuard when={dirty && !save.isPending} what="script changes" />
      <PageContainer className="grid flex-1 grid-cols-1 content-start gap-5 pb-28">
        <header className="grid grid-cols-1 gap-4">
          <Link
            to="/automation/scripts"
            className="inline-flex w-fit items-center gap-1 text-dense text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Scripts
          </Link>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex min-w-0 items-start gap-3.5">
              <LanguageMark language={draft.language} size="lg" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="font-display truncate text-[22px] leading-tight font-semibold">
                    {isNew ? draft.name || 'New script' : script!.name}
                  </h1>
                  {script?.builtin && <BuiltinBadge />}
                  {script && !script.builtin && <ApprovalBadge script={script} />}
                  <RiskBadge risk={draft.risk} />
                  {script?.archived && <Badge variant="outline">Archived</Badge>}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-dense text-muted-foreground">
                  <span>{LANGUAGES[draft.language].label}</span>
                  <span className="text-subtle-foreground">·</span>
                  <PlatformIcons platforms={draft.platforms} />
                  <span className="text-subtle-foreground">·</span>
                  <span>{draft.category || 'Uncategorised'}</span>
                  {script && (
                    <>
                      <span className="text-subtle-foreground">·</span>
                      <span>
                        v{script.current_version} by {script.versions[0]?.created_by_name},{' '}
                        <RelativeTime value={script.updated_at} />
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
            {script && (
              <div className="flex flex-wrap items-center gap-2">
                {unapproved && canApprove && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={approve.isPending}
                    onClick={() => approve.mutate(script.current_version)}
                  >
                    {approve.isPending ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <ShieldCheck data-icon="inline-start" />
                    )}
                    Approve v{script.current_version}
                  </Button>
                )}
                {canManage && (
                  <Button variant="outline" size="sm" disabled={duplicate.isPending} onClick={() => duplicate.mutate()}>
                    {duplicate.isPending ? <Spinner data-icon="inline-start" /> : <CopyPlus data-icon="inline-start" />}
                    Duplicate
                  </Button>
                )}
                {canRun && !script.archived && (
                  <Button size="sm" disabled={dirty} onClick={() => openRunDialog({ scriptId: script.id })}>
                    <Play data-icon="inline-start" />
                    Run…
                  </Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="outline" size="icon-sm" aria-label="More actions" />}>
                    <Ellipsis />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem
                      onClick={async () => (await copyText(script.content_sha256)) && toast.success('SHA-256 copied')}
                    >
                      <Copy />
                      Copy SHA-256
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={async () => (await copyText(script.content)) && toast.success('Script copied')}
                    >
                      <FileCode />
                      Copy script
                    </DropdownMenuItem>
                    {canManage && !script.archived && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => setArchiveOpen(true)}>
                          <Archive />
                          Archive script…
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>
        </header>

        {script?.builtin && (
          <Banner
            icon={<Lock className="size-4" />}
            title="Built-in script — read-only"
            description="Built-in scripts are written and maintained for RustRMM and update with new releases. Duplicate it to change the code or parameters."
            action={
              canManage && (
                <Button size="sm" disabled={duplicate.isPending} onClick={() => duplicate.mutate()}>
                  <CopyPlus data-icon="inline-start" />
                  Duplicate to customise
                </Button>
              )
            }
          />
        )}

        <Tabs value={tab} onValueChange={(value) => setTab(String(value))} className="gap-4">
          <div className="-mx-4 [scrollbar-width:none] overflow-x-auto border-b border-border px-4 sm:-mx-6 sm:px-6">
            <TabsList variant="line" className="-mb-px h-10 w-max gap-4">
              <TabsTrigger value="script" className="flex-none px-0">
                Script
              </TabsTrigger>
              <TabsTrigger value="parameters" className="flex-none px-0">
                Parameters
                <span className="tabular text-micro text-subtle-foreground">{draft.parameters.length}</span>
              </TabsTrigger>
              {script && (
                <>
                  <TabsTrigger value="versions" className="flex-none px-0">
                    Versions
                    <span className="tabular text-micro text-subtle-foreground">{script.versions.length}</span>
                  </TabsTrigger>
                  <TabsTrigger value="runs" className="flex-none px-0">
                    Jobs
                  </TabsTrigger>
                </>
              )}
            </TabsList>
          </div>

          <TabsContent
            value="script"
            className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px] [&>*]:min-w-0"
          >
            <div className="flex min-w-0 flex-col overflow-hidden rounded-xl bg-card shadow-card">
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <code className="truncate font-mono text-[12px] text-muted-foreground">{filename}</code>
                {script && (
                  <Tooltip>
                    <TooltipTrigger render={<span className="hidden sm:inline-flex" />}>
                      <Mono className="text-[10.5px]">{truncateMiddle(script.content_sha256, 6)}</Mono>
                    </TooltipTrigger>
                    <TooltipContent>
                      SHA-256 of version {script.current_version}. The agent verifies it before running.
                    </TooltipContent>
                  </Tooltip>
                )}
                {contentChanged && <Badge variant="warning">Edited</Badge>}
                <div className="ml-auto flex items-center gap-1">
                  <span className="tabular hidden pr-2 text-micro text-subtle-foreground sm:inline">
                    Ln {cursor.line}, Col {cursor.column} · {formatNumber(cursor.lines)} lines
                  </span>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-pressed={wrap}
                          aria-label="Wrap lines"
                          className={cn(wrap && 'bg-surface-3 text-foreground')}
                          onClick={() => setWrap((value) => !value)}
                        />
                      }
                    >
                      <WrapText />
                    </TooltipTrigger>
                    <TooltipContent>Wrap long lines</TooltipContent>
                  </Tooltip>
                  <CopyButton value={draft.content} label="Copy script" />
                </div>
              </div>
              <CodeEditor
                value={draft.content}
                onChange={(content) => setDraft({ content })}
                language={draft.language}
                readOnly={readOnly}
                wrap={wrap}
                height="clamp(420px, calc(100dvh - 400px), 820px)"
                onCursor={setCursor}
                ariaLabel={`${draft.name || 'Script'} source`}
              />
              {attempted && problems.content && (
                <p className="border-t border-border px-3 py-2 text-dense text-critical">{problems.content}</p>
              )}
            </div>
            <DetailsCard
              draft={draft}
              setDraft={setDraft}
              readOnly={readOnly}
              problems={problems}
              attempted={attempted}
            />
          </TabsContent>

          <TabsContent
            value="parameters"
            className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px] [&>*]:min-w-0"
          >
            <div className="grid grid-cols-1 content-start gap-3">
              <p className="text-dense text-muted-foreground">
                Parameters reach the script as environment variables — read them with{' '}
                <code className="rounded-sm bg-surface-3 px-1 font-mono text-[11.5px]">
                  {draft.language === 'python'
                    ? 'os.environ["Name"]'
                    : draft.language === 'cmd'
                      ? '%Name%'
                      : draft.language.startsWith('p')
                        ? '$env:Name'
                        : '"$Name"'}
                </code>
                . Secret values are masked in output.
              </p>
              <ParameterBuilder
                parameters={draft.parameters}
                onChange={(parameters) => setDraft({ parameters })}
                issues={paramIssues}
                language={draft.language}
                readOnly={readOnly}
              />
            </div>
            <aside className="grid grid-cols-1 content-start gap-3 xl:sticky xl:top-4 xl:self-start">
              <div className="rounded-xl bg-card shadow-card">
                <div className="border-b border-border px-4 py-3">
                  <h3 className="text-sm font-semibold">Run form preview</h3>
                  <p className="text-micro text-muted-foreground">What people see when they run this script.</p>
                </div>
                <div className="p-4">
                  <ParameterForm
                    parameters={draft.parameters.filter(
                      (_, index) => Object.keys(paramIssues[index] ?? {}).length === 0,
                    )}
                    values={{ ...defaultParameterValues(draft.parameters), ...preview }}
                    onChange={(name, value) => setPreview((prev) => ({ ...prev, [name]: value }))}
                    idPrefix="preview"
                    columns={1}
                  />
                </div>
              </div>
            </aside>
          </TabsContent>

          {script && (
            <>
              <TabsContent value="versions">
                <ScriptVersions
                  script={script}
                  canApprove={canApprove}
                  approving={approve.isPending}
                  onApprove={(version) => approve.mutate(version)}
                  canRestore={!readOnly}
                  onRestore={(version) => {
                    setDraft({ content: version.content, parameters: version.parameters })
                    setNotes(`Restore version ${version.version}`)
                    setTab('script')
                    toast.info(
                      `Loaded version ${version.version} into the editor. Save to make it the current version.`,
                    )
                  }}
                />
              </TabsContent>
              <TabsContent value="runs">
                <ScriptRuns scriptId={script.id} />
              </TabsContent>
            </>
          )}
        </Tabs>
      </PageContainer>

      {(dirty || isNew) && !readOnly && (
        <div className="pointer-events-none sticky bottom-0 z-20 px-4 pb-4 sm:px-6">
          <div className="pointer-events-auto mx-auto flex max-w-[1392px] flex-col gap-3 rounded-xl bg-popover p-3 shadow-popover ring-1 ring-border-strong sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="relative flex size-2 shrink-0 rounded-full bg-warning" aria-hidden="true" />
              <div className="min-w-0 text-dense">
                <div className="font-medium">{isNew ? 'New script' : 'Unsaved changes'}</div>
                <div className="truncate text-micro text-muted-foreground">
                  {isNew
                    ? 'Creates version 1. Custom scripts start unapproved.'
                    : contentChanged
                      ? `Saving creates version ${script!.current_version + 1}; it needs approval before it is “approved”.`
                      : 'Only details changed — no new version.'}
                </div>
              </div>
            </div>
            {(isNew || contentChanged) && (
              <Input
                className="sm:max-w-64"
                value={notes}
                maxLength={200}
                placeholder="Version notes (what changed?)"
                onChange={(event) => setNotes(event.target.value)}
                aria-label="Version notes"
              />
            )}
            <div className="flex gap-2">
              {!isNew && (
                <Button variant="ghost" onClick={discard} disabled={save.isPending}>
                  <Undo2 data-icon="inline-start" />
                  Discard
                </Button>
              )}
              <Button
                onClick={() => {
                  setAttempted(true)
                  if (invalid) {
                    if (hasParameterIssues(paramIssues)) setTab('parameters')
                    toast.error('Fix the highlighted fields first')
                    return
                  }
                  save.mutate()
                }}
                disabled={save.isPending}
              >
                {save.isPending ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
                {isNew ? 'Create script' : 'Save'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {script && (
        <ConfirmDialog
          open={archiveOpen}
          onOpenChange={setArchiveOpen}
          title={`Archive “${script.name}”?`}
          description="Archived scripts disappear from the library and can't start new jobs. Their history, versions and running jobs are kept. You'll be asked to confirm it's you."
          confirmLabel="Archive script"
          pending={archive.isPending}
          onConfirm={() => archive.mutate()}
        />
      )}
    </div>
  )
}

function Banner({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl bg-info/[0.06] px-4 py-3 ring-1 ring-info/20">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-info/15 text-info">{icon}</span>
      <div className="min-w-0 flex-1 basis-64">
        <p className="text-dense font-medium">{title}</p>
        <p className="text-micro text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  )
}
