/*
 * Mock interactive shell over MSW's WebSocket support. Speaks the real protocol (binary VT output,
 * JSON control frames, resize) with a tiny fake prompt per shell, and records an asciicast.
 */
import { ws } from 'msw/ws'
import { db, persist } from './db'
import type { MockDevice } from './devices'
import type { MockRemoteSession } from './remote-data'
import { isDesktopSession } from './desktop-stream'
import { emitMockEvent } from './stream'

export interface ShellTicketInfo {
  ticket: string
  sessionId: string
  deviceId: string
  shell: string
  cols: number
  rows: number
  expires: number
}

/** Tickets issued by `POST /devices/:id/shell`, valid once for 30 s. */
export const shellTickets = new Map<string, ShellTicketInfo>()

const live = new Map<string, (reason: string) => void>()

/** Ends a live mock shell (used by `POST /remote-sessions/:id/end`). Returns false when none is open. */
export function endMockShell(sessionId: string, reason: string): boolean {
  const end = live.get(sessionId)
  if (!end) return false
  end(reason)
  return true
}

const MAX_RECORDING = 160_000
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function shellTitle(shell: string) {
  return shell === 'powershell' ? 'Windows PowerShell' : shell === 'pwsh' ? 'PowerShell 7' : shell === 'cmd' ? 'Command Prompt' : shell
}

class FakeShell {
  private line = ''
  private history: string[] = []
  private historyIndex = 0
  private cwd: string
  private escape = ''
  cols: number
  rows: number

  constructor(
    private device: MockDevice,
    private shell: string,
    cols: number,
    rows: number,
    private write: (text: string) => void,
    private exit: (code: number) => void,
  ) {
    this.cols = cols
    this.rows = rows
    this.cwd = device.os_family === 'windows' ? 'C:\\Windows\\system32' : device.os_family === 'macos' ? '/var/root' : '/root'
  }

  private get windows() {
    return this.device.os_family === 'windows'
  }

  private get powershell() {
    return this.shell === 'powershell' || this.shell === 'pwsh'
  }

  banner() {
    if (this.shell === 'powershell') {
      this.write('Windows PowerShell\r\nCopyright (C) Microsoft Corporation. All rights reserved.\r\n\r\nInstall the latest PowerShell for new features and improvements! https://aka.ms/PSWindows\r\n\r\n')
    } else if (this.shell === 'pwsh') {
      this.write('PowerShell 7.5.4\r\n')
    } else if (this.shell === 'cmd') {
      this.write(`Microsoft Windows [Version ${this.device.os_version}.6899]\r\n(c) Microsoft Corporation. All rights reserved.\r\n\r\n`)
    } else if (this.device.os_family === 'macos') {
      this.write(`Last login: ${new Date(Date.now() - 86_400_000).toDateString()} on ttys000\r\n`)
    } else {
      this.write(`Welcome to ${this.device.os_name} (GNU/Linux ${this.device.os_version} x86_64)\r\n\r\n * Management: RustRMM remote shell (mock)\r\n\r\n`)
    }
    this.write(`\x1b[2mThis is a simulated shell. Type \x1b[0;1mhelp\x1b[0;2m to see what it understands.\x1b[0m\r\n`)
    this.prompt()
  }

  private promptText() {
    if (this.powershell) return `PS ${this.cwd}> `
    if (this.shell === 'cmd') return `${this.cwd}>`
    const home = this.device.os_family === 'macos' ? '/var/root' : '/root'
    const shown = this.cwd === home ? '~' : this.cwd
    if (this.shell === 'sh') return '# '
    if (this.shell === 'zsh' || this.device.os_family === 'macos') return `\x1b[1m${this.device.hostname}\x1b[0m:${shown} root# `
    return `\x1b[01;31mroot@${this.device.hostname}\x1b[00m:\x1b[01;34m${shown}\x1b[00m# `
  }

  prompt() {
    this.write(this.promptText())
  }

