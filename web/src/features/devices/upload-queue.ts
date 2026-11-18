/* Upload queue for the remote file browser: XHR uploads with progress, conflicts and retries. */
import { useSyncExternalStore } from 'react'
import { remoteApi } from '@/lib/api/endpoints'
import { errorMessage, isApiError } from '@/lib/api/errors'
import { joinPath, type PathStyle } from '@/lib/remote'

export type UploadStatus = 'queued' | 'uploading' | 'finishing' | 'done' | 'failed' | 'conflict' | 'cancelled' | 'skipped'

export interface UploadItem {
  id: string
  file: File
  dir: string
  target: string
  status: UploadStatus
  loaded: number
  total: number
  overwrite: boolean
  error: string | null
  /** Smoothed bytes per second while uploading. */
  rate: number | null
}

const CONCURRENCY = 2
let counter = 0

/** A 422 for an existing target (the agent's wording varies, so match loosely). */
export function isExistsError(error: unknown): boolean {
  if (!isApiError(error)) return false
  if (error.code === 'already_exists' || error.code === 'conflict') return true
  return error.status === 422 && /exist/i.test(error.message)
}

export class UploadQueue {
  private items: UploadItem[] = []
  private listeners = new Set<() => void>()
  private controllers = new Map<string, AbortController>()
  private samples = new Map<string, { at: number; loaded: number }>()
  private policy: 'ask' | 'replace' | 'skip' = 'ask'
  private deviceId: string
  private style: PathStyle
  private uploadedListeners = new Set<(dir: string) => void>()

  constructor(deviceId: string, style: PathStyle) {
    this.deviceId = deviceId
    this.style = style
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = () => this.items

  /** Called with the folder an upload finished in, so listings refresh. */
  onUploaded(listener: (dir: string) => void) {
    this.uploadedListeners.add(listener)
    return () => {
      this.uploadedListeners.delete(listener)
    }
  }

  add(files: File[], dir: string) {
    if (files.length === 0) return
    if (!this.items.some((item) => item.status === 'queued' || item.status === 'uploading' || item.status === 'conflict')) this.policy = 'ask'
    const added = files.map<UploadItem>((file) => {
      counter += 1
      return {
        id: `upload-${counter}`,
        file,
        dir,
        target: joinPath(this.style, dir, file.name),
        status: 'queued',
        loaded: 0,
        total: file.size,
        overwrite: false,
        error: null,
        rate: null,
      }
    })
    this.set([...this.items, ...added])
    this.pump()
  }

  cancel(id: string) {
    const item = this.items.find((candidate) => candidate.id === id)
    if (!item) return
    if (item.status === 'uploading' || item.status === 'finishing') this.controllers.get(id)?.abort()
    else if (item.status === 'queued' || item.status === 'conflict') this.patch(id, { status: 'cancelled' })
    this.pump()
  }

  retry(id: string) {
    this.patch(id, { status: 'queued', loaded: 0, error: null, rate: null })
    this.pump()
  }

  /** Answers an overwrite prompt; `applyToAll` also answers later conflicts in this batch. */
  resolve(id: string, choice: 'replace' | 'skip', applyToAll: boolean) {
    if (applyToAll) {
      this.policy = choice
      this.set(
        this.items.map((item) =>
          item.status === 'conflict' ? (choice === 'replace' ? { ...item, status: 'queued', overwrite: true } : { ...item, status: 'skipped' }) : item,
        ),
      )
    } else {
      this.patch(id, choice === 'replace' ? { status: 'queued', overwrite: true } : { status: 'skipped' })
    }
    this.pump()
  }

  clearFinished() {
    this.set(this.items.filter((item) => item.status === 'queued' || item.status === 'uploading' || item.status === 'finishing' || item.status === 'conflict'))
  }

  private set(items: UploadItem[]) {
    this.items = items
    this.listeners.forEach((listener) => listener())
  }

  private patch(id: string, patch: Partial<UploadItem>) {
    this.set(this.items.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  private pump() {
    const running = this.items.filter((item) => item.status === 'uploading' || item.status === 'finishing').length
    const next = this.items.filter((item) => item.status === 'queued').slice(0, Math.max(0, CONCURRENCY - running))
    next.forEach((item) => void this.run(item))
  }

  private async run(item: UploadItem) {
    const controller = new AbortController()
    this.controllers.set(item.id, controller)
    this.samples.set(item.id, { at: performance.now(), loaded: 0 })
    this.patch(item.id, { status: 'uploading', loaded: 0, error: null, rate: null })
    try {
      await remoteApi.upload(this.deviceId, item.target, item.file, {
        overwrite: item.overwrite,
        signal: controller.signal,
        onProgress: (loaded, total) => this.progress(item.id, loaded, total),
      })
      this.patch(item.id, { status: 'done', loaded: item.file.size, rate: null })
      this.uploadedListeners.forEach((listener) => listener(item.dir))
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.patch(item.id, { status: 'cancelled', rate: null })
      } else if (isExistsError(error) && !item.overwrite) {
        if (this.policy === 'replace') this.patch(item.id, { status: 'queued', overwrite: true, loaded: 0 })
        else if (this.policy === 'skip') this.patch(item.id, { status: 'skipped', rate: null })
        else this.patch(item.id, { status: 'conflict', rate: null, loaded: 0 })
      } else {
        this.patch(item.id, { status: 'failed', error: errorMessage(error, 'Upload failed'), rate: null })
      }
    } finally {
      this.controllers.delete(item.id)
      this.samples.delete(item.id)
      this.pump()
    }
  }

  private progress(id: string, loaded: number, total: number) {
    const now = performance.now()
    const sample = this.samples.get(id)
    let rate: number | null = null
    if (sample && now - sample.at > 250) {
      const instant = ((loaded - sample.loaded) / (now - sample.at)) * 1000
      const previous = this.items.find((item) => item.id === id)?.rate
      rate = previous ? previous * 0.6 + instant * 0.4 : instant
      this.samples.set(id, { at: now, loaded })
    }
    const current = this.items.find((item) => item.id === id)
    if (!current || (current.status !== 'uploading' && current.status !== 'finishing')) return
    this.patch(id, {
      loaded,
      total: total || current.total,
      // Once every byte is sent the agent still writes and renames the file.
      status: loaded >= (total || current.total) ? 'finishing' : 'uploading',
      rate: rate ?? current.rate,
    })
  }
}

const queues = new Map<string, UploadQueue>()

/** One queue per device for the browser session, so uploads keep going while you switch tabs. */
export function uploadQueueFor(deviceId: string, style: PathStyle): UploadQueue {
  let queue = queues.get(deviceId)
  if (!queue) {
    queue = new UploadQueue(deviceId, style)
    queues.set(deviceId, queue)
  }
  return queue
}

export function useUploadItems(queue: UploadQueue): UploadItem[] {
  return useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot)
}
