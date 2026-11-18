import { describe, expect, it } from 'vitest'
import { checkRange, checkRanges, compareIp, formatIPv4, ipInRange, isPrivateAddress, parseIPv4, parsePorts, parseRange } from './cidr'

describe('IPv4 ranges', () => {
  it('parses addresses strictly', () => {
    expect(parseIPv4('192.168.1.10')).toBe(0xc0a8010a)
    expect(formatIPv4(0xc0a8010a)).toBe('192.168.1.10')
    for (const bad of ['192.168.1', '256.1.1.1', '1.2.3.4.5', '01.2.3.4', 'a.b.c.d', '']) expect(parseIPv4(bad)).toBeNull()
  })

  it('parses CIDR and single addresses with their size', () => {
    expect(parseRange('192.168.1.0/24')).toMatchObject({ prefix: 24, size: 256, normalized: '192.168.1.0/24', hostBits: false })
    expect(parseRange('10.0.0.0/20')?.size).toBe(4096)
    expect(parseRange('10.0.0.7')).toMatchObject({ prefix: 32, size: 1, normalized: '10.0.0.7' })
    expect(parseRange('192.168.1.77/24')).toMatchObject({ normalized: '192.168.1.0/24', hostBits: true })
    expect(parseRange('10.0.0.0/33')).toBeNull()
    expect(parseRange('10.0.0.0/2/4')).toBeNull()
  })

  it('limits each range to a /20', () => {
    expect(checkRange('10.0.0.0/20').error).toBeNull()
    expect(checkRange('10.0.0.0/19').error).toMatch(/8,192 addresses/)
    expect(checkRange('10.0.0.0/8').error).toMatch(/\/20/)
  })

  it('applies the private rule unless public ranges are allowed', () => {
    for (const range of ['10.1.2.0/24', '172.16.5.0/24', '192.168.0.0/20', '100.64.10.0/24', '169.254.1.0/24']) expect(checkRange(range).error).toBeNull()
    expect(checkRange('8.8.8.0/24').error).toMatch(/not a private range/)
    expect(checkRange('172.32.0.0/24').error).toMatch(/not a private range/)
    expect(checkRange('127.0.0.0/24').error).toMatch(/Loopback/)
    const allowed = checkRange('8.8.8.0/24', true)
    expect(allowed.error).toBeNull()
    expect(allowed.warning).toMatch(/not a private range/)
    expect(isPrivateAddress('10.60.1.25')).toBe(true)
    expect(isPrivateAddress('1.1.1.1')).toBe(false)
  })

  it('warns about host bits and catches duplicates and overlaps', () => {
    expect(checkRange('192.168.1.5/24').warning).toMatch(/192\.168\.1\.0\/24/)
    const { checks, total, listError } = checkRanges(['10.0.0.0/24', '10.0.0.0/24', '10.0.0.128/25', '10.0.1.0/24'])
    expect(listError).toBeNull()
    expect(checks[1].error).toBe('Listed twice')
    expect(checks[2].error).toBe('Overlaps 10.0.0.0/24')
    expect(checks[3].error).toBeNull()
    expect(total).toBe(512)
    expect(checkRanges([]).listError).toMatch(/at least one/)
    expect(checkRanges(Array.from({ length: 17 }, (_, index) => `10.0.${index}.0/24`)).listError).toMatch(/16/)
  })

  it('parses port lists and sorts addresses numerically', () => {
    expect(parsePorts('443, 22 80;80')).toEqual({ ports: [22, 80, 443], error: null })
    expect(parsePorts('22, http').error).toMatch(/http/)
    expect(parsePorts('70000').error).toMatch(/outside/)
    expect(parsePorts(Array.from({ length: 65 }, (_, index) => index + 1).join(',')).error).toMatch(/64/)
    expect(['10.0.0.20', '10.0.0.3', '10.0.0.100'].sort(compareIp)).toEqual(['10.0.0.3', '10.0.0.20', '10.0.0.100'])
    expect(ipInRange('10.12.1.20', '10.12.1.0/24')).toBe(true)
    expect(ipInRange('10.12.2.20', '10.12.1.0/24')).toBe(false)
  })
})
