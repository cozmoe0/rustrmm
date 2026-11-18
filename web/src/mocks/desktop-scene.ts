/*
 * A synthetic desktop for the mock remote desktop agent. It paints a believable Windows 11 or
 * GNOME screen (wallpaper, taskbar with a ticking clock, windows that can be focused, dragged,
 * typed into and scrolled), the Windows secure desktop (Ctrl+Alt+Del screen, UAC prompt, lock and
 * sign-in screens), and reports which regions changed so the encoder only sends dirty tiles.
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type SceneTheme = 'windows' | 'linux'
export type CursorKind = 'arrow' | 'ibeam' | 'hand' | 'move'
export type SecureScreen = 'cad' | 'uac' | 'lock' | 'signin'

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
type WindowKind = 'notepad' | 'status' | 'log' | 'terminal' | 'browser'

interface SceneWindow {
  id: WindowKind
  title: string
  x: number
  y: number
  w: number
  h: number
  open: boolean
}

export interface SceneEvents {
  desktop?: (name: 'default' | 'winlogon') => void
  clipboard?: (text: string) => void
  resize?: (width: number, height: number) => void
}

export interface SceneOptions {
  theme: SceneTheme
  width: number
  height: number
  /** 0 = primary monitor, 1 = the secondary one (different content). */
  monitor: number
  hostname: string
  user: string | null
  /** Start on the secure desktop (sign-in or lock screen). */
  secure?: SecureScreen | null
  events?: SceneEvents
}

const TITLE_H = 32
const TASKBAR_H = 48
const TOPBAR_H = 30
const LOG_ROW = 22
const UI_FONT = '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif'
const LINUX_FONT = 'Cantarell, Ubuntu, "Noto Sans", system-ui, sans-serif'
const MONO = '"Cascadia Mono", Consolas, "DejaVu Sans Mono", ui-monospace, monospace'

const LOG_MESSAGES: [string, string, string][] = [
  ['Information', 'Service Control Manager', 'The Windows Update service entered the running state.'],
  ['Information', 'Kernel-Power', 'The system has resumed from sleep.'],
  ['Warning', 'DNS Client Events', 'Name resolution for wpad timed out after none of the servers responded.'],
  ['Information', 'Microsoft-Windows-Time-Service', 'The time provider NtpClient is synchronized.'],
  ['Information', 'RustRMM Agent', 'Remote desktop session started by a technician.'],
  ['Warning', 'Disk', 'The IO operation at logical block address 0x2b1 was retried.'],
  ['Information', 'Winlogon', 'User Logon Notification for Customer Experience Improvement Program.'],
  ['Information', 'Microsoft-Windows-Defender', 'Security intelligence updated to version 1.421.1180.0.'],
]

const pad = (value: number) => String(value).padStart(2, '0')

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

function inside(rect: Rect, x: number, y: number) {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h
}

