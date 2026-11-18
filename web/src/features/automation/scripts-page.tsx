import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { FileCode, LayoutGrid, List, ListFilter, Play, Plus, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Can } from '@/components/common/can'
import { DataTable } from '@/components/common/data-table'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState, RelativeTime } from '@/components/common/misc'
import { PageContainer, PageHeader } from '@/components/common/page-header'
import { SimpleSelect } from '@/components/common/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { scriptsQuery } from '@/lib/api/queries'
import type { OsFamily, ScriptLanguage, ScriptSummary } from '@/lib/api/types'
import { LANGUAGES, LANGUAGE_ORDER, PLATFORM_ORDER } from '@/lib/automation/labels'
import { OS_LABEL } from '@/lib/devices'
import { formatNumber } from '@/lib/format'
import { PERMISSIONS, hasPermission, useMe } from '@/lib/permissions'
import { useTitle } from '@/lib/use-title'
import { cn } from '@/lib/utils'
import { OsIcon } from '@/components/common/os-icon'
import { SearchField } from '@/features/devices/remote-ui'
import { ApprovalBadge, BuiltinBadge, LanguageMark, PlatformIcons, RiskBadge } from './automation-ui'
import { openRunDialog } from './run-dialog-store'
import { SEGMENTED } from './styles'

export interface ScriptsSearch {
  q?: string
  category?: string
  language?: string
  platform?: string
  source?: 'builtin' | 'custom'
  approval?: 'approved' | 'unapproved'
  archived?: boolean
  layout?: 'grid' | 'list'
  sort?: 'name' | 'updated' | 'run'
}

function matches(script: ScriptSummary, search: ScriptsSearch, skip?: keyof ScriptsSearch) {
  const q = search.q?.trim().toLowerCase()
  if (
    q &&
    !`${script.name} ${script.description} ${script.category} ${LANGUAGES[script.language].label}`
      .toLowerCase()
      .includes(q)
  )
    return false
  if (skip !== 'category' && search.category && script.category !== search.category) return false
  if (skip !== 'language' && search.language && script.language !== search.language) return false
  if (skip !== 'platform' && search.platform && !script.platforms.includes(search.platform as OsFamily)) return false
  if (skip !== 'source' && search.source && script.builtin !== (search.source === 'builtin')) return false
  if (skip !== 'approval' && search.approval) {
    const approved = script.approved_version === script.current_version
    if (approved !== (search.approval === 'approved')) return false
  }
  return true
}

function sortScripts(scripts: ScriptSummary[], sort: ScriptsSearch['sort']) {
  const list = [...scripts]
  if (sort === 'updated') return list.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  if (sort === 'run')
    return list.sort(
      (a, b) => (b.last_run?.at ?? '').localeCompare(a.last_run?.at ?? '') || a.name.localeCompare(b.name),
    )
  return list.sort((a, b) => a.name.localeCompare(b.name))
}

function FacetOption({
  active,
  onClick,
  label,
  count,
  icon,
}: {
  active: boolean
  onClick: () => void
  label: ReactNode
  count: number
  icon?: ReactNode
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={active}
        onClick={onClick}
        className={cn(
          'group flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-dense text-muted-foreground transition-colors outline-none hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
          active && 'bg-surface-3 font-medium text-foreground',
          count === 0 && !active && 'opacity-50',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'flex size-3.5 shrink-0 items-center justify-center rounded-full border transition-colors',
            active ? 'border-primary bg-primary' : 'border-border-strong group-hover:border-subtle-foreground',
          )}
        >
          {active && <span className="size-1.5 rounded-full bg-primary-foreground" />}
        </span>
        {icon}
        <span className="truncate">{label}</span>
        <span className="tabular ml-auto text-micro text-subtle-foreground">{formatNumber(count)}</span>
      </button>
    </li>
  )
}

function FacetSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="px-2 pb-1 text-micro font-medium text-subtle-foreground">{title}</h3>
      <ul className="grid grid-cols-1 gap-px">{children}</ul>
    </div>
  )
}

