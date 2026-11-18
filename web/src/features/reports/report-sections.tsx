/* Renders report `Section`s in the console: KPI tiles, sortable tables, charts, text and lists. */
import { useMemo, useState, type ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts'
import { ArrowDown, ArrowUp, ArrowUpDown, CircleCheck, CircleX, Lightbulb, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ChartContainer, type ChartConfig } from '@/components/ui/chart'
import { Input } from '@/components/ui/input'
import type { ReportSection } from '@/lib/api/types'
import { formatNumber } from '@/lib/format'
import {
  cartesianData,
  cellTone,
  chartTotal,
  columnAlign,
  donutData,
  formatCell,
  formatChartValue,
  formatKpi,
  kpiTone,
  nextSort,
  paragraphs,
  sectionAnchor,
  seriesKey,
  sortRows,
  type TableSort,
} from '@/lib/reports/sections'
import { cn } from '@/lib/utils'

const PALETTE = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)']
const NAMED: Record<string, string> = { critical: 'var(--critical)', warning: 'var(--warning)', info: 'var(--info)', pass: 'var(--success)', fail: 'var(--critical)' }

function colorFor(name: string, index: number) {
  return NAMED[name.toLowerCase()] ?? PALETTE[index % PALETTE.length]
}

const TONE_CLASS = {
  good: { text: 'text-success', bar: 'bg-success' },
  warn: { text: 'text-warning', bar: 'bg-warning' },
  bad: { text: 'text-critical', bar: 'bg-critical' },
  neutral: { text: 'text-foreground', bar: 'bg-border-strong' },
}

function SectionFrame({ section, index, children, aside }: { section: ReportSection; index: number; children: ReactNode; aside?: ReactNode }) {
  return (
    <section id={sectionAnchor(section.title, index)} aria-labelledby={`${sectionAnchor(section.title, index)}-title`} className="min-w-0 scroll-mt-4 overflow-hidden rounded-xl bg-card shadow-card break-inside-avoid">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 id={`${sectionAnchor(section.title, index)}-title`} className="text-sm font-semibold tracking-tight">
          {section.title}
        </h2>
        {aside}
      </header>
      {children}
    </section>
  )
}

function KpiSection({ section, index }: { section: Extract<ReportSection, { kind: 'kpis' }>; index: number }) {
  return (
    <SectionFrame section={section} index={index}>
      <div className="overflow-hidden">
      <dl className="-mr-px -mb-px grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
        {section.items.map((item) => {
          const tone = kpiTone(item)
          return (
            <div key={item.label} className="relative flex min-w-0 flex-col gap-1 border-r border-b border-border px-4 py-3">
              <span aria-hidden className={cn('absolute top-3 bottom-3 left-0 w-0.5 rounded-r-full', TONE_CLASS[tone].bar, tone === 'neutral' && 'opacity-0')} />
              <dt className="truncate text-micro text-muted-foreground">{item.label}</dt>
              <dd className={cn('font-display tabular truncate text-[20px] leading-tight font-semibold tracking-tight', TONE_CLASS[tone].text)}>{formatKpi(item)}</dd>
            </div>
          )
        })}
      </dl>
      </div>
    </SectionFrame>
  )
}

const PAGE = 50

