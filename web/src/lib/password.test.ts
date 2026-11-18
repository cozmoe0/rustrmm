import { describe, expect, it } from 'vitest'
import { generatePassword, passwordStrength } from './password'

describe('password strength', () => {
  it('caps short passwords at weak', () => {
    expect(passwordStrength('Sh0rt!').score).toBeLessThanOrEqual(1)
    expect(passwordStrength('').label).toBe('Enter a password')
  })

  it('rates long mixed passwords as strong and penalises common words', () => {
    expect(passwordStrength('Plum-Harbor-Lantern-42!').score).toBe(4)
    expect(passwordStrength('password-password-1').score).toBeLessThan(passwordStrength('quartz-meadow-ripple-1').score)
  })

  it('generates passwords of the requested length', () => {
    expect(generatePassword(24)).toHaveLength(24)
    expect(generatePassword()).not.toBe(generatePassword())
  })
})
