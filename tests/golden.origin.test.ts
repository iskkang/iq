/**
 * §검증2-4 원산지 스코핑 — Section 301 은 중국산 전용.
 *
 * "VN·IN 상품에 301이 붙어 있으면 즉시 실패" (golden-test-plan-v1.md).
 * 원장의 301 행은 origin_country='CN' 으로만 존재해야 하고, 조회 계층이
 * 그 스코프를 절대 새게 해서는 안 된다. 이 파일은 그 두 가지를 모두 잠근다.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Papa from 'papaparse'
import { describe, expect, it } from 'vitest'
import { computeShipment } from '../src/lib/calc/engine'
import { lookupLayerRate } from '../src/lib/calc/rates'
import type { CalcItem, CalcShipment, FeeSettings, RateLayer, RateRow } from '../src/lib/calc/types'
import { parseItemsCsv } from '../src/lib/csv/parseItems'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadLedger(file: string): RateRow[] {
  const parsed = Papa.parse<Record<string, string>>(readFileSync(join(root, file), 'utf-8'), {
    header: true,
    skipEmptyLines: true,
  })
  return parsed.data.map((r) => ({
    hts_code: r.hts_code.trim(),
    origin_country: r.origin_country?.trim() ? r.origin_country.trim().toUpperCase() : null,
    layer: r.layer.trim() as RateLayer,
    ad_valorem_rate: Number(r.ad_valorem_rate),
    effective_from: r.effective_from.trim(),
    effective_to: r.effective_to?.trim() ? r.effective_to.trim() : null,
    source: r.source?.trim() || null,
    note: r.note?.trim() || null,
  }))
}

const LEDGER: RateRow[] = [
  ...loadLedger('supabase/seed/hts_seed_50.csv'),
  ...loadLedger('supabase/seed/hts_seed_golden_supplement.csv'),
]

const FEES: FeeSettings = {
  mpf_rate: 0.003464,
  mpf_min_usd: 32.71,
  mpf_max_usd: 634.62,
  hmf_rate: 0.00125,
  effective_from: '2024-10-01',
}

const SHIP: CalcShipment = {
  freight_usd: 4800,
  insurance_usd: 200,
  mode: 'ocean',
  allocation_basis: 'value',
  target_margin: 0.3,
  channel_fee_pct: 0.15,
  rate_as_of: '2026-07-29',
}

/** 계획서 §검증1 잠정 정답 6자리 — 정답을 확정했다고 가정한 최악 조건에서 검사 */
const TARGET_HTS: Record<string, string> = {
  'MUG-01': '691200',
  'BAG-01': '420292',
  'TUM-01': '961700',
  'LMP-01': '940521',
  'TSH-01': '610910',
  'SPK-01': '851822',
  'MAT-01': '950691',
  'BRD-01': '441912',
  'CSE-01': '392690',
  'UTL-01': '392410',
}

