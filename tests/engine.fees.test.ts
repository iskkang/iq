import { describe, expect, it } from 'vitest'
import type { ProgramContext } from '../src/lib/calc/engine'
import type { DutyProgram } from '../src/lib/calc/programs'
import { computeShipment } from '../src/lib/calc/engine'
import type { CalcItem, CalcShipment, FeeSettings } from '../src/lib/calc/types'

const FEES: FeeSettings = {
  mpf_rate: 0.003464,
  mpf_min_usd: 33.58,
  mpf_max_usd: 651.50,
  hmf_rate: 0.00125,
  effective_from: '2025-10-01',
}

const PROGRAMS: DutyProgram[] = [
  { code: 'mfn', name: 'Base MFN', authority: 'MFN', rate_type: 'additive', scope_type: 'hts_list', effective_from: '1900-01-01', effective_to: null },
  { code: '301-china-legacy', name: 'China 301', authority: 'Section 301', rate_type: 'additive', scope_type: 'country_and_hts', effective_from: '2018-07-06', effective_to: null },
  { code: 'ieepa-reciprocal', name: 'IEEPA', authority: 'IEEPA', rate_type: 'additive', scope_type: 'country', effective_from: '2025-04-09', effective_to: '2026-02-24' },
]
const CTX: ProgramContext = { programs: PROGRAMS, exclusions: [] }

const ship = (p: Partial<CalcShipment> = {}): CalcShipment => ({
  freight_usd: 0,
  insurance_usd: 0,
  mode: 'ocean',
  allocation_basis: 'value',
  target_margin: 0.3,
  channel_fee_pct: 0.15,
  rate_as_of: '2026-07-01',
  ...p,
})

const item = (p: Partial<CalcItem> = {}): CalcItem => ({
  sku: 'A',
  unit_cost_usd: 10,
  origin_country: 'CN',
  units_per_shipment: 100,
  hts_code: null,
  ...p,
})

describe('MPF — 선적 단위 0.3464% + min·max 캡 (스펙 §4)', () => {
  it('캡 사이: 총가액 × 0.3464%', () => {
    // 총가액 23,925 → MPF 82.8762
    const r = computeShipment(ship(), [item({ unit_cost_usd: 239.25, units_per_shipment: 100 })], [], FEES, CTX)
    expect(r.totals.mpf_shipment).toBeCloseTo(82.8762, 6)
    // 단일 SKU → 전액 배부, 단위당 = 82.8762 / 100
    expect(r.items[0].mpf_per_unit).toBeCloseTo(0.828762, 6)
  })

  it('min 캡: 소액 선적은 최소 $33.58', () => {
    // 총가액 1,000 → 3.464 → min 33.58
    const r = computeShipment(ship(), [item({ unit_cost_usd: 10, units_per_shipment: 100 })], [], FEES, CTX)
    expect(r.totals.mpf_shipment).toBeCloseTo(FEES.mpf_min_usd, 2)
    // 파생 상수를 쓰지 않는다 — min 캡에서 계산. 캡이 바뀌면 자동으로 따라간다
    expect(r.items[0].mpf_per_unit).toBeCloseTo(FEES.mpf_min_usd / 100, 4)
  })

  it('max 캡: 고액 선적은 최대 $651.50', () => {
    // 총가액 500,000 → 1,732 → max 651.50
    const r = computeShipment(ship(), [item({ unit_cost_usd: 5000, units_per_shipment: 100 })], [], FEES, CTX)
    expect(r.totals.mpf_shipment).toBeCloseTo(FEES.mpf_max_usd, 2)
  })

  it('MPF는 배부 기준과 무관하게 항상 가액 비중으로 배부', () => {
    const items = [
      item({ sku: 'A', unit_cost_usd: 30, units_per_shipment: 100, weight_kg_per_unit: 1 }), // 가액 3000 (75%)
      item({ sku: 'B', unit_cost_usd: 10, units_per_shipment: 100, weight_kg_per_unit: 9 }), // 가액 1000 (25%)
    ]
    const r = computeShipment(ship({ allocation_basis: 'weight', freight_usd: 1000 }), items, [], FEES, CTX)
    const mpf = r.totals.mpf_shipment // 4000×0.003464 → min 캡 33.58
    expect(mpf).toBeCloseTo(FEES.mpf_min_usd, 2)
    expect(r.items[0].mpf_per_unit).toBeCloseTo((mpf * 0.75) / 100, 6)
    expect(r.items[1].mpf_per_unit).toBeCloseTo((mpf * 0.25) / 100, 6)
    // 반면 운임은 중량 비중(10% vs 90%)
    expect(r.items[0].freight_per_unit).toBeCloseTo((1000 * 0.1) / 100, 6)
    expect(r.items[1].freight_per_unit).toBeCloseTo((1000 * 0.9) / 100, 6)
  })

  it('빈 선적(총가액 0)이면 MPF 0 (min 캡 미적용)', () => {
    const r = computeShipment(ship(), [], [], FEES, CTX)
    expect(r.totals.mpf_shipment).toBe(0)
  })
})

describe('HMF — ocean 전용 0.125% (스펙 §4)', () => {
  it('ocean: 가액 × 0.125% 배부 → 단위당 = unit_cost × 0.125%', () => {
    const r = computeShipment(ship({ mode: 'ocean' }), [item({ unit_cost_usd: 20 })], [], FEES, CTX)
    expect(r.totals.hmf_shipment).toBeCloseTo(20 * 100 * 0.00125, 6)
    expect(r.items[0].hmf_per_unit).toBeCloseTo(20 * 0.00125, 6)
  })

  it('air: HMF 없음', () => {
    const r = computeShipment(ship({ mode: 'air' }), [item()], [], FEES, CTX)
    expect(r.totals.hmf_shipment).toBe(0)
    expect(r.items[0].hmf_per_unit).toBe(0)
  })
})
