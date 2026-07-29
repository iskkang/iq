/**
 * 골든 테스트 하니스 (수용 기준 §6-1).
 *
 * ⚠ v4 재기준화: IEEPA 는 2026-02-20 연방대법원 판결로 무효이고 02-24 종료다.
 * rate_as_of 가 2026-07-01 이므로 프로그램 발효일에 의해 **자동으로 빠진다** —
 * 아래 기대값은 MFN + 중국 301 만으로 다시 계산했다. 코드가 아니라 데이터가
 * 프로그램을 끄는지 확인하는 것이 이 fixture 의 새 역할이다.
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
import type { ProgramContext } from '../src/lib/calc/engine'
import type { DutyProgram } from '../src/lib/calc/programs'

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
  // 대법원 무효 판결 → 2026-02-24 종료. rate_as_of(2026-07-01) 에서 자동 제외된다.
  { code: 'ieepa', name: 'IEEPA reciprocal', authority: 'IEEPA', rate_type: 'additive', scope_type: 'country', effective_from: '2025-04-09', effective_to: '2026-02-24' },
]
const CTX: ProgramContext = { programs: PROGRAMS, exclusions: [] }

const GOLDEN_LEDGER: RateRow[] = [
  // base MFN
  { program_code: 'mfn', hts_code: '6912004810', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.098, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '6109100004', origin_country: null, program_code: 'mfn', layer: 'base_mfn', ad_valorem_rate: 0.165, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '3924104000', origin_country: null, program_code: 'mfn', layer: 'base_mfn', ad_valorem_rate: 0.034, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '4202923120', origin_country: null, program_code: 'mfn', layer: 'base_mfn', ad_valorem_rate: 0.176, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '7323930060', origin_country: null, program_code: 'mfn', layer: 'base_mfn', ad_valorem_rate: 0.02, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '8544429090', origin_country: null, program_code: 'mfn', layer: 'base_mfn', ad_valorem_rate: 0.026, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '9503000073', origin_country: null, program_code: 'mfn', layer: 'base_mfn', ad_valorem_rate: 0, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '6302600020', origin_country: null, program_code: 'mfn', layer: 'base_mfn', ad_valorem_rate: 0.091, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '8518302000', origin_country: null, program_code: 'mfn', layer: 'base_mfn', ad_valorem_rate: 0.049, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '9404902000', origin_country: null, program_code: 'mfn', layer: 'base_mfn', ad_valorem_rate: 0.06, effective_from: '2025-01-01', effective_to: null },
  // Section 301 (CN)
  { hts_code: '6912', origin_country: 'CN', program_code: '301-china', layer: 'section301', ad_valorem_rate: 0.25, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '6109', origin_country: 'CN', program_code: '301-china', layer: 'section301', ad_valorem_rate: 0.075, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '3924', origin_country: 'CN', program_code: '301-china', layer: 'section301', ad_valorem_rate: 0.25, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '4202', origin_country: 'CN', program_code: '301-china', layer: 'section301', ad_valorem_rate: 0.25, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '7323', origin_country: 'CN', program_code: '301-china', layer: 'section301', ad_valorem_rate: 0.25, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '8544', origin_country: 'CN', program_code: '301-china', layer: 'section301', ad_valorem_rate: 0.25, effective_from: '2025-01-01', effective_to: null },
  { hts_code: '8518', origin_country: 'CN', program_code: '301-china', layer: 'section301', ad_valorem_rate: 0.25, effective_from: '2025-01-01', effective_to: null },
  // IEEPA reciprocal (국가 단위)
  { hts_code: '*', origin_country: 'CN', program_code: 'ieepa', layer: 'ieepa_reciprocal', ad_valorem_rate: 0.1, effective_from: '2025-04-09', effective_to: null },
  { hts_code: '*', origin_country: 'VN', program_code: 'ieepa', layer: 'ieepa_reciprocal', ad_valorem_rate: 0.2, effective_from: '2025-04-09', effective_to: null },
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
  { sku: 'MUG-01',      duty_rate: 0.348, duty_usd: 0.87,   landed: 3.601221,  margin: 0.572770, rec: 6.547675 },
  { sku: 'TSHIRT-01',   duty_rate: 0.24,  duty_usd: 0.768,  landed: 4.263963,  margin: 0.636695, rec: 7.752660 },
  { sku: 'BOTTLE-01',   duty_rate: 0.284, duty_usd: 0.5112, landed: 2.477679,  margin: 0.601984, rec: 4.504871 },
  { sku: 'BACKPACK-01', duty_rate: 0.426, duty_usd: 3.621,  landed: 12.907151, margin: 0.527241, rec: 23.467547 },
  { sku: 'PAN-01',      duty_rate: 0.27,  duty_usd: 1.728,  landed: 8.719925,  margin: 0.501063, rec: 15.854409 },
  { sku: 'CABLE-01',    duty_rate: 0.276, duty_usd: 0.2484, landed: 1.231639,  margin: 0.695853, rec: 2.239344 },
  { sku: 'TOY-01',      duty_rate: 0,     duty_usd: 0,      landed: 4.479202,  margin: 0.586363, rec: 8.144004 },
  { sku: 'TOWEL-01',    duty_rate: 0.091, duty_usd: 0.2002, landed: 2.603674,  margin: 0.676306, rec: 4.733953 },
  { sku: 'HEADSET-01',  duty_rate: 0.299, duty_usd: 3.289,  landed: 15.306371, margin: 0.543811, rec: 27.829765 },
  { sku: 'PILLOW-01',   duty_rate: 0.06,  duty_usd: 0.318,  landed: 6.108188,  margin: 0.572229, rec: 11.105796 },
]

describe('골든 테스트 — 10건 수기 계산 대조 (§6-1)', () => {
  const result = computeShipment(SHIP, GOLDEN_ITEMS, GOLDEN_LEDGER, FEES, CTX)

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
      // 원장에 없는 프로그램은 "미확인" 경고가 남는다 — 조용한 0 금지
      expect(r.warnings.filter((w) => !w.includes('not confirmed'))).toEqual([])
    })
  }

  it('적용 프로그램이 리포트에 표기 가능해야 함 (MUG = MFN + 중국301)', () => {
    const mug = result.items.find((x) => x.sku === 'MUG-01')!
    const byCode = Object.fromEntries(mug.applied_programs.map((a) => [a.program_code, a.applied_rate]))
    expect(byCode).toEqual({ mfn: 0.098, '301-china': 0.25 })
  })

  it('IEEPA 는 원장에 행이 있어도 발효일 때문에 적용되지 않는다', () => {
    // 코드에 IEEPA 를 언급하는 분기가 없다 — 데이터(effective_to)만으로 꺼진다
    const hasIeepaRow = GOLDEN_LEDGER.some((r) => r.program_code === 'ieepa')
    expect(hasIeepaRow).toBe(true)
    for (const r of result.items) {
      expect(r.applied_programs.some((a) => a.program_code === 'ieepa')).toBe(false)
    }
  })
})
