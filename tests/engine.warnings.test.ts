/**
 * "조용한 0" 금지 — 프로그램 미확인 경고 (골든 v1 에서 발견된 결함의 회귀 방지).
 *
 * 원래 결함: `dutyLayers.every(matched_hts === null)` 일 때만 경고해서, 301 은 잡히고
 * MFN 만 없는 흔한 경우 duty 가 조용히 과소계상됐다.
 *
 * 프로그램 모델의 규칙:
 *   그 원산지로 적용될 수 있는 행이 원장에 있는 프로그램인데 이 HTS 에 매칭되는
 *   행이 없으면 → "미확인" 경고. 0% 확정이 아니라 모른다는 뜻이다.
 *   원산지상 애초에 닿지 않는 프로그램(비중국산의 중국 301)은 경고하지 않는다.
 */
import { describe, expect, it } from 'vitest'
import { computeShipment } from '../src/lib/calc/engine'
import type { ProgramContext } from '../src/lib/calc/engine'
import type { DutyProgram } from '../src/lib/calc/programs'
import type { CalcItem, CalcShipment, FeeSettings, RateRow } from '../src/lib/calc/types'

const FEES: FeeSettings = {
  mpf_rate: 0.003464,
  mpf_min_usd: 32.71,
  mpf_max_usd: 634.62,
  hmf_rate: 0.00125,
  effective_from: '2024-10-01',
}

const PROGRAMS: DutyProgram[] = [
  { code: 'mfn', name: 'Base MFN', authority: 'MFN', rate_type: 'additive', scope_type: 'hts_list', effective_from: '1900-01-01', effective_to: null },
  { code: '301-china', name: 'China 301', authority: 'Section 301', rate_type: 'additive', scope_type: 'country_and_hts', effective_from: '2018-07-06', effective_to: null },
  { code: '301-fl', name: 'Forced labor 301', authority: 'Section 301 FL', rate_type: 'additive', scope_type: 'country', effective_from: '2026-07-24', effective_to: null },
]
const CTX: ProgramContext = { programs: PROGRAMS, exclusions: [] }

const SHIP: CalcShipment = {
  freight_usd: 0,
  insurance_usd: 0,
  mode: 'air',
  allocation_basis: 'value',
  target_margin: 0.3,
  channel_fee_pct: 0.15,
  rate_as_of: '2026-07-29',
}

/** MFN 은 6912 만, 중국301 은 6912·7323, 강제노동301 은 CN·VN */
const LEDGER: RateRow[] = [
  { program_code: 'mfn', hts_code: '6912004810', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.098, effective_from: '2025-01-01', effective_to: null },
  { program_code: '301-china', hts_code: '6912', origin_country: 'CN', layer: 'section301', ad_valorem_rate: 0.25, effective_from: '2025-01-01', effective_to: null },
  { program_code: '301-china', hts_code: '7323', origin_country: 'CN', layer: 'section301', ad_valorem_rate: 0.25, effective_from: '2025-01-01', effective_to: null },
  { program_code: '301-fl', hts_code: '*', origin_country: 'CN', layer: 'section301', ad_valorem_rate: 0.125, effective_from: '2026-07-24', effective_to: null },
  { program_code: '301-fl', hts_code: '*', origin_country: 'VN', layer: 'section301', ad_valorem_rate: 0.125, effective_from: '2026-07-24', effective_to: null },
]

const item = (p: Partial<CalcItem>): CalcItem => ({
  sku: 'X',
  unit_cost_usd: 10,
  origin_country: 'CN',
  units_per_shipment: 100,
  hts_code: null,
  ...p,
})

const run = (p: Partial<CalcItem>) => computeShipment(SHIP, [item(p)], LEDGER, FEES, CTX).items[0]
const warnedAbout = (w: string[], code: string) => w.some((x) => x.includes(code))

describe('부분 미스 — MFN 만 원장에 없을 때 (회귀: 예전엔 무경고)', () => {
  // 7323... : 중국301·강제노동301 은 매칭, MFN 은 원장에 없음
  const r = run({ hts_code: '7323930060', origin_country: 'CN' })

  it('duty 는 매칭된 프로그램만으로 계산된다 (MFN 0)', () => {
    expect(r.duty_rate_total).toBeCloseTo(0.25 + 0.125, 10)
  })

  it('MFN 미확인이 경고로 노출된다', () => {
    expect(warnedAbout(r.warnings, 'mfn')).toBe(true)
  })

  it('경고 문구가 0% 확정이 아니라 미확인·과소계상임을 말한다', () => {
    const w = r.warnings.find((x) => x.includes('mfn'))!
    expect(w).toContain('not confirmed')
    expect(w).toContain('understated')
  })

  it('매칭된 프로그램에 대해서는 경고하지 않는다', () => {
    expect(warnedAbout(r.warnings, '301-china')).toBe(false)
    expect(warnedAbout(r.warnings, '301-fl')).toBe(false)
  })
})

