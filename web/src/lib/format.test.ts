import { describe, expect, it } from 'vitest'
import { formatBytes, formatClock, formatDuration, formatRate, formatSpan, truncateMiddle } from './format'

describe('formatBytes', () => {
  it('keeps small sizes in bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('scales through binary units with sensible precision', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(97_000_000)).toBe('92.5 MB')
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB')
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GB')
    expect(formatBytes(5 * 1024 ** 5)).toBe('5120 TB')
  })

  it('shows a dash for unknown sizes', () => {
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(undefined)).toBe('—')
  })
})

describe('formatClock', () => {
  it('formats a stopwatch', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(7.9)).toBe('0:07')
    expect(formatClock(723)).toBe('12:03')
    expect(formatClock(3723)).toBe('1:02:03')
  })

  it('treats bad input as zero', () => {
    expect(formatClock(-5)).toBe('0:00')
    expect(formatClock(Number.NaN)).toBe('0:00')
  })
})

describe('formatSpan and formatDuration', () => {
  it('uses the two most significant units', () => {
    expect(formatSpan(38)).toBe('38s')
    expect(formatSpan(252)).toBe('4m 12s')
    expect(formatSpan(240)).toBe('4m')
    expect(formatSpan(3780)).toBe('1h 3m')
    expect(formatSpan(187_200)).toBe('2d 4h')
    expect(formatSpan(null)).toBe('—')
    expect(formatDuration(59)).toBe('0m')
  })
})

describe('formatRate', () => {
  it('appends per second', () => {
    expect(formatRate(512)).toBe('512 B/s')
    expect(formatRate(1.5 * 1024 * 1024)).toBe('1.5 MB/s')
    expect(formatRate(null)).toBe('—')
  })
})

describe('truncateMiddle', () => {
  it('keeps both ends', () => {
    expect(truncateMiddle('abcdef', 2)).toBe('ab…ef')
    expect(truncateMiddle('short', 8)).toBe('short')
  })
})
