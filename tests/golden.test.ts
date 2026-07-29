/**
 * 골든 테스트 하니스 (수용 기준 §6-1).
 *
 * 지금 들어있는 10건은 스펙 검증용 수기 계산 fixture다 (아래 수치는 전부
 * 엔진 밖에서 손으로 계산한 기대값). 사용자가 실제 상품 10건(MTL 실서류)을
 * 제공하면 GOLDEN_LEDGER / GOLDEN_ITEMS / EXPECTED 만 교체해서 재사용한다.
 *
 * 수기 계산 절차 (스펙 §4 그대로):
 *   total_value = Σ unit_cost × units = 23,925
 *   freight_pool = 2,000 + 100 = 2,100
 *   MPF = 23,925 × 0.3464% = 82.8762 (캡 [32.71, 634.62] 내)
 *   HMF = 23,925 × 0.125% = 29.90625 (ocean)
 *   SKU별: duty = cost × Σ레이어, freight/unit = cost × 2100/23925,
 *          mpf/unit = cost × 0.003464 (미캡이므로), hmf/unit = cost × 0.00125
 */
import { describe, expect, it } from 'vitest'
import { computeShipment } from '../src/lib/calc/engine'
import type { CalcItem, CalcShipment, FeeSettings, RateRow } from '../src/lib/calc/types'

const FEES: FeeSettings = {
  mpf_rate: 0.003464,
  mpf_min_usd: 32.71,
  mpf_max_usd: 634.62,
  hmf_rate: 0.00125,
  effective_from: '2024-10-01',
}

const GOLDEN_LEDGER: RateRow[] = [
  // base MFN
  { hts_code: '6912004810', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.098, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '6109100004', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.165, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '3924104000', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.034, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '4202923120', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.176, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '7323930060', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.02, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '8544429090', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.026, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '9503000073', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '6302600020', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.091, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '8518302000', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.049, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '9404902000', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.06, effective_from: '2025-01-01', effective_to: null },
  // Section 301 (CN)
  { hts_code: '6912', origin_country: 'CN', layer: 'section301', ad_valorem_rate: 0.25, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '6109', origin_country: 'CN', layer: 'section301', ad_valorem_rate: 0.075, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '3924', origin_country: 'CN', layer: 'section301', ad_valorem_rate: 0.25, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '4202', origin_country: 'CN', layer: 'section301', ad_valorem_rate: 0.25, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '7323', origin_country: 'CN', layer: 'section301', ad_valorem_rate: 0.25, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '8544', origin_country: 'CN', layer: 'section301', ad_valorem_rate: 0.25, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '8518', origin_country: 'CN', layer: 'section301', ad_valorem_rate: 0.25, effective_from: '2025-01-01', effective_to: null },
  // IEEPA reciprocal (국가 단위)
  { hts_code: '*', origin_country: 'CN', layer: 'ieepa_reciprocal', ad_valorem_rate: 0.1, effective_from: '2025-04-09', effective_to: null },
  { hts_code: '*', origin_country: 'VN', layer: 'ieepa_reciprocal', ad_valorem_rate: 0.2, effective_from: '2025-04-09', effective_to: null },
]

const SHIP: CalcShipment = {
  freight_usd: 2000,
  insurance_usd: 100,
  mode: 'ocean',
  allocation_basis: 'value',
  target_margin: 0.3,
  channel_fee_pct: 0.15,
  rate_as_of: '2026-07-01',
}

const GOLDEN_ITEMS: CalcItem[] = [
  { sku: 'MUG-01',      hts_code: '6912004810', unit_cost_usd: 2.5,  origin_country: 'CN', units_per_shipment: 1000, current_price_usd: 12.99 },
  { sku: 'TSHIRT-01',   hts_code: '6109100004', unit_cost_usd: 3.2,  origin_country: 'CN', units_per_shipment: 800,  current_price_usd: 19.99 },
  { sku: 'BOTTLE-01',   hts_code: '3924104000', unit_cost_usd: 1.8,  origin_country: 'CN', units_per_shipment: 1500, current_price_usd: 9.99 },
  { sku: 'BACKPACK-01', hts_code: '4202923120', unit_cost_usd: 8.5,  origin_country: 'CN', units_per_shipment: 400,  current_price_usd: 39.99 },
  { sku: 'PAN-01',      hts_code: '7323930060', unit_cost_usd: 6.4,  origin_country: 'CN', units_per_shipment: 300,  current_price_usd: 24.99 },
  { sku: 'CABLE-01',    hts_code: '8544429090', unit_cost_usd: 0.9,  origin_country: 'CN', units_per_shipment: 2000, current_price_usd: 7.99 },
  { sku: 'TOY-01',      hts_code: '9503000073', unit_cost_usd: 4.1,  origin_country: 'VN', units_per_shipment: 600,  current_price_usd: 16.99 },
  { sku: 'TOWEL-01',    hts_code: '6302600020', unit_cost_usd: 2.2,  origin_country: 'IN', units_per_shipment: 900,  current_price_usd: 14.99 },
  { sku: 'HEADSET-01',  hts_code: '8518302000', unit_cost_usd: 11,   origin_country: 'CN', units_per_shipment: 250,  current_price_usd: 49.99 },
  { sku: 'PILLOW-01',   hts_code: '9404902000', unit_cost_usd: 5.3,  origin_country: 'VN', units_per_shipment: 350,  current_price_usd: 21.99 },
]

