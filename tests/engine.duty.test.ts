/**
 * duty 계산 — 프로그램 단일 경로 (스펙 §4).
 *
 * 레이어 enum 은 제거됐다. duty_rate_total 은
 *   Σ additive 프로그램 → top_up_to_total 로 상한 보정
 * 이고, 발효일·적용범위는 duty_programs 데이터가 결정한다.
 */
import { describe, expect, it } from 'vitest'
import { computeShipment, dutyBreakdownLabel } from '../src/lib/calc/engine'
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
  // 무효화된 프로그램 — effective_to 로 계산에서 자동 제외되는지 검증한다
  { code: 'ieepa', name: 'IEEPA reciprocal', authority: 'IEEPA', rate_type: 'additive', scope_type: 'country', effective_from: '2025-04-09', effective_to: '2026-02-24' },
]
const CTX: ProgramContext = { programs: PROGRAMS, exclusions: [] }

const LEDGER: RateRow[] = [
  { program_code: 'mfn', hts_code: '6912004810', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.098, effective_from: '2025-01-01', effective_to: null },
  { program_code: '301-china', hts_code: '6912', origin_country: 'CN', layer: 'section301', ad_valorem_rate: 0.25, effective_from: '2025-01-01', effective_to: null },
  { program_code: 'ieepa', hts_code: '*', origin_country: 'CN', layer: 'ieepa_reciprocal', ad_valorem_rate: 0.1, effective_from: '2025-04-09', effective_to: null },
]

const ship = (p: Partial<CalcShipment> = {}): CalcShipment => ({
  freight_usd: 0,
  insurance_usd: 0,
  mode: 'air',
  allocation_basis: 'value',
  target_margin: 0.3,
  channel_fee_pct: 0.15,
  rate_as_of: '2026-07-01',
  ...p,
})

describe('duty 합산 (스펙 §4)', () => {
  it('duty_rate_total = Σ 적용 프로그램, duty_usd = unit_cost × rate', () => {
    const items: CalcItem[] = [
      { sku: 'MUG', unit_cost_usd: 2.5, origin_country: 'CN', units_per_shipment: 1000, hts_code: '6912.00.4810' },
    ]
    const r = computeShipment(ship(), items, LEDGER, FEES, CTX).items[0]
    // 2026-07-01 기준 IEEPA 는 이미 만료(2026-02-24) — MFN + 301 만
    expect(r.duty_rate_total).toBeCloseTo(0.098 + 0.25, 10)
    expect(r.duty_usd).toBeCloseTo(2.5 * 0.348, 10)
    expect(dutyBreakdownLabel(r)).toBe('MFN 9.8% + Section 301 25%')
  })

  it('무효화된 프로그램은 코드 수정 없이 데이터만으로 빠진다', () => {
    const items: CalcItem[] = [
      { sku: 'MUG', unit_cost_usd: 2.5, origin_country: 'CN', units_per_shipment: 100, hts_code: '6912004810' },
    ]
    // IEEPA 유효 시점
    const before = computeShipment(ship({ rate_as_of: '2025-06-01' }), items, LEDGER, FEES, CTX).items[0]
    expect(before.duty_rate_total).toBeCloseTo(0.098 + 0.25 + 0.1, 10)
    // 종료 후
    const after = computeShipment(ship({ rate_as_of: '2026-07-01' }), items, LEDGER, FEES, CTX).items[0]
    expect(after.duty_rate_total).toBeCloseTo(0.098 + 0.25, 10)
    expect(after.applied_programs.some((a) => a.program_code === 'ieepa')).toBe(false)
  })

  it('원산지가 다르면 country 스코프 프로그램은 안 붙는다 (VN: MFN 만)', () => {
    const items: CalcItem[] = [
      { sku: 'MUG-VN', unit_cost_usd: 2.5, origin_country: 'VN', units_per_shipment: 100, hts_code: '6912004810' },
    ]
    const r = computeShipment(ship(), items, LEDGER, FEES, CTX).items[0]
    expect(r.duty_rate_total).toBeCloseTo(0.098, 10)
  })

  it('HTS 미확정 → duty 0 + 경고 (분류 없이도 계산은 진행)', () => {
    const items: CalcItem[] = [
      { sku: 'X', unit_cost_usd: 5, origin_country: 'CN', units_per_shipment: 10, hts_code: null },
    ]
    const r = computeShipment(ship(), items, LEDGER, FEES, CTX).items[0]
    expect(r.duty_usd).toBe(0)
    expect(r.warnings.some((w) => w.includes('HTS not confirmed'))).toBe(true)
  })

  it('원장에 전혀 없는 HTS → duty 0 + 경고', () => {
    const items: CalcItem[] = [
      { sku: 'Y', unit_cost_usd: 5, origin_country: 'BR', units_per_shipment: 10, hts_code: '0101210010' },
    ]
    const r = computeShipment(ship(), items, LEDGER, FEES, CTX).items[0]
    expect(r.duty_rate_total).toBe(0)
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('rate 기준일에 따라 적용 프로그램이 달라진다 (발효 전)', () => {
    const items: CalcItem[] = [
      { sku: 'MUG', unit_cost_usd: 2.5, origin_country: 'CN', units_per_shipment: 100, hts_code: '6912004810' },
    ]
    const r = computeShipment(ship({ rate_as_of: '2025-03-01' }), items, LEDGER, FEES, CTX).items[0]
    expect(r.duty_rate_total).toBeCloseTo(0.098 + 0.25, 10) // IEEPA(4/9 발효) 미적용
  })

  it('applied_programs 에 근거가 남는다 (감사 추적)', () => {
    const items: CalcItem[] = [
      { sku: 'MUG', unit_cost_usd: 2.5, origin_country: 'CN', units_per_shipment: 100, hts_code: '6912004810' },
    ]
    const r = computeShipment(ship(), items, LEDGER, FEES, CTX).items[0]
    const mfn = r.applied_programs.find((a) => a.program_code === 'mfn')!
    expect(mfn.applied_rate).toBeCloseTo(0.098, 10)
    expect(mfn.matched_hts).toBe('6912004810')
    expect(mfn.excluded).toBe(false)
  })
})
