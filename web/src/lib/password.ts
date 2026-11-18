export interface PasswordStrength {
  /** 0 (very weak) to 4 (strong). */
  score: 0 | 1 | 2 | 3 | 4
  label: string
  hints: string[]
}

const COMMON = ['password', 'qwerty', '123456', 'letmein', 'welcome', 'admin', 'rustrmm', 'iloveyou']

export const MIN_PASSWORD_LENGTH = 12

/** Lightweight client-side estimate; the server enforces the real policy. */
export function passwordStrength(password: string): PasswordStrength {
  const hints: string[] = []
  if (!password) return { score: 0, label: 'Enter a password', hints }

  let points = 0
  if (password.length >= MIN_PASSWORD_LENGTH) points += 1
  else hints.push(`Use at least ${MIN_PASSWORD_LENGTH} characters`)
  if (password.length >= 16) points += 1
  if (password.length >= 22) points += 1

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length
  if (classes >= 3) points += 1
  else hints.push('Mix upper and lower case, numbers and symbols — or use a long passphrase')

  const lower = password.toLowerCase()
  if (COMMON.some((word) => lower.includes(word))) {
    points -= 2
    hints.push('Avoid common words and patterns')
  }
  if (/(.)\1{3,}/.test(password)) {
    points -= 1
    hints.push('Avoid repeated characters')
  }

  const labels = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'] as const
  const clamped = Math.max(0, Math.min(4, points))
  // Anything shorter than the minimum can never rate above "Weak".
  const score = (password.length < MIN_PASSWORD_LENGTH ? Math.min(clamped, 1) : clamped) as PasswordStrength['score']
  return { score, label: labels[score], hints }
}

/** A random passphrase-like password for new accounts (shown once, user changes it later). */
export function generatePassword(length = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_!@#%'
  const bytes = new Uint32Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}