function Facets({
  scripts,
  search,
  onChange,
}: {
  scripts: ScriptSummary[]
  search: ScriptsSearch
  onChange: (next: ScriptsSearch) => void
}) {
  const count = (skip: keyof ScriptsSearch, test: (script: ScriptSummary) => boolean) =>
    scripts.filter((script) => matches(script, search, skip) && test(script)).length
  const categories = [...new Set(scripts.map((script) => script.category))].sort()
  const languages = LANGUAGE_ORDER.filter((language) => scripts.some((script) => script.language === language))
  const toggle = <K extends keyof ScriptsSearch>(key: K, value: ScriptsSearch[K]) =>
    onChange({ ...search, [key]: search[key] === value ? undefined : value })

  return (
    <div className="grid grid-cols-1 gap-5">
      <FacetSection title="Source">
        <FacetOption
          active={search.source === 'builtin'}
          onClick={() => toggle('source', 'builtin')}
          label="Built-in"
          count={count('source', (script) => script.builtin)}
        />
        <FacetOption
          active={search.source === 'custom'}
          onClick={() => toggle('source', 'custom')}
          label="Custom"
          count={count('source', (script) => !script.builtin)}
        />
      </FacetSection>
      <FacetSection title="Approval">
        <FacetOption
          active={search.approval === 'approved'}
          onClick={() => toggle('approval', 'approved')}
          label="Approved"
          count={count('approval', (script) => script.approved_version === script.current_version)}
        />
        <FacetOption
          active={search.approval === 'unapproved'}
          onClick={() => toggle('approval', 'unapproved')}
          label="Needs approval"
          count={count('approval', (script) => script.approved_version !== script.current_version)}
        />
      </FacetSection>
      <FacetSection title="Platform">
        {PLATFORM_ORDER.map((os) => (
          <FacetOption
            key={os}
            active={search.platform === os}
            onClick={() => toggle('platform', os)}
            icon={<OsIcon family={os} />}
            label={OS_LABEL[os]}
            count={count('platform', (script) => script.platforms.includes(os))}
          />
        ))}
      </FacetSection>
      <FacetSection title="Language">
        {languages.map((language) => (
          <FacetOption
            key={language}
            active={search.language === language}
            onClick={() => toggle('language', language)}
            icon={<LanguageMark language={language} size="sm" />}
            label={LANGUAGES[language].label}
            count={count('language', (script) => script.language === language)}
          />
        ))}
      </FacetSection>
      <FacetSection title="Category">
        {categories.map((category) => (
          <FacetOption
            key={category}
            active={search.category === category}
            onClick={() => toggle('category', category)}
            label={category}
            count={count('category', (script) => script.category === category)}
          />
        ))}
      </FacetSection>
      <label className="flex items-center justify-between gap-2 px-2 text-dense text-muted-foreground">
        Show archived
        <Switch
          size="sm"
          checked={Boolean(search.archived)}
          onCheckedChange={(checked) => onChange({ ...search, archived: checked || undefined })}
        />
      </label>
    </div>
  )
}

function LastRun({ script }: { script: ScriptSummary }) {
  if (!script.last_run) return <span className="text-micro text-subtle-foreground">Never run</span>
  const { succeeded, failed } = script.last_run
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex items-center gap-1.5 text-micro text-muted-foreground" />}>
        <span className="tabular text-success">{formatNumber(succeeded)} ok</span>
        {failed > 0 && <span className="tabular text-critical">{formatNumber(failed)} failed</span>}
        <span className="text-subtle-foreground">·</span>
        <RelativeTime value={script.last_run.at} />
      </TooltipTrigger>
      <TooltipContent>Last run</TooltipContent>
    </Tooltip>
  )
}

function ScriptCard({ script, canRun }: { script: ScriptSummary; canRun: boolean }) {
  return (
    <div className="group relative">
      <Link
        to="/automation/scripts/$scriptId"
        params={{ scriptId: script.id }}
        className={cn(
          'flex h-full flex-col gap-3 rounded-xl bg-card p-4 shadow-card transition-[box-shadow,transform] duration-150 outline-none hover:shadow-[0_0_0_1px_var(--border-strong),0_6px_18px_-8px_rgb(0_0_0/0.18)] focus-visible:ring-2 focus-visible:ring-ring',
          script.archived && 'opacity-60',
        )}
      >
        <div className="flex items-start gap-3 pr-16">
          <LanguageMark language={script.language} />
          <div className="min-w-0">
            <div className="truncate leading-snug font-medium">{script.name}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-micro text-subtle-foreground">
              <span className="truncate">{script.category}</span>
              <span>·</span>
              <PlatformIcons platforms={script.platforms} />
            </div>
          </div>
        </div>
        <p className="line-clamp-2 min-h-10 text-dense text-muted-foreground">
          {script.description || 'No description.'}
        </p>
        <div className="mt-auto flex flex-wrap items-center gap-1.5">
          {script.builtin ? <BuiltinBadge /> : <ApprovalBadge script={script} compact />}
          <RiskBadge risk={script.risk} />
          {script.archived && <Badge variant="outline">Archived</Badge>}
          <span className="ml-auto">
            <LastRun script={script} />
          </span>
        </div>
      </Link>
      {canRun && !script.archived && (
        <Button
          size="xs"
          variant="outline"
          className="absolute top-3.5 right-3.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 max-md:opacity-100"
          onClick={() => openRunDialog({ scriptId: script.id })}
        >
          <Play data-icon="inline-start" />
          Run
        </Button>
      )}
    </div>
  )
}

