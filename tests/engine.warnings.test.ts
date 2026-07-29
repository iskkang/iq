/**
 * 레이어별 원장 미스 경고 (골든 테스트 v1 에서 발견된 결함의 회귀 방지).
 *
 * 이전 동작: `dutyLayers.every((l) => l.matched_hts === null)` — **모든** 레이어가
 * 미매칭일 때만 경고했다. 301·IEEPA 는 잡히고 base MFN 만 원장에 없는 흔한 경우
 * duty 가 조용히 과소계상되고 리포트에 아무 표시도 남지 않았다.
 *
 * 현재 동작: 기대되는 레이어가 미매칭이면 각각 경고한다.
 * 단 그 원산지에 애초에 적용되지 않는 레이어(비중국산의 301)는 경고하지 않는다.
 */
import { describe, expect, it } from 'vitest'
import { computeShipment } from '../src/lib/calc/engine'
import { expectedLayers } from '../src/lib/calc/rates'
import type { CalcItem, CalcShipment, FeeSettings, RateRow } from '../src/lib/calc/types'

const FEES: FeeSettings = {
  mpf_rate: 0.003464,
  mpf_min_usd: 32.71,
  mpf_max_usd: 634.62,
  hmf_rate: 0.00125,
  effective_from: '2024-10-01',
}

const SHIP: CalcShipment = {
  freight_usd: 0,
  insurance_usd: 0,
  mode: 'air',
  allocation_basis: 'value',
  target_margin: 0.3,
  channel_fee_pct: 0.15,
  rate_as_of: '2026-07-01',
}

/** MFN 은 6912 만, 301 은 CN 6912·7323, IEEPA 는 CN·VN */
const LEDGER: RateRow[] = [
  { hts_code: '6912004810', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.098, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '6912', origin_country: 'CN', layer: 'section301', ad_valorem_rate: 0.25, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '7323', origin_country: 'CN', layer: 'section301', ad_valorem_rate: 0.25, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '*', origin_country: 'CN', layer: 'ieepa_reciprocal', ad_valorem_rate: 0.1, effective_from: '2025-04-09', effective_to: null },
  { hts_code: '*', origin_country: 'VN', layer: 'ieepa_reciprocal', ad_valorem_rate: 0.2, effective_from: '2025-04-09', effective_to: null },
]

const item = (p: Partial<CalcItem>): CalcItem => ({
  sku: 'X',
  unit_cost_usd: 10,
  origin_country: 'CN',
  units_per_shipment: 100,
  hts_code: null,
  ...p,
})

const run = (p: Partial<CalcItem>) => computeShipment(SHIP, [item(p)], LEDGER, FEES).items[0]
const hasMfnWarn = (w: string[]) => w.some((x) => x.includes('MFN'))
const has301Warn = (w: string[]) => w.some((x) => x.includes('301'))
const hasIeepaWarn = (w: string[]) => w.some((x) => x.includes('IEEPA'))

