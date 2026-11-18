import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { metricsQuery } from '@/lib/api/queries'
import type { DeviceCheck } from '@/lib/api/types'
import { formatCheckValue } from '@/lib/monitoring/labels'
import { cn } from '@/lib/utils'
import { checkHistory, recordCheckValue } from './alert-stores'
import { Sparkline } from './monitoring-ui'

/** Check types whose value maps onto the device's metric history. */
type MetricPick = (point: { cpu: number | null; mem: number | null; disk: number | null }) => number | null

const METRIC: Partial<Record<string, MetricPick>> = {
  cpu: (point) => point.cpu,
  memory: (point) => point.mem,
  disk: (point) => (point.disk === null ? null : Math.round((100 - point.disk) * 10) / 10),
}

/**
 * The value of a numeric check with a sparkline. CPU, memory and disk checks use the device's last
 * 24 hours of metrics; other numeric checks use the values seen while this console was open.
 */
export function CheckTrend({
  deviceId,
  check,
  width = 88,
  height = 22,
  className,
  showValue = true,
}: {
  deviceId: string
  check: Pick<DeviceCheck, 'check_id' | 'type' | 'value' | 'state' | 'last_at'>
  width?: number
  height?: number
  className?: string
  showValue?: boolean
}) {
  const metric = METRIC[check.type]
  const { data } = useQuery({ ...metricsQuery(deviceId, '24h'), enabled: Boolean(metric) && check.value !== null, meta: { silent: true } })
  const values = useMemo(() => {
    if (metric) {
      const series = (data?.points ?? []).map(metric).filter((value): value is number => value !== null)
      // Thin the series so the line stays readable at sparkline size.
      const step = Math.max(1, Math.floor(series.length / 48))
      const thinned = series.filter((_, index) => index % step === 0)
      return check.value !== null ? [...thinned, check.value] : thinned
    }
    // Remembering each observed value is idempotent, so doing it while deriving the series is safe.
    recordCheckValue(deviceId, check.check_id, check.value, check.last_at)
    return checkHistory(deviceId, check.check_id)
  }, [metric, data, check.value, check.last_at, deviceId, check.check_id])

  if (check.value === null) return <span className={cn('text-subtle-foreground', className)}>—</span>
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2', className)}>
      {values.length >= 2 && (
        <Sparkline values={values} state={check.state} width={width} height={height} label={`${check.type} trend`} />
      )}
      {showValue && <span className="tabular text-dense font-medium whitespace-nowrap">{formatCheckValue(check.type, check.value)}</span>}
    </span>
  )
}
