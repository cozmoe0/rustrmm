/*
 * Safe Markdown for ticket descriptions, comments, canned responses and the e-mail signature.
 * `marked` (pinned) renders GFM; raw HTML in the source is never rendered: the `html` renderer
 * escapes it to text. Images become plain links (no remote loads, no tracking pixels). The output then
 * passes DOMPurify with a small allow-list and http(s)/mailto links only, and every link opens in a new
 * tab without a referrer. Only the sanitised string may reach `dangerouslySetInnerHTML`.
 */
import DOMPurify from 'dompurify'
import { Marked, type Tokens } from 'marked'

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char])
}

const SAFE_URL = /^(?:https?:|mailto:)/i

function safeHref(href: string | null | undefined): string | null {
  if (!href) return null
  const trimmed = href.trim()
  return SAFE_URL.test(trimmed) ? trimmed : null
}

const marked = new Marked({ gfm: true, breaks: true, async: false })

marked.use({
  renderer: {
    // Raw HTML blocks and inline tags show as literal text.
    html(token: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(token.text)
    },
    image(token: Tokens.Image) {
      const href = safeHref(token.href)
      const label = escapeHtml(token.text || token.href || 'image')
      return href ? `<a href="${escapeHtml(href)}">${label}</a>` : label
    },
  },
})

const ALLOWED_TAGS = [
  'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'input', 'li', 'ol', 'p',
  'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
]
const ALLOWED_ATTR = ['href', 'title', 'align', 'start', 'type', 'checked', 'disabled']

let hooked = false

function installHooks() {
  if (hooked) return
  hooked = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName === 'A') {
      const href = safeHref(node.getAttribute('href'))
      if (href) {
        node.setAttribute('href', href)
        node.setAttribute('target', '_blank')
        node.setAttribute('rel', 'noopener noreferrer nofollow')
      } else {
        node.removeAttribute('href')
      }
    }
    if (node.nodeName === 'INPUT') {
      // GFM task-list checkboxes only.
      if (node.getAttribute('type') !== 'checkbox') node.remove()
      else node.setAttribute('disabled', '')
    }
  })
}

/** Markdown → sanitised HTML. */
export function renderMarkdown(source: string): string {
  installHooks()
  const html = marked.parse(source ?? '') as string
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: SAFE_URL,
    ADD_ATTR: ['target', 'rel'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_TRUSTED_TYPE: false,
  }) as string
}

/** Plain text for one-line previews (no Markdown syntax, collapsed whitespace). */
export function markdownExcerpt(source: string, length = 160): string {
  const text = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*{1,3}|~~)([^*~]+)\1/g, '$2')
    .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text
}
