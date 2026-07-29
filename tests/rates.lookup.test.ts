import { describe, expect, it } from 'vitest'
import { formatHts, isValidHts10, normalizeHts } from '../src/lib/calc/rates'


describe('normalizeHts / formatHts', () => {
  it('숫자만 남긴다', () => {
    expect(normalizeHts('6912.00.4810')).toBe('6912004810')
    expect(normalizeHts('*')).toBe('*')
  })
  it('10자리 검증', () => {
    expect(isValidHts10('6912.00.4810')).toBe(true)
    expect(isValidHts10('691200')).toBe(false)
  })
  it('표시 형식', () => {
    expect(formatHts('6912004810')).toBe('6912.00.4810')
    expect(formatHts(null)).toBe('—')
  })
})
