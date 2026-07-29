import { describe, expect, it } from 'vitest'
import { computeShipment, dutyBreakdownLabel } from '../src/lib/calc/engine'
import type { CalcItem, CalcShipment, FeeSettings, RateRow } from '../src/lib/calc/types'

const FEES: FeeSettings = {
  mpf_rate: 0.003464,
  mpf_min_usd: 32.71,
  mpf_max_usd: 634.62,
  hmf_rate: 0.00125,
  effective_from: '2024-10-01',
}

const LEDGER: RateRow[] = [
  { hts_code: '6912004810', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.098, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '6912', origin_country: 'CN', layer: 'section301', ad_valorem_rate: 0.25, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '*', origin_country: 'CN', layer: 'ieepa_reciprocal', ad_valorem_rate: 0.1, effective_from: '2025-04-09', effective_to: null },
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

describe('duty 레이어 합산 (스펙 §4)', () => {
  it('duty_rate_total = MFN + 301 + IEEPA, duty_usd = unit_cost × rate', () => {
    const items: CalcItem[] = [
      { sku: 'MUG', unit_cost_usd: 2.5, origin_country: 'CN', units_per_shipment: 1000, hts_code: '6912.00.4810' },
    ]
    const r = computeShipment(ship(), items, LEDGER, FEES)
    expect(r.items[0].duty_rate_total).toBeCloseTo(0.098 + 0.25 + 0.1, 10)
    expect(r.items[0].duty_usd).toBeCloseTo(2.5 * 0.448, 10)
    expect(dutyBreakdownLabel(r.items[0])).toBe('MFN 9.8% + 301 25% + IEEPA 10%')
  })

  it('레이어가 원장에 없으면 그 레이어는 0 (VN: MFN만)', () => {
    const items: CalcItem[] = [
      { sku: 'MUG-VN', unit_cost_usd: 2.5, origin_country: 'VN', units_per_shipment: 100, hts_code: '6912004810' },
    ]
    const r = computeShipment(ship(), items, LEDGER, FEES)
    expect(r.items[0].duty_rate_total).toBeCloseTo(0.098, 10)
  })

  it('HTS 미확정 → duty 0 + 경고 (분류 없이도 계산은 진행)', () => {
    const items: CalcItem[] = [
      { sku: 'X', unit_cost_usd: 5, origin_country: 'CN', units_per_shipment: 10, hts_code: null },
    ]
    const r = computeShipment(ship(), items, LEDGER, FEES)
    expect(r.items[0].duty_usd).toBe(0)
    expect(r.items[0].warnings.some((w) => w.includes('HTS 미확정'))).toBe(true)
  })

  it('원장에 전혀 없는 HTS → duty 0 + 경고', () => {
    const items: CalcItem[] = [
      { sku: 'Y', unit_cost_usd: 5, origin_country: 'BR', units_per_shipment: 10, hts_code: '0101210010' },
    ]
    const r = computeShipment(ship(), items, LEDGER, FEES)
    expect(r.items[0].duty_rate_total).toBe(0)
    expect(r.items[0].warnings.some((w) => w.includes('원장'))).toBe(true)
  })

  it('rate 기준일에 따라 레이어 적용이 달라진다 (IEEPA 발효 전)', () => {
    const items: CalcItem[] = [
      { sku: 'MUG', unit_cost_usd: 2.5, origin_country: 'CN', units_per_shipment: 100, hts_code: '6912004810' },
    ]
    const r = computeShipment(ship({ rate_as_of: '2025-03-01' }), items, LEDGER, FEES)
    expect(r.items[0].duty_rate_total).toBeCloseTo(0.098 + 0.25, 10) // IEEPA(4/9 발효) 미적용
  })
})
