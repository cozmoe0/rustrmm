/*
 * Colour maths for the white-label accent: hex parsing, WCAG 2.x relative luminance and contrast,
 * and the per-theme AA check that decides whether a branding accent may replace the copper token.
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

/** `#rrggbb` (case-insensitive) → channels 0–255, or null. The API accepts only six-digit hex. */
export function parseHex(value: string | null | undefined): Rgb | null {
  const match = /^#([0-9a-f]{6})$/i.exec((value ?? '').trim())
  if (!match) return null
  const int = Number.parseInt(match[1], 16)
  return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff }
}

export function toHex({ r, g, b }: Rgb): string {
  const part = (value: number) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

export function normalizeHex(value: string): string | null {
  const rgb = parseHex(value)
  return rgb ? toHex(rgb) : null
}

/** WCAG relative luminance (sRGB). */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (value: number) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** Contrast ratio between two colours, 1–21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [light, dark] = la > lb ? [la, lb] : [lb, la]
  return (light + 0.05) / (dark + 0.05)
}

/** AA for normal text. */
export const AA_TEXT = 4.5

export type ThemeName = 'light' | 'dark'

/**
 * The theme surfaces the accent is checked against (the `--background` and `--card` tokens) and the
 * text colours it may carry on buttons: white, or the near-black foreground.
 */
export const THEME_SURFACES: Record<ThemeName, { background: string; card: string }> = {
  light: { background: '#f7f7f5', card: '#ffffff' },
  dark: { background: '#0c0e11', card: '#111419' },
}
export const ON_ACCENT = { light: '#ffffff', dark: '#16181c' } as const

export interface AccentCheck {
  theme: ThemeName
  /** The text colour used on accent-filled controls (whichever contrasts more). */
  foreground: string
  /** Accent against that text colour (buttons, badges). */
  onAccent: number
  /** Accent as text, icons and focus rings against the page and card surfaces (the lower of the two). */
  onSurface: number
  passes: boolean
}

/** Checks one theme: both ratios must reach AA (4.5:1). */
export function checkAccent(accent: string, theme: ThemeName): AccentCheck | null {
  const rgb = parseHex(accent)
  if (!rgb) return null
  const white = parseHex(ON_ACCENT.light)!
  const ink = parseHex(ON_ACCENT.dark)!
  const onWhite = contrastRatio(rgb, white)
  const onInk = contrastRatio(rgb, ink)
  const foreground = onWhite >= onInk ? ON_ACCENT.light : ON_ACCENT.dark
  const onAccent = Math.max(onWhite, onInk)
  const surfaces = THEME_SURFACES[theme]
  const onSurface = Math.min(contrastRatio(rgb, parseHex(surfaces.background)!), contrastRatio(rgb, parseHex(surfaces.card)!))
  return { theme, foreground, onAccent, onSurface, passes: onAccent >= AA_TEXT && onSurface >= AA_TEXT }
}

export interface AccentPlan {
  accent: string
  light: AccentCheck
  dark: AccentCheck
}

/** Both theme checks for an accent, or null when it is not `#rrggbb`. */
export function accentPlan(accent: string | null | undefined): AccentPlan | null {
  const normalized = accent ? normalizeHex(accent) : null
  if (!normalized) return null
  return { accent: normalized, light: checkAccent(normalized, 'light')!, dark: checkAccent(normalized, 'dark')! }
}

/** "4.83:1" */
export function formatRatio(ratio: number): string {
  return `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`
}