describe('§검증2-4 — Section 301 원산지 스코핑', () => {
  it('원장의 section301 행은 전부 origin_country=CN 이어야 한다', () => {
    const offenders = LEDGER.filter((r) => r.layer === 'section301' && r.origin_country !== 'CN').map(
      (r) => `${r.hts_code}/${r.origin_country ?? 'ALL'}`,
    )
    expect(offenders).toEqual([])
  })

  it('section301 행에 origin_country=null(전 원산지) 이 있으면 안 된다 — 비중국산에 새어나간다', () => {
    expect(LEDGER.filter((r) => r.layer === 'section301' && r.origin_country === null)).toHaveLength(0)
  })

  it('CN 이 아닌 원산지는 어떤 HTS 로도 section301 이 조회되지 않는다', () => {
    const nonCn = ['VN', 'IN', 'TH', 'MX', 'KR', 'US', 'BD', 'ID', 'KH', 'TW']
    const htsCodes = [...new Set(LEDGER.map((r) => r.hts_code))].filter((h) => h !== '*')
    for (const origin of nonCn) {
      for (const hts of htsCodes) {
        const hit = lookupLayerRate(LEDGER, 'section301', hts.padEnd(10, '0'), origin, SHIP.rate_as_of)
        expect(hit.rate, `${hts} × ${origin} 에 301 이 적용됨`).toBe(0)
        expect(hit.matched_hts, `${hts} × ${origin} 이 301 행에 매칭됨`).toBeNull()
      }
    }
  })

  it('원산지 대소문자·공백이 스코프를 우회하지 못한다', () => {
    for (const origin of ['vn', ' VN ', 'In', 'in']) {
      const hit = lookupLayerRate(LEDGER, 'section301', '6912004810', origin, SHIP.rate_as_of)
      expect(hit.rate).toBe(0)
    }
    // CN 은 반대로 대소문자·공백과 무관하게 반드시 잡혀야 한다 (스코핑이 과하게 좁지 않은지)
    for (const origin of ['cn', ' CN ', 'Cn']) {
      expect(lookupLayerRate(LEDGER, 'section301', '6912004810', origin, SHIP.rate_as_of).rate).toBeGreaterThan(0)
    }
  })
})

describe('§검증2-4 — 골든 CSV 실물 통과 시 비중국산에 301 미적용', () => {
  const { items: rows, errors } = parseItemsCsv(readFileSync(join(root, 'golden-test-products.csv'), 'utf-8'))

  it('golden-test-products.csv 가 오류 없이 파싱된다', () => {
    expect(errors).toEqual([])
    expect(rows).toHaveLength(10)
  })

  it('CSV 에 비중국산 SKU 가 실제로 들어 있어야 한다 (테스트가 공회전하지 않도록)', () => {
    expect(rows.filter((r) => r.origin_country !== 'CN').length).toBeGreaterThan(0)
  })

  const items: CalcItem[] = rows.map((r) => ({
    sku: r.sku,
    unit_cost_usd: r.unit_cost_usd,
    origin_country: r.origin_country,
    units_per_shipment: r.units_per_shipment,
    weight_kg_per_unit: r.weight_kg_per_unit,
    current_price_usd: r.current_price_usd,
    hts_code: TARGET_HTS[r.sku] ?? null,
  }))
  const result = computeShipment(SHIP, items, LEDGER, FEES)

  for (const r of result.items) {
    const origin = rows.find((x) => x.sku === r.sku)!.origin_country
    if (origin === 'CN') continue
    it(`${r.sku} (${origin}): section301 = 0`, () => {
      const layer = r.duty_layers.find((l) => l.layer === 'section301')!
      expect(layer.rate).toBe(0)
      expect(layer.matched_hts).toBeNull()
      // duty 총합이 MFN + IEEPA 만으로 설명되어야 한다
      const mfn = r.duty_layers.find((l) => l.layer === 'base_mfn')!.rate
      const ieepa = r.duty_layers.find((l) => l.layer === 'ieepa_reciprocal')!.rate
      expect(r.duty_rate_total).toBeCloseTo(mfn + ieepa, 10)
    })
  }

  it('IEEPA 는 국가 단위 레이어이므로 원산지별로 다르게 적용된다 (301 과 혼동 금지)', () => {
    const byOrigin = new Map(rows.map((r) => [r.sku, r.origin_country]))
    for (const r of result.items) {
      const ieepa = r.duty_layers.find((l) => l.layer === 'ieepa_reciprocal')!
      const origin = byOrigin.get(r.sku)!
      // 원장에 해당 국가 IEEPA 행이 있으면 매칭, 없으면 0 (스펙 §4)
      const hasRow = LEDGER.some(
        (x) => x.layer === 'ieepa_reciprocal' && x.origin_country === origin && x.effective_from <= SHIP.rate_as_of,
      )
      if (hasRow) expect(ieepa.rate).toBeGreaterThan(0)
      else expect(ieepa.rate).toBe(0)
    }
  })
})