function TableSection({ section, index }: { section: Extract<ReportSection, { kind: 'table' }>; index: number }) {
  const [sort, setSort] = useState<TableSort | null>(null)
  const [filter, setFilter] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const needle = filter.trim().toLowerCase()
  const rows = useMemo(() => {
    const filtered = needle ? section.rows.filter((row) => row.some((cell) => cell !== null && String(cell).toLowerCase().includes(needle))) : section.rows
    return sortRows(filtered, section.columns, sort)
  }, [section, sort, needle])
  const shown = rows.slice(0, limit)
  const truncated = section.total_rows && section.total_rows > section.rows.length

  return (
    <SectionFrame
      section={section}
      index={index}
      aside={
        section.rows.length > 8 && (
          <div className="relative w-full sm:w-56">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-subtle-foreground" />
            <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter rows…" aria-label={`Filter ${section.title}`} className="h-7 pl-7 text-dense" />
          </div>
        )
      }
    >
      {section.rows.length === 0 ? (
        <p className="px-4 py-5 text-dense text-muted-foreground">Nothing to list for this period.</p>
      ) : (
        <>
          <div className="max-h-[560px] overflow-auto">
            <table className="w-full min-w-max border-collapse text-dense">
              <caption className="sr-only">{section.title}</caption>
              <thead className="sticky top-0 z-[1] bg-surface-2">
                <tr>
                  {section.columns.map((column, columnIndex) => {
                    const active = sort?.column === columnIndex
                    const align = columnAlign(column)
                    return (
                      <th key={column.key} scope="col" aria-sort={active ? (sort!.desc ? 'descending' : 'ascending') : 'none'} className={cn('border-b border-border px-3 py-2 font-medium whitespace-nowrap text-muted-foreground', align === 'right' ? 'text-right' : 'text-left')}>
                        <button
                          type="button"
                          onClick={() => setSort(nextSort(sort, columnIndex, section.columns))}
                          className={cn('inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring', align === 'right' && 'flex-row-reverse', active && 'text-foreground')}
                        >
                          {column.label}
                          {active ? sort!.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" /> : <ArrowUpDown className="size-3 opacity-40" />}
                        </button>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {shown.map((row, rowIndex) => (
                  <tr key={rowIndex} className="border-b border-border last:border-b-0 even:bg-surface-1/40 hover:bg-surface-2">
                    {section.columns.map((column, columnIndex) => {
                      const value = row[columnIndex] ?? null
                      const tone = cellTone(value)
                      return (
                        <td key={column.key} className={cn('max-w-80 truncate px-3 py-1.5', columnAlign(column) === 'right' ? 'tabular text-right' : 'text-left', value === null && 'text-subtle-foreground')} title={value === null ? undefined : String(value)}>
                          {tone ? (
                            <span className={cn('inline-flex items-center gap-1 font-medium', tone === 'good' ? 'text-success' : 'text-critical')}>
                              {tone === 'good' ? <CircleCheck className="size-3.5" /> : <CircleX className="size-3.5" />}
                              {formatCell(value, column.format)}
                            </span>
                          ) : (
                            formatCell(value, column.format)
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 text-micro text-muted-foreground">
            <span className="tabular">
              {needle ? `${formatNumber(rows.length)} of ${formatNumber(section.rows.length)} rows match` : `${formatNumber(section.rows.length)} ${section.rows.length === 1 ? 'row' : 'rows'}`}
              {truncated && ` · ${formatNumber(section.total_rows!)} in total — the CSV has every row`}
            </span>
            {rows.length > limit && (
              <Button variant="ghost" size="xs" onClick={() => setLimit((value) => value + PAGE * 4)}>
                Show {formatNumber(Math.min(PAGE * 4, rows.length - limit))} more
              </Button>
            )}
          </footer>
        </>
      )}
    </SectionFrame>
  )
}

interface TooltipItem {
  dataKey?: unknown
  name?: unknown
  value?: unknown
  color?: string
  payload?: { fill?: string }
}

function ChartTip({ active, payload, label, names, unit }: { active?: boolean; payload?: readonly TooltipItem[]; label?: unknown; names: Record<string, string>; unit?: string | null }) {
  if (!active || !payload?.length) return null
  return (
    <div className="grid min-w-36 gap-1.5 rounded-lg border border-border/60 bg-popover px-2.5 py-1.5 text-xs shadow-popover">
      {label !== undefined && <div className="font-medium">{String(label)}</div>}
      {payload.map((item) => {
        const key = String(item.dataKey ?? item.name)
        return (
          <div key={key} className="flex items-center gap-2">
            <span className="size-2.5 rounded-[2px]" style={{ background: item.color ?? item.payload?.fill }} />
            <span className="flex-1 text-muted-foreground">{names[key] ?? String(item.name ?? key)}</span>
            <span className="font-mono font-medium tabular-nums">{typeof item.value === 'number' ? formatChartValue(item.value, unit) : '—'}</span>
          </div>
        )
      })}
    </div>
  )
}

function ChartSection({ section, index }: { section: Extract<ReportSection, { kind: 'chart' }>; index: number }) {
  const total = chartTotal(section)
  if (section.chart === 'donut') return <DonutSection section={section} index={index} />
  const data = cartesianData(section)
  const config: ChartConfig = Object.fromEntries(section.series.map((series, seriesIndex) => [seriesKey(seriesIndex), { label: series.name, color: colorFor(series.name, seriesIndex) }]))
  const names = Object.fromEntries(section.series.map((series, seriesIndex) => [seriesKey(seriesIndex), series.name]))
  const stacked = section.chart === 'bar' && section.series.length > 1
  const dense = section.labels.length > 14
  return (
    <SectionFrame
      section={section}
      index={index}
      aside={
        section.series.length > 1 && (
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-micro text-muted-foreground">
            {section.series.map((series, seriesIndex) => (
              <li key={series.name} className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-[2px]" style={{ background: colorFor(series.name, seriesIndex) }} />
                {series.name}
              </li>
            ))}
          </ul>
        )
      }
    >
      {total === 0 && section.chart === 'bar' ? (
        <p className="px-4 py-5 text-dense text-muted-foreground">Nothing happened in this period.</p>
      ) : (
        <div className="px-2 pt-3 pb-2" role="img" aria-label={`${section.title}: ${section.series.map((series) => series.name).join(', ')} over ${section.labels.length} points`}>
          <ChartContainer config={config} className="aspect-auto h-60 w-full">
            {section.chart === 'line' ? (
              <LineChart data={data} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 4" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
                <YAxis tickLine={false} axisLine={false} width={40} domain={['auto', 'auto']} />
                <ChartTooltip content={(props) => <ChartTip active={props.active} payload={props.payload as readonly TooltipItem[]} label={props.label} names={names} unit={section.unit} />} />
                {section.series.map((series, seriesIndex) => (
                  <Line key={series.name} dataKey={seriesKey(seriesIndex)} type="monotone" stroke={`var(--color-${seriesKey(seriesIndex)})`} strokeWidth={2} dot={false} isAnimationActive={false} />
                ))}
              </LineChart>
            ) : (
              <BarChart data={data} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 4" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={dense ? 16 : 4} interval="preserveStartEnd" />
                <YAxis tickLine={false} axisLine={false} width={36} allowDecimals={false} />
                <ChartTooltip cursor={{ fillOpacity: 0.5 }} content={(props) => <ChartTip active={props.active} payload={props.payload as readonly TooltipItem[]} label={props.label} names={names} unit={section.unit} />} />
                {section.series.map((series, seriesIndex) => (
                  <Bar
                    key={series.name}
                    dataKey={seriesKey(seriesIndex)}
                    stackId={stacked ? 'stack' : undefined}
                    fill={`var(--color-${seriesKey(seriesIndex)})`}
                    radius={stacked ? (seriesIndex === section.series.length - 1 ? [3, 3, 0, 0] : 0) : [3, 3, 0, 0]}
                    maxBarSize={36}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            )}
          </ChartContainer>
        </div>
      )}
    </SectionFrame>
  )
}

function DonutSection({ section, index }: { section: Extract<ReportSection, { kind: 'chart' }>; index: number }) {
  const slices = donutData(section)
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  const config: ChartConfig = Object.fromEntries(slices.map((slice, sliceIndex) => [slice.key, { label: slice.label, color: PALETTE[sliceIndex % PALETTE.length] }]))
  return (
    <SectionFrame section={section} index={index}>
      {total === 0 ? (
        <p className="px-4 py-5 text-dense text-muted-foreground">No data for this period.</p>
      ) : (
        <div className="grid items-center gap-4 p-4 sm:grid-cols-[200px_minmax(0,1fr)]">
          <div className="relative mx-auto size-[180px]" role="img" aria-label={`${section.title}: ${slices.map((slice) => `${slice.label} ${Math.round(slice.share * 100)}%`).join(', ')}`}>
            <ChartContainer config={config} className="aspect-square size-full">
              <PieChart>
                <ChartTooltip content={(props) => <ChartTip active={props.active} payload={props.payload as readonly TooltipItem[]} names={Object.fromEntries(slices.map((slice) => [slice.label, slice.label]))} unit={section.unit} />} />
                <Pie data={slices} dataKey="value" nameKey="label" innerRadius={58} outerRadius={84} paddingAngle={1.5} strokeWidth={0} isAnimationActive={false}>
                  {slices.map((slice) => (
                    <Cell key={slice.key} fill={`var(--color-${slice.key})`} />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="font-display tabular text-xl font-semibold">{formatNumber(total)}</span>
              <span className="text-micro text-muted-foreground">{section.series[0]?.name ?? 'Total'}</span>
            </div>
          </div>
          <ul className="grid min-w-0 gap-1.5">
            {slices.map((slice, sliceIndex) => (
              <li key={slice.key} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 text-dense">
                <span className="size-2.5 rounded-[3px]" style={{ background: PALETTE[sliceIndex % PALETTE.length] }} />
                <span className="truncate">{slice.label}</span>
                <span className="tabular text-muted-foreground">
                  {formatNumber(slice.value)} <span className="text-subtle-foreground">· {Math.round(slice.share * 100)}%</span>
                </span>
                <span className="col-span-3 col-start-2 h-1 overflow-hidden rounded-full bg-surface-3">
                  <span className="block h-full rounded-full" style={{ width: `${Math.max(2, slice.share * 100)}%`, background: PALETTE[sliceIndex % PALETTE.length] }} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionFrame>
  )
}

function TextSection({ section, index }: { section: Extract<ReportSection, { kind: 'text' }>; index: number }) {
  return (
    <SectionFrame section={section} index={index}>
      <div className="grid max-w-3xl gap-3 px-4 py-3.5 text-sm leading-relaxed text-secondary-foreground">
        {paragraphs(section.body).map((paragraph, paragraphIndex) => (
          <p key={paragraphIndex} className="whitespace-pre-line">
            {paragraph}
          </p>
        ))}
      </div>
    </SectionFrame>
  )
}

function ListSection({ section, index }: { section: Extract<ReportSection, { kind: 'list' }>; index: number }) {
  const recommendations = /recommend/i.test(section.title)
  return (
    <SectionFrame section={section} index={index}>
      <ul className="grid gap-px bg-border">
        {section.items.map((item, itemIndex) => (
          <li key={itemIndex} className="flex items-start gap-2.5 bg-card px-4 py-2.5 text-dense">
            {recommendations ? <Lightbulb className="mt-0.5 size-4 shrink-0 text-warning" /> : <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />}
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
    </SectionFrame>
  )
}

/** Renders a report's sections in order; KPI blocks and short charts pair up on wide screens. */
export function ReportSections({ sections }: { sections: ReportSection[] }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4">
      {sections.map((section, index) => {
        const key = `${index}-${section.title}`
        switch (section.kind) {
          case 'kpis':
            return <KpiSection key={key} section={section} index={index} />
          case 'table':
            return <TableSection key={key} section={section} index={index} />
          case 'chart':
            return <ChartSection key={key} section={section} index={index} />
          case 'text':
            return <TextSection key={key} section={section} index={index} />
          case 'list':
            return <ListSection key={key} section={section} index={index} />
          default:
            return null
        }
      })}
    </div>
  )
}
