import { describe, expect, it } from 'vitest'
import type { ProgramContext } from '../src/lib/calc/engine'
import type { DutyProgram } from '../src/lib/calc/programs'
import { computeShipment } from '../src/lib/calc/engine'
import type { CalcItem, CalcShipment, FeeSettings } from '../src/lib/calc/types'

const FEES: FeeSettings = {
  mpf_rate: 0.003464,
  mpf_min_usd: 32.71,
  mpf_max_usd: 634.62,
  hmf_rate: 0.00125,
  effective_from: '2024-10-01',
}

const PROGRAMS: DutyProgram[] = [
  { code: 'mfn', name: 'Base MFN', authority: 'MFN', rate_type: 'additive', scope_type: 'hts_list', effective_from: '1900-01-01', effective_to: null },
  { code: '301-china-legacy', name: 'China 301', authority: 'Section 301', rate_type: 'additive', scope_type: 'country_and_hts', effective_from: '2018-07-06', effective_to: null },
  { code: 'ieepa-reciprocal', name: 'IEEPA', authority: 'IEEPA', rate_type: 'additive', scope_type: 'country', effective_from: '2025-04-09', effective_to: '2026-02-24' },
]
const CTX: ProgramContext = { programs: PROGRAMS, exclusions: [] }

const ship = (p: Partial<CalcShipment> = {}): CalcShipment => ({
  freight_usd: 2000,
  insurance_usd: 100,
  mode: 'air',
  allocation_basis: 'value',
  target_margin: 0.3,
  channel_fee_pct: 0.15,
  rate_as_of: '2026-07-01',
  ...p,
})

describe('운임+보험 배부 (스펙 §4)', () => {
  it('가액 기준: (총운임+보험) × SKU 가액/총가액', () => {
    const items: CalcItem[] = [
      { sku: 'A', unit_cost_usd: 10, origin_country: 'CN', units_per_shipment: 100 }, // 1000 (25%)
      { sku: 'B', unit_cost_usd: 30, origin_country: 'CN', units_per_shipment: 100 }, // 3000 (75%)
    ]
    const r = computeShipment(ship(), items, [], FEES, CTX)
    expect(r.totals.freight_pool).toBe(2100)
    expect(r.items[0].freight_per_unit).toBeCloseTo((2100 * 0.25) / 100, 6)
    expect(r.items[1].freight_per_unit).toBeCloseTo((2100 * 0.75) / 100, 6)
  })

  it('중량 기준: 중량 비중으로 배부', () => {
    const items: CalcItem[] = [
      { sku: 'A', unit_cost_usd: 10, origin_country: 'CN', units_per_shipment: 100, weight_kg_per_unit: 2 }, // 200kg (40%)
      { sku: 'B', unit_cost_usd: 30, origin_country: 'CN', units_per_shipment: 300, weight_kg_per_unit: 1 }, // 300kg (60%)
    ]
    const r = computeShipment(ship({ allocation_basis: 'weight', freight_usd: 1000, insurance_usd: 0 }), items, [], FEES, CTX)
    expect(r.totals.allocation_basis_used).toBe('weight')
    expect(r.items[0].freight_per_unit).toBeCloseTo((1000 * 0.4) / 100, 6)
    expect(r.items[1].freight_per_unit).toBeCloseTo((1000 * 0.6) / 300, 6)
  })

  it('중량 없으면 가액으로 폴백 + 경고 (스펙 §2)', () => {
    const items: CalcItem[] = [
      { sku: 'A', unit_cost_usd: 10, origin_country: 'CN', units_per_shipment: 100, weight_kg_per_unit: 2 },
      { sku: 'B', unit_cost_usd: 30, origin_country: 'CN', units_per_shipment: 100, weight_kg_per_unit: null },
    ]
    const r = computeShipment(ship({ allocation_basis: 'weight' }), items, [], FEES, CTX)
    expect(r.totals.allocation_basis_used).toBe('value')
    expect(r.warnings.length).toBeGreaterThan(0)
    expect(r.items[0].freight_per_unit).toBeCloseTo((2100 * 0.25) / 100, 6)
  })

  it('배부 총합 = 풀 금액 (보존 검증)', () => {
    const items: CalcItem[] = [
      { sku: 'A', unit_cost_usd: 2.5, origin_country: 'CN', units_per_shipment: 1000 },
      { sku: 'B', unit_cost_usd: 8.5, origin_country: 'VN', units_per_shipment: 400 },
      { sku: 'C', unit_cost_usd: 0.9, origin_country: 'IN', units_per_shipment: 2000 },
    ]
    const r = computeShipment(ship(), items, [], FEES, CTX)
    const freightSum = r.items.reduce((a, it) => a + it.freight_per_unit * it.units, 0)
    const mpfSum = r.items.reduce((a, it) => a + it.mpf_per_unit * it.units, 0)
    expect(freightSum).toBeCloseTo(2100, 6)
    expect(mpfSum).toBeCloseTo(r.totals.mpf_shipment, 6)
  })
})
