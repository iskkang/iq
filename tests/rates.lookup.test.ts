import { describe, expect, it } from 'vitest'
import { formatHts, isValidHts10, lookupLayerRate, normalizeHts } from '../src/lib/calc/rates'
import type { RateRow } from '../src/lib/calc/types'

const row = (partial: Partial<RateRow>): RateRow => ({
  hts_code: '6912004810',
  origin_country: null,
  layer: 'base_mfn',
  ad_valorem_rate: 0.098,
  effective_from: '2025-01-01',
  effective_to: null,
  ...partial,
})

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

describe('lookupLayerRate — 발효일', () => {
  it('asOf 이전에 발효된 행만 적용', () => {
    const ledger = [row({ effective_from: '2026-09-01', ad_valorem_rate: 0.2 })]
    const r = lookupLayerRate(ledger, 'base_mfn', '6912004810', 'CN', '2026-07-01')
    expect(r.rate).toBe(0)
    expect(r.matched_hts).toBeNull()
  })

  it('effective_to 가 지난 행은 제외', () => {
    const ledger = [row({ effective_to: '2025-12-31', ad_valorem_rate: 0.2 })]
    const r = lookupLayerRate(ledger, 'base_mfn', '6912004810', 'CN', '2026-07-01')
    expect(r.rate).toBe(0)
  })

  it('세율 개정: 같은 조건이면 최신 effective_from 이 이긴다', () => {
    const ledger = [
      row({ effective_from: '2025-01-01', ad_valorem_rate: 0.098 }),
      row({ effective_from: '2026-03-01', ad_valorem_rate: 0.12 }),
    ]
    expect(lookupLayerRate(ledger, 'base_mfn', '6912004810', 'CN', '2026-07-01').rate).toBe(0.12)
    // 개정 전 기준일이면 이전 세율
    expect(lookupLayerRate(ledger, 'base_mfn', '6912004810', 'CN', '2026-01-15').rate).toBe(0.098)
  })
})

describe('lookupLayerRate — HTS 프리픽스·원산지 우선순위', () => {
  it('긴 프리픽스(10) > 짧은 프리픽스(6)', () => {
    const ledger = [
      row({ hts_code: '691200', ad_valorem_rate: 0.05 }),
      row({ hts_code: '6912004810', ad_valorem_rate: 0.098 }),
    ]
    expect(lookupLayerRate(ledger, 'base_mfn', '6912004810', 'CN', '2026-07-01').rate).toBe(0.098)
    // 10자리 행과 다른 코드는 6자리 행으로 폴백
    expect(lookupLayerRate(ledger, 'base_mfn', '6912001000', 'CN', '2026-07-01').rate).toBe(0.05)
  })

  it('원산지 특정 행 > 전체(null) 행', () => {
    const ledger = [
      row({ layer: 'section301', hts_code: '6912', origin_country: null, ad_valorem_rate: 0 }),
      row({ layer: 'section301', hts_code: '6912', origin_country: 'CN', ad_valorem_rate: 0.25 }),
    ]
    expect(lookupLayerRate(ledger, 'section301', '6912004810', 'CN', '2026-07-01').rate).toBe(0.25)
    expect(lookupLayerRate(ledger, 'section301', '6912004810', 'VN', '2026-07-01').rate).toBe(0)
  })

  it("'*' 는 전 품목에 매칭되되 우선순위 최하 (IEEPA 국가 단위 레이어)", () => {
    const ledger = [
      row({ layer: 'ieepa_reciprocal', hts_code: '*', origin_country: 'CN', ad_valorem_rate: 0.1 }),
      row({ layer: 'ieepa_reciprocal', hts_code: '8544', origin_country: 'CN', ad_valorem_rate: 0.05 }),
    ]
    // 특정 코드 행이 있으면 그것이 우선
    expect(lookupLayerRate(ledger, 'ieepa_reciprocal', '8544429090', 'CN', '2026-07-01').rate).toBe(0.05)
    // 그 외 품목은 '*' 적용
    expect(lookupLayerRate(ledger, 'ieepa_reciprocal', '6912004810', 'CN', '2026-07-01').rate).toBe(0.1)
    // 다른 원산지는 미적용
    expect(lookupLayerRate(ledger, 'ieepa_reciprocal', '6912004810', 'VN', '2026-07-01').rate).toBe(0)
  })

  it('원장에 없으면 0 (스펙 §4)', () => {
    const r = lookupLayerRate([], 'base_mfn', '9999999999', 'CN', '2026-07-01')
    expect(r.rate).toBe(0)
    expect(r.matched_hts).toBeNull()
  })

  it('원산지 대소문자·공백 무시', () => {
    const ledger = [row({ origin_country: 'CN', layer: 'section301', ad_valorem_rate: 0.25 })]
    expect(lookupLayerRate(ledger, 'section301', '6912004810', ' cn ', '2026-07-01').rate).toBe(0.25)
  })
})
