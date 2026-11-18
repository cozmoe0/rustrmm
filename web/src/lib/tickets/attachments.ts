/*
 * Client-side checks for comment attachments, matching the server's rules: at most 10 files of up to
 * 25 MiB each (110 MiB per request) with an allowed extension. The server also refuses executables by
 * their content, so a renamed binary still fails there with a 422.
 */

export const MAX_ATTACHMENTS = 10
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_ATTACHMENTS_TOTAL_BYTES = 110 * 1024 * 1024

export const ALLOWED_EXTENSIONS: Record<string, string[]> = {
  Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'svg', 'ico'],
  Documents: [
    'pdf', 'txt', 'log', 'csv', 'tsv', 'md', 'rtf', 'json', 'xml', 'yaml', 'yml', 'ini', 'conf', 'cfg', 'doc', 'docx', 'xls',
    'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'vsdx', 'pages', 'numbers', 'key',
  ],
  Archives: ['zip', '7z', 'gz', 'tgz', 'tar', 'rar'],
  Mail: ['eml', 'msg'],
  Media: ['mp4', 'mov', 'webm', 'mp3', 'wav', 'm4a'],
  Diagnostics: ['evtx', 'etl', 'dmp', 'pcap', 'pcapng', 'har'],
}

const ALLOWED = new Set(Object.values(ALLOWED_EXTENSIONS).flat())

/** Raster images the browser can show as thumbnails (SVG is never rendered inline). */
export const PREVIEWABLE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function isAllowedFile(name: string): boolean {
  return ALLOWED.has(extensionOf(name))
}

/** The `accept` attribute for file inputs. */
export const ACCEPT = [...ALLOWED].map((extension) => `.${extension}`).join(',')

export interface FileLike {
  name: string
  size: number
}

export interface AttachmentCheck<T extends FileLike> {
  accepted: T[]
  rejected: { name: string; reason: string }[]
}

/** Splits `incoming` into files that fit beside `current` and files refused with a reason. */
export function checkAttachments<T extends FileLike>(current: readonly FileLike[], incoming: readonly T[]): AttachmentCheck<T> {
  const accepted: T[] = []
  const rejected: { name: string; reason: string }[] = []
  let count = current.length
  let total = current.reduce((sum, file) => sum + file.size, 0)
  for (const file of incoming) {
    const extension = extensionOf(file.name)
    if (!ALLOWED.has(extension)) {
      rejected.push({ name: file.name, reason: extension ? `.${extension} files are not accepted` : 'Files need an extension' })
    } else if (file.size === 0) {
      rejected.push({ name: file.name, reason: 'The file is empty' })
    } else if (file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push({ name: file.name, reason: 'Larger than 25 MB' })
    } else if (count >= MAX_ATTACHMENTS) {
      rejected.push({ name: file.name, reason: `At most ${MAX_ATTACHMENTS} files per reply` })
    } else if (total + file.size > MAX_ATTACHMENTS_TOTAL_BYTES) {
      rejected.push({ name: file.name, reason: 'The reply would exceed 110 MB in total' })
    } else {
      accepted.push(file)
      count += 1
      total += file.size
    }
  }
  return { accepted, rejected }
}
