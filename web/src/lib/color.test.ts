import { describe, expect, it } from 'vitest'
import { accentVariables, applyAccent, isDefaultProductName, logoFor } from './branding'
import { accentPlan, checkAccent, contrastRatio, formatRatio, normalizeHex, parseHex, relativeLuminance } from './color'

describe('hex parsing', () => {
  it('accepts six-digit hex only', () => {
    expect(parseHex('#E07444')).toEqual({ r: 224, g: 116, b: 68 })
    expect(parseHex(' #e07444 ')).toEqual({ r: 224, g: 116, b: 68 })
    expect(parseHex('#e74')).toBeNull()
    expect(parseHex('e07444')).toBeNull()
    expect(parseHex('#e0744g')).toBeNull()
    expect(normalizeHex('#ABCDEF')).toBe('#abcdef')
  })
})

describe('contrast', () => {
  it('matches the WCAG reference values', () => {
    const white = parseHex('#ffffff')!
    const black = parseHex('#000000')!
    expect(relativeLuminance(white)).toBeCloseTo(1, 5)
    expect(relativeLuminance(black)).toBe(0)
    expect(contrastRatio(white, black)).toBeCloseTo(21, 5)
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5)
    // #767676 on white is the classic 4.54:1 AA boundary.
    expect(contrastRatio(parseHex('#767676')!, white)).toBeCloseTo(4.54, 2)
  })

  it('formats ratios without rounding up past a threshold', () => {
    expect(formatRatio(4.499)).toBe('4.49:1')
    expect(formatRatio(21)).toBe('21.00:1')
  })
})

describe('accent AA check', () => {
  it('picks the text colour that contrasts more', () => {
    expect(checkAccent('#1d4ed8', 'light')!.foreground).toBe('#ffffff')
    expect(checkAccent('#ffd400', 'dark')!.foreground).toBe('#16181c')
  })

  it('passes a dark blue in light mode but not in dark mode', () => {
    const plan = accentPlan('#1D4ED8')!
    expect(plan.accent).toBe('#1d4ed8')
    expect(plan.light.passes).toBe(true)
    expect(plan.dark.passes).toBe(false)
    expect(plan.dark.onSurface).toBeLessThan(4.5)
  })

  it('passes a bright yellow in dark mode but not in light mode', () => {
    const plan = accentPlan('#ffd400')!
    expect(plan.light.passes).toBe(false)
    expect(plan.dark.passes).toBe(true)
  })

  it('rejects malformed colours', () => {
    expect(accentPlan('orange')).toBeNull()
    expect(accentPlan(null)).toBeNull()
  })
})

describe('branding application', () => {
  it('only overrides the copper token in themes where the accent passes', () => {
    expect(accentVariables('#1d4ed8', 'light')).toEqual({ '--primary': '#1d4ed8', '--ring': '#1d4ed8', '--primary-foreground': '#ffffff' })
    expect(accentVariables('#1d4ed8', 'dark')).toBeNull()
    expect(accentVariables(null, 'light')).toBeNull()
  })

  it('sets and clears the variables on the root element', () => {
    const root = document.createElement('div')
    applyAccent('#1d4ed8', 'light', root)
    expect(root.style.getPropertyValue('--primary')).toBe('#1d4ed8')
    applyAccent('#1d4ed8', 'dark', root)
    expect(root.style.getPropertyValue('--primary')).toBe('')
  })

  it('chooses logos per surface with the light fallback', () => {
    expect(logoFor({ logo_light_url: '/l', logo_dark_url: null }, 'dark')).toBe('/l')
    expect(logoFor({ logo_light_url: '/l', logo_dark_url: '/d' }, 'dark')).toBe('/d')
    expect(logoFor({ logo_light_url: null, logo_dark_url: '/d' }, 'light')).toBeNull()
    expect(isDefaultProductName(' RustRMM ')).toBe(true)
    expect(isDefaultProductName('Lumen RMM')).toBe(false)
  })
})
