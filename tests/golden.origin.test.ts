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
import type { ProgramContext } from '../src/lib/calc/engine'
import type { DutyProgram } from '../src/lib/calc/programs'
import { resolvePrograms } from '../src/lib/calc/programs'
import type { CalcItem, CalcShipment, FeeSettings, RateLayer, RateRow } from '../src/lib/calc/types'
import { parseItemsCsv } from '../src/lib/csv/parseItems'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadLedger(file: string): RateRow[] {
  const parsed = Papa.parse<Record<string, string>>(readFileSync(join(root, file), 'utf-8'), {
    header: true,
    skipEmptyLines: true,
  })
  return parsed.data.map((r) => ({
    program_code: r.program_code?.trim() || null,
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
  // 중국 리스트 301 은 시드 CSV 가 아니라 note 20 파싱 산출물에서 온다.
  // 이 테스트가 검사하는 것은 **스코핑 로직**이므로 대표 행 하나를 직접 둔다.
  {
    program_code: '301-china-list3', hts_code: '42029231', origin_country: 'CN',
    layer: 'section301', ad_valorem_rate: 0.25, effective_from: '2019-05-10', effective_to: null,
  } as RateRow,
]

const PROGRAMS: DutyProgram[] = [
  { code: 'mfn', name: 'Base MFN', authority: 'MFN', rate_type: 'additive', scope_type: 'hts_list', effective_from: '1900-01-01', effective_to: null },
  { code: '301-china-list3', name: 'China 301', authority: 'Section 301', rate_type: 'additive', scope_type: 'country_and_hts', effective_from: '2018-07-06', effective_to: null },
  { code: '301-forced-labor', name: 'Forced labor 301', authority: 'Section 301 FL', rate_type: 'additive', scope_type: 'country', effective_from: '2026-07-24', effective_to: null },
  { code: 'ieepa-reciprocal', name: 'IEEPA', authority: 'IEEPA', rate_type: 'additive', scope_type: 'country', effective_from: '2025-04-09', effective_to: '2026-02-24' },
]
const CTX: ProgramContext = { programs: PROGRAMS, exclusions: [] }

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
  'BRD-01': '441911',
  'CSE-01': '392690',
  'UTL-01': '392410',
}

describe('§검증2-4 — Section 301 원산지 스코핑', () => {
  it('중국 301 원장 행은 전부 origin_country=CN 이어야 한다', () => {
    const offenders = LEDGER.filter(
      (r) => r.program_code === '301-china-list3' && r.origin_country !== 'CN',
    ).map((r) => `${r.hts_code}/${r.origin_country ?? 'ALL'}`)
    expect(offenders).toEqual([])
  })

  it('중국 301 행에 origin_country=null 이 있으면 안 된다 — 비중국산에 새어나간다', () => {
    expect(
      LEDGER.filter((r) => r.program_code === '301-china-list3' && r.origin_country === null),
    ).toHaveLength(0)
  })

  it('CN 이 아닌 원산지는 어떤 HTS 로도 중국 301 이 적용되지 않는다', () => {
    const nonCn = ['VN', 'IN', 'TH', 'MX', 'KR', 'US', 'BD', 'ID', 'KH', 'TW']
    const htsCodes = [...new Set(LEDGER.map((r) => r.hts_code))].filter((h) => h !== '*')
    for (const origin of nonCn) {
      for (const hts of htsCodes) {
        const { applied } = resolvePrograms(LEDGER, PROGRAMS, [], hts.padEnd(10, '0'), origin, SHIP.rate_as_of)
        const cn301 = applied.find((a) => a.program_code === '301-china-list3')
        expect(cn301, `${hts} × ${origin} 에 중국 301 이 적용됨`).toBeUndefined()
      }
    }
  })

  it('원산지 대소문자·공백이 스코프를 우회하지 못한다', () => {
    for (const origin of ['vn', ' VN ', 'In', 'in']) {
      const { applied } = resolvePrograms(LEDGER, PROGRAMS, [], '4202923120', origin, SHIP.rate_as_of)
      expect(applied.find((a) => a.program_code === '301-china-list3')).toBeUndefined()
    }
    // CN 은 반대로 대소문자·공백과 무관하게 반드시 잡혀야 한다 (스코핑이 과하게 좁지 않은지)
    for (const origin of ['cn', ' CN ', 'Cn']) {
      const { applied } = resolvePrograms(LEDGER, PROGRAMS, [], '4202923120', origin, SHIP.rate_as_of)
      expect(applied.find((a) => a.program_code === '301-china-list3')?.applied_rate ?? 0).toBeGreaterThan(0)
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
  const result = computeShipment(SHIP, items, LEDGER, FEES, CTX)

  for (const r of result.items) {
    const origin = rows.find((x) => x.sku === r.sku)!.origin_country
    if (origin === 'CN') continue
    it(`${r.sku} (${origin}): 중국 301 미적용`, () => {
      expect(r.applied_programs.some((a) => a.program_code === '301-china-list3')).toBe(false)
      // duty 총합이 중국 301 을 뺀 나머지 프로그램으로 설명되어야 한다
      const sum = r.applied_programs.reduce((acc, a) => acc + a.applied_rate, 0)
      expect(r.duty_rate_total).toBeCloseTo(sum, 10)
    })
  }

  it('IEEPA 는 무효라 어떤 원산지에도 적용되지 않는다 (원장에 행이 남아 있어도)', () => {
    expect(LEDGER.some((r) => r.program_code === 'ieepa-reciprocal')).toBe(true)
    for (const r of result.items) {
      expect(r.applied_programs.some((a) => a.program_code === 'ieepa-reciprocal')).toBe(false)
    }
  })

  it('강제노동 301 은 국가 단위라 비중국산에도 붙는다 (중국 301 과 혼동 금지)', () => {
    const byOrigin = new Map(rows.map((r) => [r.sku, r.origin_country]))
    for (const r of result.items) {
      const origin = byOrigin.get(r.sku)!
      const hasRow = LEDGER.some(
        (x) => x.program_code === '301-forced-labor' && x.origin_country === origin,
      )
      const applied = r.applied_programs.find((a) => a.program_code === '301-forced-labor')
      if (hasRow) expect(applied?.applied_rate ?? 0).toBeGreaterThan(0)
      else expect(applied).toBeUndefined()
    }
  })
})