describe('부분 미스 — CN 인데 중국301 이 그 HTS 에 없을 때', () => {
  it('모든 프로그램이 매칭되면 경고 없음 (대조군)', () => {
    const r = run({ hts_code: '6912004810', origin_country: 'CN' })
    expect(r.warnings).toEqual([])
    expect(r.duty_rate_total).toBeCloseTo(0.098 + 0.25 + 0.125, 10)
  })

  it('CN 인데 해당 HTS 의 중국301 행이 없으면 미확인 경고', () => {
    // 9506... : MFN·중국301 둘 다 원장에 없음. 강제노동301(*) 만 매칭
    const r = run({ hts_code: '9506910030', origin_country: 'CN' })
    expect(warnedAbout(r.warnings, '301-china')).toBe(true)
    expect(warnedAbout(r.warnings, 'mfn')).toBe(true)
    expect(warnedAbout(r.warnings, '301-fl')).toBe(false)
  })
})

describe('원산지상 닿지 않는 프로그램은 경고 제외', () => {
  it('VN: 중국301 은 원장에 CN 행만 있으므로 경고하지 않는다', () => {
    const r = run({ hts_code: '6912004810', origin_country: 'VN' })
    expect(warnedAbout(r.warnings, '301-china')).toBe(false)
    expect(r.duty_rate_total).toBeCloseTo(0.098 + 0.125, 10) // MFN + 강제노동301(VN)
    expect(r.warnings).toEqual([])
  })

  it('IN: 어느 국가 행에도 없으면 국가 스코프 프로그램은 침묵', () => {
    const r = run({ hts_code: '6912004810', origin_country: 'IN' })
    expect(warnedAbout(r.warnings, '301-china')).toBe(false)
    expect(warnedAbout(r.warnings, '301-fl')).toBe(false)
    expect(r.warnings).toEqual([])
    expect(r.duty_rate_total).toBeCloseTo(0.098, 10)
  })

  it('VN 인데 MFN 이 없으면 MFN 만 경고 (중국301 은 여전히 침묵)', () => {
    const r = run({ hts_code: '9506910030', origin_country: 'VN' })
    expect(warnedAbout(r.warnings, 'mfn')).toBe(true)
    expect(warnedAbout(r.warnings, '301-china')).toBe(false)
    expect(r.warnings).toHaveLength(1)
  })
})

describe('발효일과 경고의 상호작용', () => {
  it('아직 발효 전인 프로그램은 미확인 경고를 내지 않는다', () => {
    // 강제노동 301 은 2026-07-24 발효 — 그 전에는 기대 대상이 아니다
    const r = computeShipment(
      { ...SHIP, rate_as_of: '2026-07-01' },
      [item({ hts_code: '6912004810', origin_country: 'CN' })],
      LEDGER,
      FEES,
      CTX,
    ).items[0]
    expect(warnedAbout(r.warnings, '301-fl')).toBe(false)
    expect(r.warnings).toEqual([])
    expect(r.duty_rate_total).toBeCloseTo(0.098 + 0.25, 10)
  })

  it('만료된 프로그램도 미확인 경고를 내지 않는다', () => {
    const expired: DutyProgram[] = [
      ...PROGRAMS,
      { code: 'ieepa', name: 'IEEPA', authority: 'IEEPA', rate_type: 'additive', scope_type: 'country', effective_from: '2025-04-09', effective_to: '2026-02-24' },
    ]
    const withIeepa: RateRow[] = [
      ...LEDGER,
      { program_code: 'ieepa', hts_code: '*', origin_country: 'CN', layer: 'ieepa_reciprocal', ad_valorem_rate: 0.1, effective_from: '2025-04-09', effective_to: null },
    ]
    const r = computeShipment(SHIP, [item({ hts_code: '6912004810', origin_country: 'CN' })], withIeepa, FEES, {
      programs: expired,
      exclusions: [],
    }).items[0]
    expect(warnedAbout(r.warnings, 'ieepa')).toBe(false)
    expect(r.warnings).toEqual([])
  })
})

describe('면제는 경고로 남는다 (0 이 된 이유가 보여야 한다)', () => {
  it('면제된 프로그램은 사유가 리포트에 남는다', () => {
    const r = computeShipment(SHIP, [item({ hts_code: '6912004810', origin_country: 'CN' })], LEDGER, FEES, {
      programs: PROGRAMS,
      exclusions: [{ program_code: '301-fl', hts_code: '6912' }],
    }).items[0]
    expect(r.warnings.some((w) => w.includes('excluded'))).toBe(true)
    expect(r.duty_rate_total).toBeCloseTo(0.098 + 0.25, 10)
  })
})
