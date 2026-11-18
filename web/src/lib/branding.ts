/*
 * White-label branding in the console: the product name (tab titles, chrome) and the accent colour,
 * which replaces the copper `--primary` token only in the themes where it passes the AA check.
 */
import type { PublicBranding } from '@/lib/api/types'
import { accentPlan, type ThemeName } from './color'
import { formatBytes } from './format'
import { createStore, useStore } from './store'

export const DEFAULT_PRODUCT_NAME = 'RustRMM'

/** Remembered so tab titles are right before `GET /branding` answers. */
export const productNameStore = createStore<string>(DEFAULT_PRODUCT_NAME, {
  key: 'rustrmm.product-name',
  serialize: (value) => value,
  deserialize: (raw) => (raw.trim() ? raw.slice(0, 60) : undefined),
})

export function useProductName(): string {
  return useStore(productNameStore)
}

/** Whether the product still carries the default name (the two-tone RustRMM wordmark applies). */
export function isDefaultProductName(name: string): boolean {
  return name.trim() === DEFAULT_PRODUCT_NAME
}

export const ACCENT_VARS = ['--primary', '--ring', '--primary-foreground'] as const

/** CSS variables to set for an accent in a theme, or null to keep the copper token. */
export function accentVariables(accent: string | null | undefined, theme: ThemeName): Record<(typeof ACCENT_VARS)[number], string> | null {
  const plan = accentPlan(accent)
  if (!plan) return null
  const check = plan[theme]
  if (!check.passes) return null
  return { '--primary': plan.accent, '--ring': plan.accent, '--primary-foreground': check.foreground }
}

/** Applies (or clears) the accent on `<html>` for the resolved theme. */
export function applyAccent(accent: string | null | undefined, theme: ThemeName, root: HTMLElement = document.documentElement) {
  const vars = accentVariables(accent, theme)
  for (const name of ACCENT_VARS) {
    if (vars) root.style.setProperty(name, vars[name])
    else root.style.removeProperty(name)
  }
}

/** The logo for a surface: the rail and dark theme use the dark logo (which falls back to light). */
export function logoFor(branding: Pick<PublicBranding, 'logo_light_url' | 'logo_dark_url'> | undefined, surface: ThemeName): string | null {
  if (!branding) return null
  return surface === 'dark' ? (branding.logo_dark_url ?? branding.logo_light_url) : branding.logo_light_url
}

export const LOGO_MAX_BYTES = 512 * 1024

/** Why a file can't be a logo, before uploading it. */
export function logoFileError(file: Pick<File, 'name' | 'type' | 'size'>): string | null {
  const svg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)
  const png = file.type === 'image/png' || /\.png$/i.test(file.name)
  if (!svg && !png) return 'Use a PNG or SVG file'
  if (file.size > LOGO_MAX_BYTES) return `The file is ${formatBytes(file.size)}; logos are limited to 512 KB`
  if (file.size === 0) return 'The file is empty'
  return null
}