export function ScriptsPage({ search }: { search: ScriptsSearch }) {
  useTitle('Scripts')
  const navigate = useNavigate()
  const me = useMe()
  const canRun = hasPermission(me, PERMISSIONS.scriptsRun)
  const { data, isLoading, error, refetch } = useQuery(scriptsQuery(Boolean(search.archived)))
  const [filtersOpen, setFiltersOpen] = useState(false)
  const scripts = useMemo(() => data ?? [], [data])
  const filtered = useMemo(
    () =>
      sortScripts(
        scripts.filter((script) => matches(script, search)),
        search.sort,
      ),
    [scripts, search],
  )
  const view = search.layout ?? 'grid'
  const builtins = scripts.filter((script) => script.builtin).length

  const setSearch = (next: ScriptsSearch) =>
    void navigate({
      to: '/automation/scripts',
      search: (prev) => ({ client: prev.client, site: prev.site, ...next }),
      replace: true,
    })

  const activeChips: { key: keyof ScriptsSearch; label: ReactNode }[] = []
  if (search.source) activeChips.push({ key: 'source', label: search.source === 'builtin' ? 'Built-in' : 'Custom' })
  if (search.approval)
    activeChips.push({ key: 'approval', label: search.approval === 'approved' ? 'Approved' : 'Needs approval' })
  if (search.platform)
    activeChips.push({ key: 'platform', label: OS_LABEL[search.platform as OsFamily] ?? search.platform })
  if (search.language)
    activeChips.push({ key: 'language', label: LANGUAGES[search.language as ScriptLanguage]?.label ?? search.language })
  if (search.category) activeChips.push({ key: 'category', label: search.category })

  const columns = useMemo<ColumnDef<ScriptSummary>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (script) => script.name.toLowerCase(),
        header: 'Script',
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2.5">
            <LanguageMark language={row.original.language} size="sm" />
            <div className="min-w-0 leading-tight">
              <div className="max-w-80 truncate font-medium">{row.original.name}</div>
              <div className="max-w-80 truncate text-[10.5px] text-subtle-foreground">{row.original.description}</div>
            </div>
          </div>
        ),
      },
      {
        id: 'category',
        accessorKey: 'category',
        header: 'Category',
        cell: ({ getValue }) => <span className="text-muted-foreground">{getValue<string>()}</span>,
      },
      {
        id: 'platforms',
        accessorFn: (script) => script.platforms.join(','),
        header: 'Platforms',
        enableSorting: false,
        cell: ({ row }) => <PlatformIcons platforms={row.original.platforms} />,
      },
      {
        id: 'state',
        accessorFn: (script) => (script.builtin ? 0 : script.approved_version === script.current_version ? 1 : 2),
        header: 'State',
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            {row.original.builtin ? <BuiltinBadge /> : <ApprovalBadge script={row.original} compact />}
            <RiskBadge risk={row.original.risk} />
          </span>
        ),
      },
      {
        id: 'run',
        accessorFn: (script) => script.last_run?.at ?? '',
        header: 'Last run',
        cell: ({ row }) => <LastRun script={row.original} />,
      },
      {
        id: 'updated',
        accessorKey: 'updated_at',
        header: 'Updated',
        cell: ({ getValue }) => <RelativeTime value={getValue<string>()} className="text-muted-foreground" />,
      },
    ],
    [],
  )

  return (
    <PageContainer className="grid grid-cols-1 gap-5">
      <PageHeader
        icon={<FileCode />}
        title="Scripts"
        description={
          scripts.length
            ? `${formatNumber(builtins)} built-in and ${formatNumber(scripts.length - builtins)} custom scripts. Run one on a device, a group, a site or a whole client.`
            : 'Reusable PowerShell, shell and Python scripts with typed parameters and version history.'
        }
        actions={
          <Can permission={PERMISSIONS.scriptsManage}>
            <Button size="sm" render={<Link to="/automation/scripts/new" />} nativeButton={false}>
              <Plus data-icon="inline-start" />
              New script
            </Button>
          </Can>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[216px_minmax(0,1fr)]">
        <aside className="hidden lg:block" aria-label="Filter scripts">
          <div className="sticky top-0">
            {isLoading ? (
              <Skeleton className="h-96 rounded-xl" />
            ) : (
              <Facets scripts={scripts} search={search} onChange={setSearch} />
            )}
          </div>
        </aside>

        <div className="grid min-w-0 grid-cols-1 content-start gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <SearchField
              value={search.q ?? ''}
              onChange={(q) => setSearch({ ...search, q: q || undefined })}
              placeholder="Search scripts…"
              label="Search scripts"
              className="sm:w-72"
            />
            <Button variant="outline" size="sm" className="lg:hidden" onClick={() => setFiltersOpen(true)}>
              <ListFilter data-icon="inline-start" />
              Filters
              {activeChips.length > 0 && <Badge className="ml-0.5 h-4 px-1">{activeChips.length}</Badge>}
            </Button>
            <span className="tabular text-dense text-muted-foreground">
              {formatNumber(filtered.length)} of {formatNumber(scripts.length)}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <SimpleSelect
                size="sm"
                className="w-40"
                ariaLabel="Sort scripts"
                value={search.sort ?? 'name'}
                onValueChange={(value) =>
                  setSearch({ ...search, sort: value === 'name' ? undefined : (value as ScriptsSearch['sort']) })
                }
                options={[
                  { value: 'name', label: 'Name' },
                  { value: 'updated', label: 'Recently updated' },
                  { value: 'run', label: 'Recently run' },
                ]}
              />
              <ToggleGroup
                className={SEGMENTED}
                value={[view]}
                onValueChange={(value) => {
                  const next = value[0] as 'grid' | 'list' | undefined
                  if (next) setSearch({ ...search, layout: next === 'grid' ? undefined : next })
                }}
                variant="outline"
                size="sm"
                aria-label="Layout"
              >
                <ToggleGroupItem value="grid" aria-label="Grid">
                  <LayoutGrid />
                </ToggleGroupItem>
                <ToggleGroupItem value="list" aria-label="List">
                  <List />
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>

          {activeChips.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {activeChips.map((chip) => (
                <span
                  key={chip.key}
                  className="inline-flex h-6 items-center gap-1.5 rounded-full bg-primary/10 pr-0.5 pl-2.5 text-micro font-medium ring-1 ring-primary/25"
                >
                  {chip.label}
                  <button
                    type="button"
                    aria-label="Remove filter"
                    onClick={() => setSearch({ ...search, [chip.key]: undefined })}
                    className="flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-primary/15 hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setSearch({ q: search.q, layout: search.layout, sort: search.sort })}
              >
                Clear all
              </Button>
            </div>
          )}

          {error ? (
            <ErrorState error={error} onRetry={() => void refetch()} />
          ) : isLoading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
              {Array.from({ length: 9 }, (_, index) => (
                <Skeleton key={index} className="h-40 rounded-xl" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              illustration="search"
              title="No scripts match"
              description="Try another search or remove a filter."
              actions={
                <Button variant="outline" size="sm" onClick={() => setSearch({ layout: search.layout })}>
                  Clear filters
                </Button>
              }
            />
          ) : view === 'grid' ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
              {filtered.map((script) => (
                <ScriptCard key={script.id} script={script} canRun={canRun} />
              ))}
            </div>
          ) : (
            <DataTable
              data={filtered}
              columns={columns}
              getRowId={(script) => script.id}
              onRowClick={(script) =>
                void navigate({ to: '/automation/scripts/$scriptId', params: { scriptId: script.id } })
              }
              caption="Scripts"
            />
          )}
        </div>
      </div>

      <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
        <SheetContent side="left" className="w-[300px] gap-0 p-0">
          <SheetHeader className="border-b border-border px-4 py-3">
            <SheetTitle>Filter scripts</SheetTitle>
          </SheetHeader>
          <div className="overflow-y-auto px-2 py-3">
            <Facets scripts={scripts} search={search} onChange={setSearch} />
          </div>
        </SheetContent>
      </Sheet>
    </PageContainer>
  )
}