describe('부분 미스 — base MFN 만 원장에 없을 때 (회귀: 예전엔 무경고)', () => {
  // 7323... : 301(CN 7323) 과 IEEPA(*) 는 매칭, base MFN 은 원장에 없음
  const r = run({ hts_code: '7323930060', origin_country: 'CN' })

  it('duty 는 301 + IEEPA 만으로 계산된다 (MFN 0)', () => {
    expect(r.duty_rate_total).toBeCloseTo(0.25 + 0.1, 10)
  })

  it('MFN 미매칭이 경고로 노출된다', () => {
    expect(hasMfnWarn(r.warnings)).toBe(true)
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('경고 문구에 rate ledger 와 과소계상 사실이 담긴다', () => {
    const w = r.warnings.find((x) => x.includes('MFN'))!
    expect(w).toContain('rate ledger')
    expect(w).toContain('understated')
  })

  it('매칭된 레이어(301·IEEPA)에 대해서는 경고하지 않는다', () => {
    expect(has301Warn(r.warnings)).toBe(false)
    expect(hasIeepaWarn(r.warnings)).toBe(false)
  })
})

describe('부분 미스 — CN 인데 301 이 원장에 없을 때', () => {
  // 6912 는 MFN·301·IEEPA 모두 있음 → 경고 없음 (대조군)
  it('모든 레이어가 매칭되면 경고 없음', () => {
    const r = run({ hts_code: '6912004810', origin_country: 'CN' })
    expect(r.warnings).toEqual([])
    expect(r.duty_rate_total).toBeCloseTo(0.098 + 0.25 + 0.1, 10)
  })

  it('CN 인데 해당 HTS 의 301 행이 없으면 301 미스를 경고한다', () => {
    // 9506... : 301 행 없음. IEEPA(*) 만 매칭 → 부분 미스
    const r = run({ hts_code: '9506910030', origin_country: 'CN' })
    expect(has301Warn(r.warnings)).toBe(true)
    expect(hasMfnWarn(r.warnings)).toBe(true) // MFN 도 원장에 없다
    expect(hasIeepaWarn(r.warnings)).toBe(false)
  })
})

describe('원산지상 기대되지 않는 레이어는 경고 제외 (계획서 §검증2-4)', () => {
  it('VN: 301 은 원장에 CN 행만 있으므로 301 미스를 경고하지 않는다', () => {
    const r = run({ hts_code: '6912004810', origin_country: 'VN' })
    expect(has301Warn(r.warnings)).toBe(false)
    expect(r.duty_rate_total).toBeCloseTo(0.098 + 0.2, 10) // MFN + IEEPA(VN)
    expect(r.warnings).toEqual([])
  })

  it('IN: 301·IEEPA 모두 해당 없음 → MFN 만 맞으면 경고 없음', () => {
    const r = run({ hts_code: '6912004810', origin_country: 'IN' })
    expect(has301Warn(r.warnings)).toBe(false)
    expect(hasIeepaWarn(r.warnings)).toBe(false)
    expect(r.warnings).toEqual([])
    expect(r.duty_rate_total).toBeCloseTo(0.098, 10)
  })

  it('VN 인데 MFN 이 없으면 MFN 만 경고한다 (301 은 여전히 침묵)', () => {
    const r = run({ hts_code: '9506910030', origin_country: 'VN' })
    expect(hasMfnWarn(r.warnings)).toBe(true)
    expect(has301Warn(r.warnings)).toBe(false)
    expect(r.warnings).toHaveLength(1)
  })
})

describe('기존 동작 유지', () => {
  it('HTS 미확정 → 기존 문구 그대로', () => {
    const r = run({ hts_code: null })
    expect(r.warnings.some((w) => w.includes('HTS not confirmed'))).toBe(true)
    expect(r.duty_usd).toBe(0)
  })

  it('모든 레이어 미매칭 → 레이어별 경고 대신 단일 요약 문구', () => {
    const r = run({ hts_code: '0101210010', origin_country: 'BR' })
    expect(r.warnings).toEqual(['HTS not found in rate ledger — duty calculated as $0'])
  })

  it('발효 전 기준일이면 그 레이어는 기대 대상이 아니다 (미래 행으로 오경고 금지)', () => {
    // IEEPA 는 2025-04-09 발효 — 그 이전 기준일에는 CN 이어도 기대되지 않는다
    const r = computeShipment(
      { ...SHIP, rate_as_of: '2025-03-01' },
      [item({ hts_code: '6912004810', origin_country: 'CN' })],
      LEDGER,
      FEES,
    ).items[0]
    expect(hasIeepaWarn(r.warnings)).toBe(false)
    expect(r.warnings).toEqual([])
    expect(r.duty_rate_total).toBeCloseTo(0.098 + 0.25, 10)
  })
})

describe('expectedLayers — 원장에서 유도, 하드코딩 없음', () => {
  it('CN: 3개 레이어 모두 기대', () => {
    expect([...expectedLayers(LEDGER, 'CN', '2026-07-01')].sort()).toEqual([
      'base_mfn',
      'ieepa_reciprocal',
      'section301',
    ])
  })

  it('VN: 301 제외', () => {
    expect([...expectedLayers(LEDGER, 'VN', '2026-07-01')].sort()).toEqual(['base_mfn', 'ieepa_reciprocal'])
  })

  it('IN: MFN 만 (원장에 IN 행이 없으므로)', () => {
    expect([...expectedLayers(LEDGER, 'IN', '2026-07-01')]).toEqual(['base_mfn'])
  })

  it('원산지 대소문자·공백에 영향받지 않는다', () => {
    expect([...expectedLayers(LEDGER, ' vn ', '2026-07-01')].sort()).toEqual(['base_mfn', 'ieepa_reciprocal'])
  })

  it('기준일 이전 발효 행은 기대에서 빠진다', () => {
    expect([...expectedLayers(LEDGER, 'CN', '2025-03-01')].sort()).toEqual(['base_mfn', 'section301'])
  })
})
