/* Running reports to files: direct downloads, `202` queued runs polled to completion, and history downloads. */
import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { saveBlob } from '@/lib/api/client'
import { reportsApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { platformKeys } from '@/lib/api/queries'
import type { ReportRun, ReportRunRequest } from '@/lib/api/types'
import { FORMAT_LABEL } from './report-meta'

const POLL_MS = 2_000
const POLL_LIMIT_MS = 10 * 60_000

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer)
      reject(new DOMException('Cancelled', 'AbortError'))
    })
  })

/** Polls `GET /report-runs/{id}` until the run completes or fails (generation is cut off at 120 s server-side). */
export async function waitForRun(runId: string, options: { signal?: AbortSignal; onUpdate?: (run: ReportRun) => void } = {}): Promise<ReportRun> {
  const started = Date.now()
  for (;;) {
    const run = await reportsApi.getRun(runId)
    options.onUpdate?.(run)
    if (run.status === 'completed' || run.status === 'failed') return run
    if (Date.now() - started > POLL_LIMIT_MS) throw new Error('The report is taking unusually long. Check Run history later.')
    await sleep(POLL_MS, options.signal)
  }
}

export function useReportFiles() {
  const queryClient = useQueryClient()
  const refresh = useCallback(() => void queryClient.invalidateQueries({ queryKey: platformKeys.reportRuns }), [queryClient])

  /** Downloads a finished run's file. */
  const downloadRun = useCallback(
    async (run: Pick<ReportRun, 'id' | 'type' | 'format' | 'file_name'>) => {
      try {
        const file = await reportsApi.downloadRun(run.id, run.file_name ?? `${run.type.replace(/_/g, '-')}.${run.format}`)
        saveBlob(file.blob, file.file_name)
      } catch (error) {
        toast.error(isApiError(error) && error.code === 'not_ready' ? 'The report is still being generated.' : isApiError(error) && error.status === 404 ? 'That file is no longer available (outputs are kept 30 days).' : errorMessage(error))
      }
    },
    [],
  )

  /** Runs a CSV/PDF report: saves the file at once, or follows a queued run and saves it when ready. */
  const runFile = useCallback(
    async (body: ReportRunRequest, title: string) => {
      const label = FORMAT_LABEL[body.format]
      const toastId = toast.loading(`Generating ${title} (${label})…`)
      try {
        const outcome = await reportsApi.run(body)
        refresh()
        if (outcome.kind === 'file') {
          saveBlob(outcome.blob, outcome.file_name)
          toast.success(`${title} downloaded`, { id: toastId, description: outcome.file_name })
          return
        }
        if (outcome.kind === 'report') {
          toast.dismiss(toastId)
          return
        }
        toast.loading(`${title} is queued`, { id: toastId, description: 'Large reports are generated in the background. You can keep working.' })
        const run = await waitForRun(outcome.run_id, {
          onUpdate: (next) => next.status === 'running' && toast.loading(`Generating ${title}…`, { id: toastId, description: 'It downloads automatically when it is ready.' }),
        })
        refresh()
        if (run.status === 'failed') {
          toast.error(`${title} failed`, { id: toastId, description: run.error ?? 'The server could not generate the report.' })
          return
        }
        const file = await reportsApi.downloadRun(run.id, run.file_name ?? `${body.type}.${body.format}`)
        saveBlob(file.blob, file.file_name)
        toast.success(`${title} downloaded`, { id: toastId, description: file.file_name })
      } catch (error) {
        toast.error(`Could not generate ${title}`, { id: toastId, description: errorMessage(error) })
      }
    },
    [refresh],
  )

  return { runFile, downloadRun }
}