/** 수기 계산 기대값 (엔진과 무관하게 손으로 계산) */
const EXPECTED = [
  { sku: 'MUG-01',      duty_rate: 0.448, duty_usd: 1.12,    landed: 3.851221,  margin: 0.553524, rec: 7.002219 },
  { sku: 'TSHIRT-01',   duty_rate: 0.34,  duty_usd: 1.088,   landed: 4.583963,  margin: 0.620687, rec: 8.334477 },
  { sku: 'BOTTLE-01',   duty_rate: 0.384, duty_usd: 0.6912,  landed: 2.657679,  margin: 0.583966, rec: 4.832144 },
  { sku: 'BACKPACK-01', duty_rate: 0.526, duty_usd: 4.471,   landed: 13.757151, margin: 0.505985, rec: 25.013001 },
  { sku: 'PAN-01',      duty_rate: 0.37,  duty_usd: 2.368,   landed: 9.359925,  margin: 0.475453, rec: 17.018046 },
  { sku: 'CABLE-01',    duty_rate: 0.376, duty_usd: 0.3384,  landed: 1.321639,  margin: 0.684588, rec: 2.402981 },
  { sku: 'TOY-01',      duty_rate: 0.2,   duty_usd: 0.82,    landed: 5.299202,  margin: 0.538099, rec: 9.634913 },
  { sku: 'TOWEL-01',    duty_rate: 0.091, duty_usd: 0.2002,  landed: 2.603674,  margin: 0.676306, rec: 4.733953 },
  { sku: 'HEADSET-01',  duty_rate: 0.399, duty_usd: 4.389,   landed: 16.406371, margin: 0.521807, rec: 29.829766 },
  { sku: 'PILLOW-01',   duty_rate: 0.26,  duty_usd: 1.378,   landed: 7.168188,  margin: 0.524025, rec: 13.033069 },
]

describe('골든 테스트 — 10건 수기 계산 대조 (§6-1)', () => {
  const result = computeShipment(SHIP, GOLDEN_ITEMS, GOLDEN_LEDGER, FEES)

  it('선적 총계', () => {
    expect(result.totals.total_value).toBeCloseTo(23925, 6)
    expect(result.totals.mpf_shipment).toBeCloseTo(82.8762, 4)
    expect(result.totals.hmf_shipment).toBeCloseTo(29.90625, 5)
    expect(result.totals.freight_pool).toBe(2100)
  })

  for (const exp of EXPECTED) {
    it(`${exp.sku}: duty·landed·margin·권장가 일치 (±$0.01 이내)`, () => {
      const r = result.items.find((x) => x.sku === exp.sku)!
      expect(r.duty_rate_total).toBeCloseTo(exp.duty_rate, 6)
      expect(r.duty_usd).toBeCloseTo(exp.duty_usd, 4)
      expect(r.landed_cost).toBeCloseTo(exp.landed, 4)
      expect(r.true_margin!).toBeCloseTo(exp.margin, 4)
      expect(r.recommended_price!).toBeCloseTo(exp.rec, 4)
      expect(r.warnings).toEqual([])
    })
  }

  it('레이어 내역이 리포트에 표기 가능해야 함 (예: MUG = MFN+301+IEEPA)', () => {
    const mug = result.items.find((x) => x.sku === 'MUG-01')!
    const layers = Object.fromEntries(mug.duty_layers.map((l) => [l.layer, l.rate]))
    expect(layers).toEqual({ base_mfn: 0.098, section301: 0.25, ieepa_reciprocal: 0.1 })
  })
})