  input(data: string) {
    for (const char of data) {
      if (this.escape) {
        this.escape += char
        // ESC [ params final-byte (CSI); the ESC itself is checked when the sequence starts.
        if (/^.(\[[0-9;?]*[A-Za-z~]|O[A-Za-z])$/.test(this.escape) || this.escape.length > 8) {
          this.handleEscape(this.escape)
          this.escape = ''
        }
        continue
      }
      if (char === '\x1b') {
        this.escape = char
      } else if (char === '\r' || char === '\n') {
        this.write('\r\n')
        const command = this.line
        this.line = ''
        if (command.trim()) {
          this.history.push(command)
          this.historyIndex = this.history.length
        }
        if (!this.run(command.trim())) return
        this.prompt()
      } else if (char === '\x7f' || char === '\b') {
        if (this.line.length > 0) {
          this.line = this.line.slice(0, -1)
          this.write('\b \b')
        }
      } else if (char === '\x03') {
        this.write('^C\r\n')
        this.line = ''
        this.prompt()
      } else if (char === '\x04') {
        if (!this.line) {
          this.write(this.powershell || this.shell === 'cmd' ? '' : 'exit\r\n')
          this.exit(0)
          return
        }
      } else if (char === '\x0c') {
        this.write('\x1b[2J\x1b[H')
        this.prompt()
        this.write(this.line)
      } else if (char === '\t') {
        this.write('\x07')
      } else if (char >= ' ') {
        this.line += char
        this.write(char)
      }
    }
  }

  private handleEscape(sequence: string) {
    const up = sequence === '\x1b[A' || sequence === '\x1bOA'
    const down = sequence === '\x1b[B' || sequence === '\x1bOB'
    if (up || down) {
      if (this.history.length === 0) return
      this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + (up ? -1 : 1)))
      const next = this.history[this.historyIndex] ?? ''
      this.write('\b \b'.repeat(this.line.length))
      this.line = next
      this.write(next)
    }
  }

  /** Runs a command; returns false when the shell exited. */
  private run(command: string): boolean {
    if (!command) return true
    const [name, ...args] = command.split(/\s+/)
    const lower = name.toLowerCase()
    const out = (text: string) => this.write(`${text.replace(/\r?\n/g, '\r\n')}\r\n`)
    const host = this.device.hostname

    if (lower === 'exit' || lower === 'logout') {
      const code = Number(args[0]) || 0
      if (!this.windows) this.write('logout\r\n')
      this.exit(code)
      return false
    }
    if (lower === 'help' || lower === 'get-help') {
      out(
        `\x1b[1mSimulated ${shellTitle(this.shell)}\x1b[0m — commands this mock understands:\n  ${(this.windows ? ['hostname', 'whoami', 'ipconfig', this.powershell ? 'Get-Date' : 'date /t', 'dir', 'cd <path>', this.powershell ? 'Get-Service <name>' : 'ver', this.powershell ? 'Get-Process' : 'tasklist', 'echo <text>', this.powershell ? '$Host.UI.RawUI.WindowSize' : 'mode con', 'cls', 'exit [code]'] : ['hostname', 'whoami', 'uname -a', 'uptime', 'date', 'pwd', 'ls', 'cd <path>', 'df -h', 'free -h', 'echo <text>', 'stty size', 'clear', 'exit [code]']).join('\n  ')}`,
      )
      return true
    }
    if (lower === 'clear' || lower === 'cls' || lower === 'clear-host') {
      this.write('\x1b[2J\x1b[3J\x1b[H')
      return true
    }
    if (lower === 'hostname') {
      out(host)
      return true
    }
    if (lower === 'whoami') {
      out(this.windows ? 'nt authority\\system' : 'root')
      return true
    }
    if (lower === 'echo' || lower === 'write-output' || lower === 'write-host') {
      out(args.join(' ').replace(/^["']|["']$/g, ''))
      return true
    }
    if (lower === 'pwd' || lower === 'get-location') {
      out(this.powershell ? `\nPath\n----\n${this.cwd}\n` : this.cwd)
      return true
    }
    if (lower === 'cd' || lower === 'set-location' || lower === 'chdir') {
      const target = args.join(' ').replace(/^["']|["']$/g, '')
      if (!target) {
        if (this.shell === 'cmd') out(this.cwd)
        else this.cwd = this.windows ? this.cwd : this.device.os_family === 'macos' ? '/var/root' : '/root'
        return true
      }
      const sep = this.windows ? '\\' : '/'
      if (target === '..') {
        const index = this.cwd.lastIndexOf(sep)
        this.cwd = index <= 2 && this.windows ? this.cwd.slice(0, 3) : index <= 0 ? '/' : this.cwd.slice(0, index)
      } else if (target === '~') {
        this.cwd = this.device.os_family === 'macos' ? '/var/root' : '/root'
      } else {
        const absolute = this.windows ? /^[a-zA-Z]:/.test(target) : target.startsWith('/')
        this.cwd = absolute ? target : `${this.cwd.replace(/[\\/]$/, '')}${sep}${target}`
      }
      return true
    }
    if (this.windows) return this.runWindows(lower, name, args, out)
    return this.runUnix(lower, args, command, out)
  }

  private runWindows(lower: string, name: string, args: string[], out: (text: string) => void): boolean {
    const ip = this.device.last_ip ?? '10.0.0.10'
    if (lower === 'ipconfig') {
      out(`\nWindows IP Configuration\n\n\nEthernet adapter Ethernet:\n\n   Connection-specific DNS Suffix  . : ${this.device.domain ?? ''}\n   IPv4 Address. . . . . . . . . . . : ${ip}\n   Subnet Mask . . . . . . . . . . . : 255.255.255.0\n   Default Gateway . . . . . . . . . : ${ip.split('.').slice(0, 3).join('.')}.1\n`)
      return true
    }
    if (lower === 'get-date' || lower === 'date') {
      out(new Date().toString())
      return true
    }
    if (lower === 'ver') {
      out(`\nMicrosoft Windows [Version ${this.device.os_version}.6899]\n`)
      return true
    }
    if (lower === 'dir' || lower === 'ls' || lower === 'get-childitem' || lower === 'gci') {
      const items = ['config', 'drivers', 'en-US', 'LogFiles', 'Tasks', 'WindowsPowerShell']
      if (this.powershell) {
        out(`\n    Directory: ${this.cwd}\n\n\x1b[1mMode                 LastWriteTime         Length Name\x1b[0m\n----                 -------------         ------ ----\n${items.map((item) => `d----          11/12/2026  9:14 AM                \x1b[44;1m${item}\x1b[0m`).join('\n')}\n-a---          10/30/2026  2:02 PM         323584 cmd.exe\n-a---          10/30/2026  2:02 PM         360448 notepad.exe\n`)
      } else {
        out(` Volume in drive C has no label.\n Volume Serial Number is 4A1C-7F2E\n\n Directory of ${this.cwd}\n\n${items.map((item) => `11/12/2026  09:14 AM    <DIR>          ${item}`).join('\n')}\n10/30/2026  02:02 PM           323,584 cmd.exe\n               1 File(s)        323,584 bytes\n               ${items.length} Dir(s)  ${(this.device.disk_pct ? (100 - this.device.disk_pct) * 4.1e9 : 1.2e11).toLocaleString('en-US', { maximumFractionDigits: 0 })} bytes free\n`)
      }
      return true
    }
    if (lower === 'get-service' || lower === 'gsv') {
      const target = (args[0] ?? 'Spooler').replace(/^["']|["']$/g, '')
      out(`\nStatus   Name               DisplayName\n------   ----               -----------\n\x1b[32mRunning\x1b[0m  ${target.padEnd(18)} ${target === 'Spooler' ? 'Print Spooler' : target}\n`)
      return true
    }
    if (lower === 'get-process' || lower === 'gps' || lower === 'tasklist') {
      out(`\n NPM(K)    PM(M)      WS(M)     CPU(s)      Id  SI ProcessName\n ------    -----      -----     ------      --  -- -----------\n     38    24.10      31.88      12.41    3812   0 rustrmm-agent\n     62   236.20     248.02     901.33    4120   0 MsMpEng\n     21    18.34      22.61       2.03     912   0 svchost\n     93   168.11     201.44      44.90    6624   1 explorer\n`)
      return true
    }
    if (lower === '$host.ui.rawui.windowsize' || (lower === 'mode' && args[0]?.toLowerCase() === 'con')) {
      out(this.powershell ? `\nWidth Height\n----- ------\n${String(this.cols).padStart(5)} ${String(this.rows).padStart(6)}\n` : `\nStatus for device CON:\n----------------------\n    Lines:          ${this.rows}\n    Columns:        ${this.cols}\n`)
      return true
    }
    if (this.powershell) {
      out(`\x1b[31;1m${name}: The term '${name}' is not recognized as a name of a cmdlet, function, script file, or executable program.\nCheck the spelling of the name, or if a path was included, verify that the path is correct and try again.\x1b[0m`)
    } else {
      out(`'${name}' is not recognized as an internal or external command,\noperable program or batch file.\n`)
    }
    return true
  }

  private runUnix(lower: string, args: string[], command: string, out: (text: string) => void): boolean {
    const mac = this.device.os_family === 'macos'
    if (lower === 'uname') {
      out(args.includes('-a') ? (mac ? `Darwin ${this.device.hostname} ${this.device.os_version} Darwin Kernel Version 25.1.0: root:xnu-12377.41.6~2/RELEASE_ARM64_T6041 arm64` : `Linux ${this.device.hostname} ${this.device.os_version} #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux`) : mac ? 'Darwin' : 'Linux')
      return true
    }
    if (lower === 'uptime') {
      const days = Math.floor((this.device.uptime_s ?? 86_400) / 86_400)
      out(` ${new Date().toTimeString().slice(0, 8)} up ${days} days,  3:12,  1 user,  load average: 0.${Math.round(this.device.cpu_pct ?? 12)}, 0.31, 0.27`)
      return true
    }
    if (lower === 'date') {
      out(new Date().toUTCString())
      return true
    }
    if (lower === 'ls') {
      const target = args.find((arg) => !arg.startsWith('-')) ?? this.cwd
      const entries = target === '/' ? ['bin', 'boot', 'etc', 'home', 'opt', 'root', 'srv', 'tmp', 'usr', 'var'] : ['.cache', 'notes.txt', 'scripts']
      out(entries.filter((entry) => args.includes('-a') || args.includes('-la') || !entry.startsWith('.')).map((entry) => (entry.includes('.') && !entry.startsWith('.') ? entry : `\x1b[01;34m${entry}\x1b[0m`)).join('  '))
      return true
    }
    if (lower === 'df') {
      out(`Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1       ${mac ? '460' : '196'}G   ${Math.round((this.device.disk_pct ?? 50) * 1.96)}G   ${Math.round((100 - (this.device.disk_pct ?? 50)) * 1.96)}G  ${Math.round(this.device.disk_pct ?? 50)}% /\ntmpfs           3.9G     0  3.9G   0% /dev/shm`)
      return true
    }
    if (lower === 'free') {
      out(`               total        used        free      shared  buff/cache   available\nMem:            15Gi       ${Math.round((this.device.mem_pct ?? 50) * 0.15)}Gi       2.1Gi       210Mi       4.4Gi       ${Math.round((100 - (this.device.mem_pct ?? 50)) * 0.15)}Gi\nSwap:          4.0Gi          0B       4.0Gi`)
      return true
    }
    if (lower === 'stty' && args[0] === 'size') {
      out(`${this.rows} ${this.cols}`)
      return true
    }
    if (lower === 'tput' && (args[0] === 'cols' || args[0] === 'lines')) {
      out(String(args[0] === 'cols' ? this.cols : this.rows))
      return true
    }
    if (lower === 'cat' && args[0] === '/etc/os-release') {
      out(`PRETTY_NAME="${this.device.os_name}"\nVERSION_ID="${this.device.os_version}"`)
      return true
    }
    if (lower === 'sudo') {
      out('sudo: you are already root')
      return true
    }
    const label = this.shell === 'zsh' || mac ? 'zsh' : this.shell === 'sh' ? 'sh' : 'bash'
    out(label === 'zsh' ? `zsh: command not found: ${command.split(/\s+/)[0]}` : `${label}: ${command.split(/\s+/)[0]}: command not found`)
    return true
  }
}

/** Bytes from the browser arrive as ArrayBuffer, a typed array or (rarely) a Blob or string. */
async function frameText(data: unknown): Promise<string | null> {
  if (typeof data === 'string') return null
  if (data instanceof ArrayBuffer) return decoder.decode(new Uint8Array(data))
  if (ArrayBuffer.isView(data)) return decoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  if (data instanceof Blob) return decoder.decode(new Uint8Array(await data.arrayBuffer()))
  return null
}

export const shellLink = ws.link('*/api/v1/remote-sessions/:sessionId/ws')

export const shellSocketHandler = shellLink.addEventListener('connection', ({ client, params }) => {
  const sessionId = String(params.sessionId)
  // Every matching WebSocket handler sees the connection; remote desktops are served elsewhere.
  if (isDesktopSession(sessionId)) return
  const url = new URL(client.url)
  const info = shellTickets.get(sessionId)
  const session = db.remoteSessions.find((item) => item.id === sessionId) as MockRemoteSession | undefined
  const device = db.devices.find((item) => item.id === info?.deviceId)
  let closed = false
  const timers: number[] = []
  const started = performance.now()
  const recording: string[] = []
  let recordingBytes = 0

  const sendJson = (message: object) => !closed && client.send(JSON.stringify(message))
  const sendText = (text: string) => {
    if (closed) return
    const bytes = encoder.encode(text)
    client.send(bytes)
    if (session) session.bytes_from_device += bytes.byteLength
    if (recordingBytes < MAX_RECORDING) {
      const line = JSON.stringify([Number(((performance.now() - started) / 1000).toFixed(6)), 'o', text])
      recording.push(line)
      recordingBytes += line.length
    }
  }

  const finish = (reason: string, code?: number) => {
    if (closed) return
    if (code !== undefined) sendJson({ type: 'exit', code })
    sendJson({ type: 'closed', reason })
    closed = true
    timers.forEach((timer) => window.clearTimeout(timer))
    live.delete(sessionId)
    if (session) {
      session.live = false
      session.ended_at = new Date().toISOString()
      session.end_reason = reason
      if (recording.length > 0 && info) {
        const header = JSON.stringify({
          version: 2,
          width: info.cols,
          height: info.rows,
          timestamp: Math.floor(Date.parse(session.connected_at ?? session.started_at) / 1000),
          title: `${info.shell} on ${session.hostname}`,
          env: { SHELL: info.shell, TERM: 'xterm-256color' },
        })
        const text = `${header}\n${recording.join('\n')}\n`
        session.has_recording = true
        session.recording_bytes = text.length
        db.recordings[session.id] = text
        // Keep localStorage small: only the latest recordings made in the mock survive a reload.
        const ids = Object.keys(db.recordings)
        for (const id of ids.slice(0, Math.max(0, ids.length - 6))) delete db.recordings[id]
      }
      persist()
      emitMockEvent('remote.session', { session_id: session.id, device_id: session.device_id, status: 'ended', kind: 'shell' })
    }
    window.setTimeout(() => client.close(1000, reason.slice(0, 120)), 30)
  }

  if (!info || !device || !session || url.searchParams.get('ticket') !== info.ticket || info.expires < Date.now()) {
    client.send(JSON.stringify({ type: 'error', message: 'The session ticket is invalid or has expired.' }))
    client.send(JSON.stringify({ type: 'closed', reason: 'Invalid ticket' }))
    window.setTimeout(() => client.close(1008, 'Invalid ticket'), 30)
    return
  }
  // Tickets work once.
  shellTickets.delete(sessionId)

  const shell = new FakeShell(
    device,
    info.shell,
    info.cols,
    info.rows,
    sendText,
    (code) => finish(code === 0 ? 'The shell exited.' : `The shell exited with code ${code}.`, code),
  )

  live.set(sessionId, (reason) => {
    sendText(`\r\n\x1b[33m${reason}\x1b[0m\r\n`)
    finish(reason)
  })

  client.addEventListener('message', (event) => {
    if (closed) return
    if (typeof event.data === 'string') {
      try {
        const message = JSON.parse(event.data) as { type?: string; cols?: number; rows?: number }
        if (message.type === 'resize' && message.cols && message.rows) {
          shell.cols = message.cols
          shell.rows = message.rows
          if (recordingBytes < MAX_RECORDING) recording.push(JSON.stringify([Number(((performance.now() - started) / 1000).toFixed(6)), 'r', `${message.cols}x${message.rows}`]))
        }
      } catch {
        // ignore
      }
      return
    }
    void frameText(event.data).then((text) => {
      if (text === null || closed) return
      if (session) session.bytes_to_device += encoder.encode(text).byteLength
      shell.input(text)
    })
  })

  client.addEventListener('close', () => {
    if (!closed) finish('Closed by operator')
  })

  // Connection progress, then the prompt.
  timers.push(window.setTimeout(() => sendJson({ type: 'status', message: 'Waiting for the agent to open a tunnel…' }), 120))
  timers.push(window.setTimeout(() => sendJson({ type: 'status', message: `Starting ${shellTitle(info.shell)}…` }), 650))
  timers.push(
    window.setTimeout(() => {
      if (closed) return
      session.connected_at = new Date().toISOString()
      session.live = true
      persist()
      emitMockEvent('remote.session', { session_id: session.id, device_id: session.device_id, status: 'active', kind: 'shell' })
      sendJson({ type: 'ready' })
      shell.banner()
    }, 1200),
  )
})
