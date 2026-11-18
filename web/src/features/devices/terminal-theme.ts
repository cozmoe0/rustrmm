import type { ITheme } from '@xterm/xterm'
import type { ResolvedTheme } from '@/lib/theme'

/*
 * xterm needs concrete sRGB colors, so these are the design tokens from index.css resolved to hex:
 * graphite surfaces, copper cursor and selection, and the status hues (critical, success, warning,
 * info, verdigris "live") for the ANSI palette. Bright variants are the same hue, a step lighter.
 */
export const TERMINAL_THEMES: Record<ResolvedTheme, ITheme> = {
  dark: {
    background: '#0d1014',
    foreground: '#d9dce1',
    cursor: '#e97c48',
    cursorAccent: '#0d1014',
    selectionBackground: 'rgba(233, 124, 72, 0.32)',
    selectionInactiveBackground: 'rgba(233, 124, 72, 0.16)',
    scrollbarSliderBackground: 'rgba(255, 255, 255, 0.10)',
    scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.18)',
    scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.24)',
    black: '#1c2128',
    red: '#fb5f69',
    green: '#52c69f',
    yellow: '#f2b54a',
    blue: '#65b8eb',
    magenta: '#af8ceb',
    cyan: '#4dc8ba',
    white: '#c9cdd3',
    brightBlack: '#656c76',
    brightRed: '#ff8589',
    brightGreen: '#80ddbb',
    brightYellow: '#ffd17c',
    brightBlue: '#8cd1fd',
    brightMagenta: '#c6a9fc',
    brightCyan: '#7edfd2',
    brightWhite: '#f2f4f6',
  },
  light: {
    background: '#fbfbf9',
    foreground: '#1d2025',
    cursor: '#be4f1c',
    cursorAccent: '#fbfbf9',
    selectionBackground: 'rgba(190, 79, 28, 0.22)',
    selectionInactiveBackground: 'rgba(190, 79, 28, 0.12)',
    scrollbarSliderBackground: 'rgba(22, 24, 28, 0.12)',
    scrollbarSliderHoverBackground: 'rgba(22, 24, 28, 0.2)',
    scrollbarSliderActiveBackground: 'rgba(22, 24, 28, 0.26)',
    black: '#16181c',
    red: '#ce2739',
    green: '#158561',
    yellow: '#ba6900',
    blue: '#0278b6',
    magenta: '#8059bb',
    cyan: '#058277',
    white: '#8a9099',
    brightBlack: '#7f8590',
    brightRed: '#e7434d',
    brightGreen: '#359b75',
    brightYellow: '#d17f26',
    brightBlue: '#2b8ecd',
    brightMagenta: '#956ed2',
    brightCyan: '#2e978c',
    brightWhite: '#5b616c',
  },
}

export const TERMINAL_FONT = '"Monaspace Neon", ui-monospace, "SFMono-Regular", "Cascadia Mono", Menlo, Consolas, monospace'

/** Resolves once Monaspace Neon is ready so xterm measures the right cell size. */
export async function loadTerminalFont(size: number): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return
  try {
    await Promise.all([document.fonts.load(`400 ${size}px "Monaspace Neon"`), document.fonts.load(`600 ${size}px "Monaspace Neon"`)])
  } catch {
    // Fall back to the next font in the stack.
  }
}

/** Width of one cell relative to the font size, measured once for the player's scale-to-fit. */
let cellRatio: number | null = null
export function terminalCellRatio(): number {
  if (cellRatio !== null) return cellRatio
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return 0.6
  context.font = `100px ${TERMINAL_FONT}`
  const measured = context.measureText('MMMMMMMMMM').width / 1000
  cellRatio = measured > 0.3 && measured < 1 ? measured : 0.6
  return cellRatio
}
