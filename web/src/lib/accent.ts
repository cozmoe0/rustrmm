const ACCENTS = ['#E07444', '#3FB8A9', '#5B9CF0', '#A47CF3', '#E2B34A', '#E5646E', '#7C8B9C', '#4FB477']

/** A deterministic accent for entities without an explicit colour. */
export function accentFor(seed: string, explicit?: string | null): string {
  if (explicit) return explicit
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return ACCENTS[hash % ACCENTS.length]
}