function rounded(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

export class DesktopScene {
  width: number
  height: number
  readonly theme: SceneTheme
  readonly monitor: number
  secure: SecureScreen | null
  private hostname: string
  private user: string | null
  private events: SceneEvents
  private windows: SceneWindow[]
  private focused: WindowKind | null
  private dirty: Rect[] = []
  private copies: { src: Rect; dy: number }[] = []
  private notepad: string
  private terminal: string[]
  private log: string[] = []
  private logScroll = 0
  private cpu: number[] = Array.from({ length: 48 }, (_, index) => 18 + 10 * Math.sin(index / 4) + (index % 5) * 2)
  private caret = true
  private selectedIcon: number | null = null
  private drag: { id: WindowKind; dx: number; dy: number } | null = null
  private buttons = 0
  private lastClick = { target: '', at: 0 }
  private password = ''
  private hoverOption: number | null = null
  private clock = ''
  private progress = 0
  private clipboard = ''
  private now: Date

  constructor(options: SceneOptions) {
    this.theme = options.theme
    this.width = options.width
    this.height = options.height
    this.monitor = options.monitor
    this.hostname = options.hostname
    this.user = options.user
    this.secure = options.secure ?? null
    this.events = options.events ?? {}
    this.now = new Date()
    this.clock = this.clockText()
    const linux = this.theme === 'linux'
    this.notepad = linux
      ? ''
      : `Notes for ${this.hostname}\n\n- Printer on the 2nd floor jams on duplex jobs\n- Ask about moving the backup window to 2 AM\n\nType here: this is a live mock desktop.`
    this.terminal = [`${this.user ?? 'user'}@${this.hostname}:~$ uptime`, ' 10:42:07 up 12 days,  3:14,  1 user,  load average: 0.42, 0.37, 0.31', `${this.user ?? 'user'}@${this.hostname}:~$ `]
    for (let index = 0; index < 14; index += 1) this.log.push(this.logLine(index))
    const w = this.width
    const h = this.height
    if (this.monitor === 0) {
      this.windows = [
        { id: 'log', title: linux ? 'Logs — journalctl -f' : 'Event Viewer — System', x: Math.round(w * 0.5), y: Math.round(h * 0.47), w: Math.min(620, Math.round(w * 0.42)), h: Math.min(330, Math.round(h * 0.36)), open: true },
        { id: 'status', title: linux ? 'System Monitor' : 'Resource Monitor', x: Math.round(w * 0.56), y: Math.round(h * 0.09), w: Math.min(460, Math.round(w * 0.32)), h: Math.min(300, Math.round(h * 0.33)), open: true },
        linux
          ? { id: 'terminal', title: `${this.user ?? 'user'}@${this.hostname}: ~`, x: Math.round(w * 0.12), y: Math.round(h * 0.14), w: Math.min(640, Math.round(w * 0.4)), h: Math.min(400, Math.round(h * 0.45)), open: true }
          : { id: 'notepad', title: 'notes.txt — Notepad', x: Math.round(w * 0.12), y: Math.round(h * 0.12), w: Math.min(640, Math.round(w * 0.4)), h: Math.min(420, Math.round(h * 0.47)), open: true },
      ]
      this.focused = linux ? 'terminal' : 'notepad'
    } else {
      this.windows = [{ id: 'browser', title: 'Fleet dashboard — Microsoft Edge', x: Math.round(w * 0.08), y: Math.round(h * 0.08), w: Math.round(w * 0.6), h: Math.round(h * 0.66), open: true }]
      this.focused = 'browser'
    }
    this.invalidateAll()
  }

  // ------------------------------------------------------------------ state

  get desktopName(): 'default' | 'winlogon' {
    return this.secure ? 'winlogon' : 'default'
  }

  invalidate(rect: Rect) {
    const x = Math.max(0, Math.floor(rect.x))
    const y = Math.max(0, Math.floor(rect.y))
    const w = Math.min(this.width, Math.ceil(rect.x + rect.w)) - x
    const h = Math.min(this.height, Math.ceil(rect.y + rect.h)) - y
    if (w > 0 && h > 0) this.dirty.push({ x, y, w, h })
  }

  invalidateAll() {
    this.copies = []
    this.dirty = [{ x: 0, y: 0, w: this.width, h: this.height }]
  }

  /** Dirty regions and scroll moves since the last call. */
  take(): { dirty: Rect[]; copies: { src: Rect; dy: number }[] } {
    const result = { dirty: this.dirty, copies: this.copies }
    this.dirty = []
    this.copies = []
    return result
  }

  hasChanges() {
    return this.dirty.length > 0 || this.copies.length > 0
  }

  resize(width: number, height: number) {
    this.width = width
    this.height = height
    for (const win of this.windows) {
      win.x = Math.min(win.x, Math.max(0, width - win.w))
      win.y = Math.min(win.y, Math.max(0, height - win.h - TASKBAR_H))
    }
    this.invalidateAll()
  }

  // ------------------------------------------------------------------ time

  private clockText() {
    const now = this.now
    if (this.theme === 'linux') return `${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}  ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    const hours = now.getHours() % 12 || 12
    return `${hours}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${now.getHours() < 12 ? 'AM' : 'PM'}`
  }

  private logLine(seed: number) {
    const [level, source, message] = LOG_MESSAGES[seed % LOG_MESSAGES.length]
    const at = new Date(Date.now() - (14 - seed) * 2000)
    return `${level}\t${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}\t${source}\t${message}`
  }

  /** Advances clocks and animations; call every ~250 ms. */
  tick(now = new Date()) {
    const previous = this.now
    this.now = now
    const clock = this.clockText()
    if (clock !== this.clock) {
      this.clock = clock
      if (this.secure === 'lock') this.invalidateAll()
      else if (!this.secure || this.secure === 'uac') this.invalidate(this.clockRect())
      this.progress = (this.progress + 7) % 101
      if (this.monitor === 1) this.invalidate(this.activityStrip())
    }
    const status = this.window('status')
    if (status?.open && !this.secure && now.getTime() - previous.getTime() < 2000 && Math.floor(now.getTime() / 1000) !== Math.floor(previous.getTime() / 1000)) {
      this.cpu.push(Math.max(3, Math.min(96, (this.cpu.at(-1) ?? 20) + (Math.random() - 0.48) * 14)))
      this.cpu.shift()
      this.invalidate(status)
    }
    if (this.monitor === 1 && !this.secure && Math.floor(now.getTime() / 1000) !== Math.floor(previous.getTime() / 1000)) {
      const browser = this.window('browser')
      if (browser?.open) this.invalidate({ x: browser.x, y: browser.y + TITLE_H + 40, w: browser.w, h: browser.h - TITLE_H - 40 })
    }
    // A new log line every two seconds scrolls the log by one row (a DXGI move rect).
    if (Math.floor(now.getTime() / 2000) !== Math.floor(previous.getTime() / 2000)) this.appendLog()
    const caret = Math.floor(now.getTime() / 530) % 2 === 0
    if (caret !== this.caret) {
      this.caret = caret
      const rect = this.caretRect()
      if (rect) this.invalidate(rect)
    }
  }

  private appendLog() {
    this.log.push(this.logLine(this.log.length))
    if (this.log.length > 200) {
      // Keep the visible rows in place while the oldest line drops off.
      this.log.shift()
      this.logScroll = Math.max(0, this.logScroll - LOG_ROW)
    }
    const win = this.window('log')
    if (!win?.open || this.secure) return
    this.scrollLog(1)
  }

  /** Scrolls the log by whole rows. New lines only scroll it while the user follows the tail. */
  private scrollLog(rows: number, user = false) {
    const win = this.window('log')
    if (!win) return
    const body = this.logBody(win)
    const maxScroll = Math.max(0, this.log.length * LOG_ROW - body.h)
    const atBottom = this.logScroll >= maxScroll - LOG_ROW * 1.5
    const before = this.logScroll
    if (!user && !atBottom) return
    this.logScroll = Math.max(0, Math.min(maxScroll, this.logScroll + rows * LOG_ROW))
    const dy = before - this.logScroll
    if (dy === 0) return
    const covered = this.windows.slice(this.windows.indexOf(win) + 1).some((other) => other.open && intersects(other, win))
    if (covered || Math.abs(dy) >= body.h) {
      this.invalidate(body)
      return
    }
    if (dy < 0) {
      // Content moves up: copy rows below to the top, then paint the exposed strip at the bottom.
      this.copies.push({ src: { x: body.x, y: body.y - dy, w: body.w, h: body.h + dy }, dy })
      this.invalidate({ x: body.x, y: body.y + body.h + dy, w: body.w, h: -dy })
    } else {
      this.copies.push({ src: { x: body.x, y: body.y, w: body.w, h: body.h - dy }, dy })
      this.invalidate({ x: body.x, y: body.y, w: body.w, h: dy })
    }
  }

  // ------------------------------------------------------------------ geometry

  private window(id: WindowKind) {
    return this.windows.find((win) => win.id === id)
  }

  private clockRect(): Rect {
    if (this.theme === 'linux') return { x: this.width / 2 - 110, y: 0, w: 220, h: TOPBAR_H }
    return { x: this.width - 150, y: this.height - TASKBAR_H, w: 150, h: TASKBAR_H - 4 }
  }

  /** A thin animated strip on the bottom edge of the secondary monitor (exercises small raw tiles). */
  private activityStrip(): Rect {
    return { x: 64 * 6 + 10, y: this.height - 3, w: 40, h: 3 }
  }

  private logBody(win: SceneWindow): Rect {
    return { x: win.x + 1, y: win.y + TITLE_H + 26, w: win.w - 2, h: win.h - TITLE_H - 27 }
  }

  private editorBody(win: SceneWindow): Rect {
    return win.id === 'notepad' ? { x: win.x + 1, y: win.y + TITLE_H + 28, w: win.w - 2, h: win.h - TITLE_H - 28 - 24 } : { x: win.x + 1, y: win.y + TITLE_H, w: win.w - 2, h: win.h - TITLE_H - 1 }
  }

  private caretRect(): Rect | null {
    if (this.secure === 'signin') return { x: this.width / 2 - 140, y: this.height / 2 + 60, w: 280, h: 36 }
    if (this.secure) return null
    const win = this.focused ? this.window(this.focused) : null
    if (!win?.open || (win.id !== 'notepad' && win.id !== 'terminal')) return null
    const pos = this.caretPosition(win)
    return { x: pos.x - 1, y: pos.y - 2, w: 4, h: 22 }
  }

  private caretPosition(win: SceneWindow) {
    const body = this.editorBody(win)
    if (win.id === 'notepad') {
      const lines = this.notepad.split('\n')
      const last = lines.at(-1) ?? ''
      return { x: body.x + 14 + last.length * 8.4, y: body.y + 10 + (lines.length - 1) * 21 }
    }
    const last = this.terminal.at(-1) ?? ''
    return { x: body.x + 12 + last.length * 8.4, y: body.y + 10 + (this.terminal.length - 1) * 20 }
  }

  private icons(): { label: string; x: number; y: number; action: 'admin' | 'display' | 'none' }[] {
    if (this.monitor !== 0 || this.theme === 'linux') return []
    return [
      { label: 'This PC', x: 18, y: 18, action: 'none' },
      { label: 'Recycle Bin', x: 18, y: 112, action: 'none' },
      { label: 'PowerShell (Admin)', x: 18, y: 206, action: 'admin' },
      { label: 'Display settings', x: 18, y: 300, action: 'display' },
    ]
  }

  private taskbarApps(): { id: WindowKind | 'start' | 'edge' | 'files'; x: number }[] {
    const ids: (WindowKind | 'start' | 'edge' | 'files')[] = ['start', 'files', 'edge', 'notepad', 'status', 'log']
    const start = this.width / 2 - (ids.length * 44) / 2
    return ids.map((id, index) => ({ id, x: start + index * 44 }))
  }

  // ------------------------------------------------------------------ hit testing and input

  private hit(x: number, y: number): string {
    if (this.secure === 'cad') {
      const option = this.cadOptions().findIndex((item) => inside(item.rect, x, y))
      if (option >= 0) return `cad:${option}`
      if (inside(this.cadCancel(), x, y)) return 'cad:cancel'
      return 'secure'
    }
    if (this.secure === 'uac') {
      const { yes, no } = this.uacButtons()
      if (inside(yes, x, y)) return 'uac:yes'
      if (inside(no, x, y)) return 'uac:no'
      return 'secure'
    }
    if (this.secure === 'lock') return 'lock'
    if (this.secure === 'signin') {
      if (inside(this.caretRect()!, x, y)) return 'signin:field'
      return 'secure'
    }
    for (let index = this.windows.length - 1; index >= 0; index -= 1) {
      const win = this.windows[index]
      if (!win.open || !inside(win, x, y)) continue
      if (y < win.y + TITLE_H) {
        if (x > win.x + win.w - 46) return `close:${win.id}`
        if (x > win.x + win.w - 138) return `caption:${win.id}`
        return `title:${win.id}`
      }
      if ((win.id === 'notepad' || win.id === 'terminal') && inside(this.editorBody(win), x, y)) return `text:${win.id}`
      if (win.id === 'log' && inside(this.logBody(win), x, y)) return `logbody:${win.id}`
      return `body:${win.id}`
    }
    if (this.theme === 'windows' && y >= this.height - TASKBAR_H) {
      const app = this.taskbarApps().find((item) => x >= item.x && x < item.x + 40)
      return app ? `task:${app.id}` : 'taskbar'
    }
    const icon = this.icons().findIndex((item) => x >= item.x && x < item.x + 76 && y >= item.y && y < item.y + 84)
    if (icon >= 0) return `icon:${icon}`
    return 'desktop'
  }

  cursorAt(x: number, y: number): CursorKind {
    if (this.drag) return 'move'
    const target = this.hit(x, y)
    if (target.startsWith('text:') || target === 'signin:field') return 'ibeam'
    if (target.startsWith('cad:') || target.startsWith('uac:') || target.startsWith('task:') || target.startsWith('close:') || target.startsWith('caption:')) return 'hand'
    return 'arrow'
  }

  private focus(id: WindowKind) {
    const win = this.window(id)
    if (!win) return
    const previous = this.focused ? this.window(this.focused) : null
    this.focused = id
    this.windows = [...this.windows.filter((item) => item !== win), win]
    win.open = true
    this.invalidate(this.shadowed(win))
    if (previous && previous !== win) this.invalidate({ x: previous.x, y: previous.y, w: previous.w, h: TITLE_H })
  }

  private shadowed(win: Rect): Rect {
    return { x: win.x - 18, y: win.y - 12, w: win.w + 36, h: win.h + 36 }
  }

  /** Pointer state from a `mouse` message (buttons is the DOM bitmask). */
  pointer(x: number, y: number, buttons: number) {
    const pressed = buttons & ~this.buttons
    const released = this.buttons & ~buttons
    this.buttons = buttons
    if (this.drag) {
      const win = this.window(this.drag.id)
      if (win) {
        const nx = Math.max(-win.w + 80, Math.min(this.width - 80, x - this.drag.dx))
        const ny = Math.max(0, Math.min(this.height - TITLE_H - (this.theme === 'windows' ? TASKBAR_H : 0), y - this.drag.dy))
        if (nx !== win.x || ny !== win.y) {
          this.invalidate(this.shadowed(win))
          win.x = nx
          win.y = ny
          this.invalidate(this.shadowed(win))
        }
      }
      if (released & 1) this.drag = null
      return
    }
    const target = this.hit(x, y)
    if (this.secure === 'cad') {
      const option = target.startsWith('cad:') && target !== 'cad:cancel' ? Number(target.slice(4)) : null
      if (option !== this.hoverOption) {
        this.hoverOption = option
        this.invalidateAll()
      }
    }
    if (pressed & 1) this.click(target, x, y)
  }

  private click(target: string, x: number, y: number) {
    const now = performance.now()
    const double = this.lastClick.target === target && now - this.lastClick.at < 450
    this.lastClick = { target, at: now }
    const [kind, id] = target.split(':') as [string, string | undefined]
    switch (kind) {
      case 'cad':
        if (id === 'cancel') this.leaveSecure()
        else if (id === '0') this.enterSecure('lock')
        else if (id === '4') this.leaveSecure()
        return
      case 'uac':
        this.leaveSecure()
        return
      case 'lock':
        this.enterSecure('signin')
        return
      case 'title': {
        const win = this.window(id as WindowKind)
        if (!win) return
        this.focus(win.id)
        this.drag = { id: win.id, dx: x - win.x, dy: y - win.y }
        return
      }
      case 'close': {
        const win = this.window(id as WindowKind)
        if (!win) return
        win.open = false
        this.invalidate(this.shadowed(win))
        if (this.focused === win.id) this.focused = null
        this.invalidate({ x: 0, y: this.height - TASKBAR_H, w: this.width, h: TASKBAR_H })
        return
      }
      case 'caption':
      case 'body':
      case 'text':
      case 'logbody':
        this.focus(id as WindowKind)
        return
      case 'task': {
        const win = this.window(id as WindowKind)
        if (win) this.focus(win.id)
        this.invalidate({ x: 0, y: this.height - TASKBAR_H, w: this.width, h: TASKBAR_H })
        return
      }
      case 'icon': {
        const index = Number(id)
        const previous = this.selectedIcon
        this.selectedIcon = index
        for (const which of [previous, index]) {
          if (which === null) continue
          const icon = this.icons()[which]
          if (icon) this.invalidate({ x: icon.x - 4, y: icon.y - 4, w: 88, h: 96 })
        }
        if (double) {
          const action = this.icons()[index]?.action
          if (action === 'admin') this.enterSecure('uac')
          if (action === 'display') {
            const next = this.width === 1920 ? { w: 1600, h: 900 } : { w: 1920, h: 1080 }
            this.events.resize?.(next.w, next.h)
          }
        }
        return
      }
      default: {
        if (this.selectedIcon !== null) {
          const icon = this.icons()[this.selectedIcon]
          this.selectedIcon = null
          if (icon) this.invalidate({ x: icon.x - 4, y: icon.y - 4, w: 88, h: 96 })
        }
      }
    }
  }

  wheel(x: number, y: number, notches: number) {
    const target = this.hit(x, y)
    if (!target.startsWith('logbody:')) return
    const rows = Math.round(notches * 3)
    if (rows !== 0) this.scrollLog(rows, true)
  }

  /** A key press (`down`) by DOM code/key with the modifier state the scene tracked. */
  key(code: string, key: string, ctrl: boolean) {
    if (this.secure === 'cad' || this.secure === 'uac') {
      if (code === 'Escape' || (this.secure === 'uac' && code === 'Enter')) this.leaveSecure()
      return
    }
    if (this.secure === 'lock') {
      this.enterSecure('signin')
      return
    }
    if (this.secure === 'signin') {
      if (code === 'Enter') {
        this.password = ''
        this.leaveSecure()
      } else if (code === 'Backspace') this.password = this.password.slice(0, -1)
      else if (key.length === 1) this.password += key
      this.invalidateAll()
      return
    }
    const win = this.focused ? this.window(this.focused) : null
    if (!win || (win.id !== 'notepad' && win.id !== 'terminal')) return
    if (ctrl) {
      if (code === 'KeyC' || code === 'KeyA') {
        if (code === 'KeyC') {
          this.clipboard = win.id === 'notepad' ? this.notepad : this.terminal.join('\n')
          this.events.clipboard?.(this.clipboard)
        }
      } else if (code === 'KeyV' && this.clipboard) this.type(this.clipboard)
      return
    }
    if (code === 'Enter' || code === 'NumpadEnter') this.type('\n')
    else if (code === 'Backspace') this.backspace()
    else if (code === 'Tab') this.type('    ')
    else if (key.length === 1) this.type(key)
  }

  /** The device clipboard, set by a `clipboard` message from the browser. */
  setClipboard(text: string) {
    this.clipboard = text
  }

  type(text: string) {
    if (this.secure === 'signin') {
      this.password += text.replace(/\n/g, '')
      this.invalidateAll()
      return
    }
    const win = this.focused ? this.window(this.focused) : null
    if (!win || this.secure) return
    if (win.id === 'notepad') {
      this.notepad = (this.notepad + text.replace(/\r/g, '')).slice(-4000)
    } else if (win.id === 'terminal') {
      for (const char of text) {
        if (char === '\n') {
          const command = (this.terminal.at(-1) ?? '').replace(/^.*?\$ /, '')
          if (command.trim()) this.terminal.push(command.trim() === 'whoami' ? (this.user ?? 'user') : command.trim() === 'hostname' ? this.hostname : `${command.trim().split(' ')[0]}: command simulated`)
          this.terminal.push(`${this.user ?? 'user'}@${this.hostname}:~$ `)
          if (this.terminal.length > 30) this.terminal.splice(0, this.terminal.length - 30)
        } else this.terminal[this.terminal.length - 1] += char
      }
    } else return
    this.invalidate(this.editorBody(win))
    if (win.id === 'notepad') this.invalidate({ x: win.x, y: win.y + win.h - 24, w: win.w, h: 24 })
  }

  private backspace() {
    const win = this.focused ? this.window(this.focused) : null
    if (!win) return
    if (win.id === 'notepad') this.notepad = this.notepad.slice(0, -1)
    else if (win.id === 'terminal') {
      const last = this.terminal.at(-1) ?? ''
      if (!last.endsWith('$ ')) this.terminal[this.terminal.length - 1] = last.slice(0, -1)
    }
    this.invalidate(this.editorBody(win))
  }

  enterSecure(screen: SecureScreen) {
    const was = this.secure
    this.secure = screen
    this.drag = null
    this.hoverOption = null
    this.invalidateAll()
    if (!was) this.events.desktop?.('winlogon')
  }

  leaveSecure() {
    if (!this.secure) return
    this.secure = null
    this.invalidateAll()
    this.events.desktop?.('default')
  }

  // ------------------------------------------------------------------ painting

  /** Paints the scene inside `clip` (everything else is untouched). */
  paint(ctx: Ctx, clip: Rect) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(clip.x, clip.y, clip.w, clip.h)
    ctx.clip()
    ctx.textBaseline = 'alphabetic'
    if (this.secure === 'cad') this.paintCad(ctx)
    else if (this.secure === 'lock' || this.secure === 'signin') this.paintLock(ctx)
    else {
      this.paintDesktop(ctx, clip)
      if (this.secure === 'uac') this.paintUac(ctx)
    }
    ctx.restore()
  }

  /** Copies the scroll moves on the canvas itself, exactly as the viewer will. */
  applyCopies(ctx: Ctx, canvas: CanvasImageSource, copies: { src: Rect; dy: number }[]) {
    for (const copy of copies) ctx.drawImage(canvas, copy.src.x, copy.src.y, copy.src.w, copy.src.h, copy.src.x, copy.src.y + copy.dy, copy.src.w, copy.src.h)
  }

  private wallpaper(ctx: Ctx) {
    const { width: w, height: h } = this
    if (this.theme === 'linux') {
      const base = ctx.createLinearGradient(0, 0, w, h)
      base.addColorStop(0, '#2c0f3a')
      base.addColorStop(0.55, '#77216f')
      base.addColorStop(1, '#e95420')
      ctx.fillStyle = base
      ctx.fillRect(0, 0, w, h)
      const glow = ctx.createRadialGradient(w * 0.7, h * 0.35, 10, w * 0.7, h * 0.35, w * 0.5)
      glow.addColorStop(0, 'rgba(255,255,255,0.16)')
      glow.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = glow
      ctx.fillRect(0, 0, w, h)
      return
    }
    const second = this.monitor === 1
    const base = ctx.createLinearGradient(0, 0, w, h)
    base.addColorStop(0, second ? '#2a1a12' : '#0a1f3d')
    base.addColorStop(1, second ? '#6b3a1f' : '#1d5b8f')
    ctx.fillStyle = base
    ctx.fillRect(0, 0, w, h)
    const bloom = ctx.createRadialGradient(w * 0.62, h * 0.55, 20, w * 0.62, h * 0.55, Math.max(w, h) * 0.45)
    bloom.addColorStop(0, second ? 'rgba(255,190,120,0.55)' : 'rgba(120,200,255,0.55)')
    bloom.addColorStop(0.45, second ? 'rgba(220,120,60,0.22)' : 'rgba(60,140,230,0.22)')
    bloom.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = bloom
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = second ? 'rgba(255,220,180,0.12)' : 'rgba(180,225,255,0.13)'
    ctx.lineWidth = 2
    for (let ring = 0; ring < 6; ring += 1) {
      ctx.beginPath()
      ctx.ellipse(w * 0.62, h * 0.55, 120 + ring * 70, 60 + ring * 38, -0.5, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  private paintDesktop(ctx: Ctx, clip: Rect) {
    this.wallpaper(ctx)
    const linux = this.theme === 'linux'
    // Icons
    this.icons().forEach((icon, index) => {
      if (!intersects(clip, { x: icon.x - 4, y: icon.y - 4, w: 88, h: 96 })) return
      if (this.selectedIcon === index) {
        ctx.fillStyle = 'rgba(255,255,255,0.18)'
        rounded(ctx, icon.x - 2, icon.y - 2, 80, 88, 6)
        ctx.fill()
        ctx.strokeStyle = 'rgba(255,255,255,0.35)'
        ctx.lineWidth = 1
        ctx.stroke()
      }
      const colors = ['#4cc2ff', '#cfd8dc', '#2a6fdb', '#7a7fff']
      ctx.fillStyle = colors[index % colors.length]
      rounded(ctx, icon.x + 20, icon.y + 6, 36, 32, 5)
      ctx.fill()
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.fillRect(icon.x + 26, icon.y + 14, 24, 3)
      ctx.fillRect(icon.x + 26, icon.y + 21, 18, 3)
      ctx.font = `12px ${UI_FONT}`
      ctx.textAlign = 'center'
      ctx.fillStyle = '#ffffff'
      ctx.shadowColor = 'rgba(0,0,0,0.7)'
      ctx.shadowBlur = 3
      const words = icon.label.split(' ')
      ctx.fillText(words.slice(0, 2).join(' '), icon.x + 38, icon.y + 58)
      if (words.length > 2) ctx.fillText(words.slice(2).join(' '), icon.x + 38, icon.y + 73)
      ctx.shadowBlur = 0
      ctx.textAlign = 'left'
    })
    for (const win of this.windows) if (win.open && intersects(clip, this.shadowed(win))) this.paintWindow(ctx, win)
    if (linux) this.paintTopBar(ctx)
    else this.paintTaskbar(ctx)
  }

  private paintTaskbar(ctx: Ctx) {
    const y = this.height - TASKBAR_H
    ctx.fillStyle = '#1c1c1f'
    ctx.fillRect(0, y, this.width, TASKBAR_H)
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.fillRect(0, y, this.width, 1)
    for (const app of this.taskbarApps()) {
      const cx = app.x + 20
      const cy = y + 24
      const open = app.id !== 'start' && app.id !== 'edge' && app.id !== 'files' && Boolean(this.window(app.id as WindowKind)?.open)
      if (app.id === 'start') {
        ctx.fillStyle = '#4cc2ff'
        for (const [dx, dy] of [[-9, -9], [1, -9], [-9, 1], [1, 1]]) ctx.fillRect(cx + dx, cy + dy, 8, 8)
        continue
      }
      const colors: Record<string, string> = { files: '#f6c443', edge: '#2bb0a6', notepad: '#5ea0ef', status: '#6ccb5f', log: '#c48df5', browser: '#2bb0a6', terminal: '#888' }
      ctx.fillStyle = colors[app.id] ?? '#999'
      rounded(ctx, cx - 11, cy - 11, 22, 22, 5)
      ctx.fill()
      if (open) {
        ctx.fillStyle = this.focused === app.id ? '#4cc2ff' : 'rgba(255,255,255,0.45)'
        rounded(ctx, cx - (this.focused === app.id ? 8 : 3), y + TASKBAR_H - 5, this.focused === app.id ? 16 : 6, 3, 1.5)
        ctx.fill()
      }
    }
    // Tray
    ctx.textAlign = 'right'
    ctx.fillStyle = '#ffffff'
    ctx.font = `12px ${UI_FONT}`
    ctx.fillText(this.clock, this.width - 16, y + 21)
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    ctx.fillText(this.now.toLocaleDateString('en-US'), this.width - 16, y + 38)
    ctx.textAlign = 'left'
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    for (let index = 0; index < 3; index += 1) {
      rounded(ctx, this.width - 210 + index * 20, y + 18, 12, 12, 3)
      ctx.fill()
    }
    if (this.monitor === 1) {
      const strip = this.activityStrip()
      ctx.fillStyle = '#1c1c1f'
      ctx.fillRect(strip.x, strip.y, strip.w, strip.h)
      ctx.fillStyle = '#4cc2ff'
      ctx.fillRect(strip.x, strip.y + 1, Math.round((strip.w * this.progress) / 100), 2)
    }
  }

  private paintTopBar(ctx: Ctx) {
    ctx.fillStyle = '#121212'
    ctx.fillRect(0, 0, this.width, TOPBAR_H)
    ctx.font = `600 13px ${LINUX_FONT}`
    ctx.fillStyle = '#ffffff'
    ctx.fillText('Activities', 14, 20)
    ctx.textAlign = 'center'
    ctx.font = `600 13px ${LINUX_FONT}`
    ctx.fillText(this.clock, this.width / 2, 20)
    ctx.textAlign = 'left'
    ctx.fillStyle = 'rgba(255,255,255,0.8)'
    for (let index = 0; index < 3; index += 1) {
      rounded(ctx, this.width - 80 + index * 20, 10, 11, 11, 3)
      ctx.fill()
    }
  }

  private paintWindow(ctx: Ctx, win: SceneWindow) {
    const linux = this.theme === 'linux'
    const active = this.focused === win.id
    const dark = linux || win.id === 'terminal'
    ctx.save()
    ctx.shadowColor = active ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.3)'
    ctx.shadowBlur = active ? 24 : 14
    ctx.shadowOffsetY = 6
    ctx.fillStyle = dark ? '#242424' : '#ffffff'
    rounded(ctx, win.x, win.y, win.w, win.h, linux ? 10 : 8)
    ctx.fill()
    ctx.restore()
    ctx.save()
    rounded(ctx, win.x, win.y, win.w, win.h, linux ? 10 : 8)
    ctx.clip()
    // Title bar
    ctx.fillStyle = dark ? (active ? '#303030' : '#2a2a2a') : active ? '#f3f3f3' : '#fafafa'
    ctx.fillRect(win.x, win.y, win.w, TITLE_H)
    ctx.font = `12px ${linux ? LINUX_FONT : UI_FONT}`
    ctx.fillStyle = dark ? (active ? '#ffffff' : '#9a9a9a') : active ? '#1b1b1b' : '#8a8a8a'
    if (linux) {
      ctx.textAlign = 'center'
      ctx.font = `600 12px ${LINUX_FONT}`
      ctx.fillText(win.title, win.x + win.w / 2, win.y + 21)
      ctx.textAlign = 'left'
    } else ctx.fillText(win.title, win.x + 14, win.y + 21)
    // Caption buttons
    ctx.strokeStyle = dark ? '#d0d0d0' : '#404040'
    ctx.lineWidth = 1
    const right = win.x + win.w
    ctx.beginPath()
    ctx.moveTo(right - 128, win.y + 16.5)
    ctx.lineTo(right - 118, win.y + 16.5)
    ctx.strokeRect(right - 78.5, win.y + 11.5, 10, 10)
    ctx.moveTo(right - 28, win.y + 11)
    ctx.lineTo(right - 18, win.y + 21)
    ctx.moveTo(right - 18, win.y + 11)
    ctx.lineTo(right - 28, win.y + 21)
    ctx.stroke()
    // Body
    const top = win.y + TITLE_H
    if (win.id === 'notepad') this.paintNotepad(ctx, win, top)
    else if (win.id === 'terminal') this.paintTerminal(ctx, win)
    else if (win.id === 'status') this.paintStatus(ctx, win, top, dark)
    else if (win.id === 'log') this.paintLog(ctx, win, top, dark)
    else if (win.id === 'browser') this.paintBrowser(ctx, win, top)
    ctx.restore()
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.16)'
    ctx.lineWidth = 1
    rounded(ctx, win.x + 0.5, win.y + 0.5, win.w - 1, win.h - 1, linux ? 10 : 8)
    ctx.stroke()
  }

  private paintNotepad(ctx: Ctx, win: SceneWindow, top: number) {
    ctx.fillStyle = '#f9f9f9'
    ctx.fillRect(win.x, top, win.w, 28)
    ctx.font = `12px ${UI_FONT}`
    ctx.fillStyle = '#1b1b1b'
    ;['File', 'Edit', 'View'].forEach((item, index) => ctx.fillText(item, win.x + 14 + index * 44, top + 18))
    const body = this.editorBody(win)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(body.x, body.y, body.w, body.h)
    ctx.font = `14px ${MONO}`
    ctx.fillStyle = '#1b1b1b'
    const lines = this.notepad.split('\n')
    const visible = Math.floor((body.h - 12) / 21)
    const first = Math.max(0, lines.length - visible)
    lines.slice(first).forEach((line, index) => ctx.fillText(line.slice(0, Math.floor((body.w - 24) / 8.4)), body.x + 14, body.y + 24 + index * 21))
    if (this.focused === 'notepad' && this.caret) {
      const last = lines.at(-1) ?? ''
      ctx.fillStyle = '#1b1b1b'
      ctx.fillRect(body.x + 14 + Math.min(last.length, Math.floor((body.w - 24) / 8.4)) * 8.4, body.y + 10 + (lines.length - 1 - first) * 21, 1.5, 18)
    }
    ctx.fillStyle = '#f3f3f3'
    ctx.fillRect(win.x, win.y + win.h - 24, win.w, 24)
    ctx.font = `11px ${UI_FONT}`
    ctx.fillStyle = '#5c5c5c'
    ctx.fillText(`Ln ${lines.length}, Col ${(lines.at(-1)?.length ?? 0) + 1}   |   100%   |   Windows (CRLF)   |   UTF-8`, win.x + 14, win.y + win.h - 8)
  }

  private paintTerminal(ctx: Ctx, win: SceneWindow) {
    const body = this.editorBody(win)
    ctx.fillStyle = '#1e1e1e'
    ctx.fillRect(body.x, body.y, body.w, body.h)
    ctx.font = `14px ${MONO}`
    const visible = Math.floor((body.h - 12) / 20)
    const first = Math.max(0, this.terminal.length - visible)
    this.terminal.slice(first).forEach((line, index) => {
      const promptEnd = line.indexOf('$ ')
      const baseline = body.y + 24 + index * 20
      if (promptEnd > 0) {
        ctx.fillStyle = '#8ae234'
        ctx.fillText(line.slice(0, promptEnd + 1), body.x + 12, baseline)
        ctx.fillStyle = '#eeeeec'
        ctx.fillText(line.slice(promptEnd + 1), body.x + 12 + (promptEnd + 1) * 8.4, baseline)
      } else {
        ctx.fillStyle = '#d3d7cf'
        ctx.fillText(line, body.x + 12, baseline)
      }
    })
    if (this.focused === 'terminal' && this.caret) {
      const last = this.terminal.at(-1) ?? ''
      ctx.fillStyle = '#eeeeec'
      ctx.fillRect(body.x + 12 + last.length * 8.4, body.y + 10 + (this.terminal.length - 1 - first) * 20, 8, 17)
    }
  }

  private paintStatus(ctx: Ctx, win: SceneWindow, top: number, dark: boolean) {
    ctx.fillStyle = dark ? '#242424' : '#ffffff'
    ctx.fillRect(win.x, top, win.w, win.h - TITLE_H)
    // Analog clock with a sweeping second hand
    const r = Math.min(70, (win.h - TITLE_H) / 2 - 24)
    const cx = win.x + 28 + r
    const cy = top + (win.h - TITLE_H) / 2
    ctx.strokeStyle = dark ? '#555' : '#d9d9d9'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()
    for (let tick = 0; tick < 12; tick += 1) {
      const angle = (tick / 12) * Math.PI * 2
      ctx.beginPath()
      ctx.moveTo(cx + Math.sin(angle) * (r - 8), cy - Math.cos(angle) * (r - 8))
      ctx.lineTo(cx + Math.sin(angle) * (r - 2), cy - Math.cos(angle) * (r - 2))
      ctx.stroke()
    }
    const now = this.now
    const hands: [number, number, number, string][] = [
      [((now.getHours() % 12) + now.getMinutes() / 60) / 12, r * 0.5, 4, dark ? '#eee' : '#222'],
      [(now.getMinutes() + now.getSeconds() / 60) / 60, r * 0.75, 3, dark ? '#eee' : '#222'],
      [now.getSeconds() / 60, r * 0.85, 1.5, '#e8590c'],
    ]
    for (const [fraction, length, width, color] of hands) {
      const angle = fraction * Math.PI * 2
      ctx.strokeStyle = color
      ctx.lineWidth = width
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + Math.sin(angle) * length, cy - Math.cos(angle) * length)
      ctx.stroke()
    }
    ctx.lineCap = 'butt'
    // CPU graph
    const gx = cx + r + 28
    const gw = win.x + win.w - 20 - gx
    const gy = top + 34
    const gh = win.h - TITLE_H - 80
    ctx.font = `600 12px ${UI_FONT}`
    ctx.fillStyle = dark ? '#ddd' : '#1b1b1b'
    ctx.fillText(`CPU ${Math.round(this.cpu.at(-1) ?? 0)}%`, gx, top + 22)
    ctx.fillStyle = dark ? '#1a2a1a' : '#f1f8f1'
    ctx.fillRect(gx, gy, gw, gh)
    ctx.strokeStyle = '#3a9f4f'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    this.cpu.forEach((value, index) => {
      const x = gx + (index / (this.cpu.length - 1)) * gw
      const y = gy + gh - (value / 100) * gh
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
    ctx.font = `12px ${UI_FONT}`
    ctx.fillStyle = dark ? '#aaa' : '#5c5c5c'
    ctx.fillText(`Memory 9.1 / 16.0 GB`, gx, gy + gh + 22)
    ctx.fillStyle = dark ? '#333' : '#e5e5e5'
    ctx.fillRect(gx, gy + gh + 30, gw, 6)
    ctx.fillStyle = '#5ea0ef'
    ctx.fillRect(gx, gy + gh + 30, gw * 0.57, 6)
  }

  private paintLog(ctx: Ctx, win: SceneWindow, top: number, dark: boolean) {
    ctx.fillStyle = dark ? '#2a2a2a' : '#f3f3f3'
    ctx.fillRect(win.x, top, win.w, 26)
    ctx.font = `600 11px ${UI_FONT}`
    ctx.fillStyle = dark ? '#ccc' : '#444'
    ;['Level', 'Time', 'Source', 'Message'].forEach((label, index) => ctx.fillText(label, win.x + [12, 108, 180, 330][index], top + 17))
    const body = this.logBody(win)
    ctx.save()
    ctx.beginPath()
    ctx.rect(body.x, body.y, body.w, body.h)
    ctx.clip()
    ctx.fillStyle = dark ? '#202020' : '#ffffff'
    ctx.fillRect(body.x, body.y, body.w, body.h)
    const first = Math.floor(this.logScroll / LOG_ROW)
    const offset = this.logScroll % LOG_ROW
    const rows = Math.ceil(body.h / LOG_ROW) + 1
    ctx.font = `12px ${UI_FONT}`
    for (let index = 0; index < rows; index += 1) {
      const line = this.log[first + index]
      if (!line) break
      const y = body.y + index * LOG_ROW - offset
      if ((first + index) % 2 === 1) {
        ctx.fillStyle = dark ? '#252525' : '#fafafa'
        ctx.fillRect(body.x, y, body.w, LOG_ROW)
      }
      const [level, time, source, message] = line.split('\t')
      ctx.fillStyle = level === 'Warning' ? '#d18f00' : '#2f7dd1'
      ctx.beginPath()
      ctx.arc(win.x + 18, y + LOG_ROW / 2, 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = dark ? '#ddd' : '#1b1b1b'
      ctx.fillText(level, win.x + 30, y + 15)
      ctx.fillStyle = dark ? '#aaa' : '#5c5c5c'
      ctx.fillText(time, win.x + 108, y + 15)
      ctx.fillText(source.slice(0, 22), win.x + 180, y + 15)
      ctx.fillStyle = dark ? '#ddd' : '#1b1b1b'
      ctx.fillText(message.slice(0, Math.max(10, Math.floor((win.w - 340) / 6.4))), win.x + 330, y + 15)
    }
    ctx.restore()
  }

  private paintBrowser(ctx: Ctx, win: SceneWindow, top: number) {
    ctx.fillStyle = '#f7f7f7'
    ctx.fillRect(win.x, top, win.w, 40)
    ctx.fillStyle = '#ffffff'
    rounded(ctx, win.x + 90, top + 8, win.w - 180, 24, 12)
    ctx.fill()
    ctx.font = `12px ${UI_FONT}`
    ctx.fillStyle = '#5c5c5c'
    ctx.fillText('https://status.example.net/fleet', win.x + 106, top + 24)
    const bodyTop = top + 40
    ctx.fillStyle = '#0f1115'
    ctx.fillRect(win.x, bodyTop, win.w, win.h - TITLE_H - 40)
    // A big digital clock
    const now = this.now
    ctx.fillStyle = '#e7e9ec'
    ctx.font = `600 ${Math.round(win.w / 9)}px ${MONO}`
    ctx.fillText(`${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`, win.x + 36, bodyTop + Math.round(win.w / 9) + 30)
    ctx.font = `13px ${UI_FONT}`
    ctx.fillStyle = '#8f96a0'
    ctx.fillText('Fleet health · updated every second', win.x + 40, bodyTop + Math.round(win.w / 9) + 58)
    // Bars
    const bars = 16
    const bw = (win.w - 80) / bars
    const base = win.y + win.h - 30
    for (let index = 0; index < bars; index += 1) {
      const value = 0.25 + 0.6 * Math.abs(Math.sin(index * 0.7 + now.getSeconds() / 3))
      const h = value * (win.h * 0.32)
      ctx.fillStyle = index % 4 === 0 ? '#e8590c' : '#3fb8a9'
      ctx.fillRect(win.x + 40 + index * bw, base - h, bw - 6, h)
    }
  }

  private cadOptions() {
    const labels = ['Lock', 'Switch user', 'Sign out', 'Change a password', 'Task Manager']
    const x = this.width / 2 - 120
    const y = this.height / 2 - 120
    return labels.map((label, index) => ({ label, rect: { x, y: y + index * 48, w: 240, h: 40 } }))
  }

  private cadCancel(): Rect {
    return { x: this.width - 180, y: this.height - 90, w: 130, h: 36 }
  }

  private paintCad(ctx: Ctx) {
    const gradient = ctx.createLinearGradient(0, 0, 0, this.height)
    gradient.addColorStop(0, '#0b2c5e')
    gradient.addColorStop(1, '#06204a')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, this.width, this.height)
    ctx.font = `20px ${UI_FONT}`
    this.cadOptions().forEach((option, index) => {
      if (this.hoverOption === index) {
        ctx.fillStyle = 'rgba(255,255,255,0.12)'
        rounded(ctx, option.rect.x - 12, option.rect.y, option.rect.w + 24, option.rect.h, 4)
        ctx.fill()
      }
      ctx.fillStyle = '#ffffff'
      ctx.fillText(option.label, option.rect.x, option.rect.y + 27)
    })
    const cancel = this.cadCancel()
    ctx.fillStyle = 'rgba(255,255,255,0.14)'
    rounded(ctx, cancel.x, cancel.y, cancel.w, cancel.h, 4)
    ctx.fill()
    ctx.font = `15px ${UI_FONT}`
    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'center'
    ctx.fillText('Cancel', cancel.x + cancel.w / 2, cancel.y + 23)
    ctx.textAlign = 'left'
  }

  private uacButtons() {
    const dw = 460
    const dh = 300
    const x = this.width / 2 - dw / 2
    const y = this.height / 2 - dh / 2
    return { dialog: { x, y, w: dw, h: dh }, yes: { x: x + 24, y: y + dh - 56, w: 200, h: 36 }, no: { x: x + dw - 224, y: y + dh - 56, w: 200, h: 36 } }
  }

  private paintUac(ctx: Ctx) {
    ctx.fillStyle = 'rgba(0,0,0,0.58)'
    ctx.fillRect(0, 0, this.width, this.height)
    const { dialog, yes, no } = this.uacButtons()
    ctx.fillStyle = '#f3f3f3'
    ctx.fillRect(dialog.x, dialog.y, dialog.w, dialog.h)
    ctx.fillStyle = '#1b1b1b'
    ctx.font = `12px ${UI_FONT}`
    ctx.fillText('User Account Control', dialog.x + 24, dialog.y + 30)
    ctx.font = `600 18px ${UI_FONT}`
    ctx.fillText('Do you want to allow this app to make', dialog.x + 24, dialog.y + 64)
    ctx.fillText('changes to your device?', dialog.x + 24, dialog.y + 88)
    ctx.fillStyle = '#012456'
    rounded(ctx, dialog.x + 24, dialog.y + 112, 36, 36, 4)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.font = `600 16px ${MONO}`
    ctx.fillText('>_', dialog.x + 31, dialog.y + 136)
    ctx.fillStyle = '#1b1b1b'
    ctx.font = `15px ${UI_FONT}`
    ctx.fillText('Windows PowerShell', dialog.x + 72, dialog.y + 136)
    ctx.font = `12px ${UI_FONT}`
    ctx.fillStyle = '#5c5c5c'
    ctx.fillText('Verified publisher: Microsoft Windows', dialog.x + 24, dialog.y + 178)
    ctx.fillStyle = '#0067c0'
    ctx.fillText('Show more details', dialog.x + 24, dialog.y + 204)
    ctx.fillStyle = '#0067c0'
    rounded(ctx, yes.x, yes.y, yes.w, yes.h, 4)
    ctx.fill()
    ctx.fillStyle = '#e1e1e1'
    rounded(ctx, no.x, no.y, no.w, no.h, 4)
    ctx.fill()
    ctx.textAlign = 'center'
    ctx.font = `14px ${UI_FONT}`
    ctx.fillStyle = '#ffffff'
    ctx.fillText('Yes', yes.x + yes.w / 2, yes.y + 23)
    ctx.fillStyle = '#1b1b1b'
    ctx.fillText('No', no.x + no.w / 2, no.y + 23)
    ctx.textAlign = 'left'
  }

  private paintLock(ctx: Ctx) {
    const gradient = ctx.createLinearGradient(0, 0, this.width, this.height)
    gradient.addColorStop(0, '#13233d')
    gradient.addColorStop(1, '#3b6aa0')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, this.width, this.height)
    ctx.textAlign = 'center'
    ctx.fillStyle = '#ffffff'
    const now = this.now
    if (this.secure === 'lock') {
      ctx.font = `600 96px ${UI_FONT}`
      ctx.fillText(`${now.getHours() % 12 || 12}:${pad(now.getMinutes())}`, this.width / 2, this.height * 0.3)
      ctx.font = `22px ${UI_FONT}`
      ctx.fillText(now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }), this.width / 2, this.height * 0.3 + 44)
      ctx.font = `14px ${UI_FONT}`
      ctx.fillStyle = 'rgba(255,255,255,0.75)'
      ctx.fillText('Click or press a key to sign in', this.width / 2, this.height - 80)
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.18)'
      ctx.beginPath()
      ctx.arc(this.width / 2, this.height / 2 - 70, 64, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.font = `600 26px ${UI_FONT}`
      ctx.fillText(this.user ?? 'Other user', this.width / 2, this.height / 2 + 34)
      const field = this.caretRect()!
      ctx.fillStyle = 'rgba(255,255,255,0.9)'
      rounded(ctx, field.x, field.y, field.w, field.h, 4)
      ctx.fill()
      ctx.textAlign = 'left'
      ctx.font = `15px ${UI_FONT}`
      ctx.fillStyle = this.password ? '#1b1b1b' : '#6b6b6b'
      ctx.fillText(this.password ? '•'.repeat(this.password.length) : 'Password', field.x + 12, field.y + 23)
      if (this.caret) {
        ctx.fillStyle = '#1b1b1b'
        ctx.fillRect(field.x + 12 + (this.password ? this.password.length * 9 : 0), field.y + 8, 1.5, 20)
      }
      ctx.textAlign = 'center'
      ctx.font = `13px ${UI_FONT}`
      ctx.fillStyle = 'rgba(255,255,255,0.75)'
      ctx.fillText('Press Enter to sign in (mock)', this.width / 2, field.y + 64)
    }
    ctx.textAlign = 'left'
  }
}
