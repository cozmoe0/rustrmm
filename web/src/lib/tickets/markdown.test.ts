import { describe, expect, it } from 'vitest'
import { markdownExcerpt, renderMarkdown } from './markdown'

function render(source: string) {
  const html = renderMarkdown(source)
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html')
  return { html, root: doc.getElementById('root')! }
}

function eventAttributes(root: Element) {
  return [...root.querySelectorAll('*')].flatMap((element) => [...element.attributes].map((attr) => attr.name)).filter((name) => name.startsWith('on'))
}

describe('renderMarkdown', () => {
  it('renders ordinary Markdown', () => {
    const { root } = render('**Bold** and _em_\n\n- one\n- two\n\n`code`')
    expect(root.querySelector('strong')?.textContent).toBe('Bold')
    expect(root.querySelectorAll('li')).toHaveLength(2)
    expect(root.querySelector('code')?.textContent).toBe('code')
  })

  it('never renders script tags', () => {
    const { root, html } = render('Hello <script>alert(1)</script>\n\n<script>\nalert(2)\n</script>')
    expect(root.querySelector('script')).toBeNull()
    expect(html).toContain('&lt;script&gt;')
  })

  it('never renders raw HTML elements or event handlers', () => {
    const { root } = render('<img src=x onerror="alert(1)"> <b onmouseover="alert(2)">x</b>\n\n<div onclick="alert(3)">block</div>')
    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('b')).toBeNull()
    expect(root.querySelector('div')).toBeNull()
    expect(eventAttributes(root)).toEqual([])
    expect(root.textContent).toContain('<img src=x onerror="alert(1)">')
  })

  it('drops javascript: and other unsafe link targets', () => {
    for (const source of ['[click](javascript:alert(1))', '[click](JaVaScRiPt:alert(1))', '[x](data:text/html,<script>alert(1)</script>)', '[x](vbscript:msgbox)']) {
      const { root } = render(source)
      for (const link of root.querySelectorAll('a')) expect(link.getAttribute('href')).toBeNull()
      expect(root.innerHTML.toLowerCase()).not.toContain('javascript:')
    }
    const raw = render('<a href="javascript:alert(1)">x</a>')
    expect(raw.root.querySelector('a')).toBeNull()
  })

  it('keeps safe links and opens them in a new tab without a referrer', () => {
    const { root } = render('[docs](https://example.com/a?b=1) <mailto:help@example.com>')
    const [web, mail] = root.querySelectorAll('a')
    expect(web.getAttribute('href')).toBe('https://example.com/a?b=1')
    expect(web.getAttribute('target')).toBe('_blank')
    expect(web.getAttribute('rel')).toBe('noopener noreferrer nofollow')
    expect(mail.getAttribute('href')).toBe('mailto:help@example.com')
  })

  it('turns images into links instead of loading them', () => {
    const { root } = render('![diagram](https://example.com/pixel.png) ![bad](javascript:alert(1))')
    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.com/pixel.png')
    expect(root.textContent).toContain('bad')
  })

  it('makes plain-text excerpts', () => {
    expect(markdownExcerpt('## Title\n\n**Printer** is [offline](https://x) `now`')).toBe('Title Printer is offline now')
    expect(markdownExcerpt('a'.repeat(20), 10)).toBe(`${'a'.repeat(9)}…`)
    expect(markdownExcerpt('Hi {{contact.first_name}}, this is _urgent_ ~~now~~')).toBe('Hi {{contact.first_name}}, this is urgent now')
  })
})
