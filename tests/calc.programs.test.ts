/**
 * 관세 프로그램 해석 — 발효일·적용범위·가산방식.
 *
 * 지키려는 것:
 *   - 만료된 프로그램은 자동으로 빠진다 (IEEPA 무효화가 코드 수정 없이 반영돼야 한다)
 *   - scope_type 이 적용 대상을 가른다 (4자리 301 같은 구조적 오류 재발 방지)
 *   - top_up_to_total 은 합계 목표를 채우는 차액만 더한다 (EU·대만·일본·한국·스위스)
 *   - 면제 목록(강제노동 301 의 471개 소호)이 해당 프로그램만 0 으로 만든다
 */
import { describe, expect, it } from 'vitest'
import { isExcluded, programBreakdownLabel, resolvePrograms } from '../src/lib/calc/programs'
import type { DutyProgram, ProgramExclusion } from '../src/lib/calc/programs'
import type { RateRow } from '../src/lib/calc/types'

const PROGRAMS: DutyProgram[] = [
  { code: 'mfn', name: 'Base MFN', authority: 'MFN', rate_type: 'additive', scope_type: 'hts_list', effective_from: '1900-01-01', effective_to: null },
  { code: '301-china-legacy', name: 'China 301 Lists', authority: 'Section 301', rate_type: 'additive', scope_type: 'country_and_hts', effective_from: '2018-07-06', effective_to: null },
  { code: 'ieepa', name: 'IEEPA reciprocal', authority: 'IEEPA', rate_type: 'additive', scope_type: 'country', effective_from: '2025-04-09', effective_to: '2026-02-24' },
  { code: '122', name: 'Section 122', authority: 'Section 122', rate_type: 'additive', scope_type: 'all', effective_from: '2026-02-24', effective_to: '2026-07-24' },
  { code: '301-fl', name: 'Forced labor 301', authority: 'Section 301', rate_type: 'additive', scope_type: 'country', effective_from: '2026-07-24', effective_to: null },
  { code: '301-fl-topup', name: 'Forced labor 301 (top-up)', authority: 'Section 301', rate_type: 'top_up_to_total', scope_type: 'country', effective_from: '2026-07-24', effective_to: null },
]

const row = (p: Partial<RateRow> & { program_code: string; ad_valorem_rate: number }): RateRow => ({
  hts_code: '*',
  origin_country: null,
  layer: 'base_mfn',
  effective_from: '2000-01-01',
  effective_to: null,
  ...p,
})

const LEDGER: RateRow[] = [
  row({ program_code: 'mfn', hts_code: '6912004810', ad_valorem_rate: 0.098 }),
  row({ program_code: 'mfn', hts_code: '8518220000', ad_valorem_rate: 0.049 }),
  row({ program_code: '301-china-legacy', hts_code: '69120048', origin_country: 'CN', ad_valorem_rate: 0.25 }),
  row({ program_code: 'ieepa', origin_country: 'CN', ad_valorem_rate: 0.1, effective_from: '2025-04-09' }),
  row({ program_code: '122', ad_valorem_rate: 0.1, effective_from: '2026-02-24' }),
  row({ program_code: '301-fl', origin_country: 'CN', ad_valorem_rate: 0.125, effective_from: '2026-07-24' }),
  row({ program_code: '301-fl', origin_country: 'IN', ad_valorem_rate: 0.1, effective_from: '2026-07-24' }),
  // EU: MFN+301 합계가 10% 가 되도록
  row({ program_code: '301-fl-topup', origin_country: 'DE', ad_valorem_rate: 0.1, effective_from: '2026-07-24' }),
  // 일본: 합계 12.5%
  row({ program_code: '301-fl-topup', origin_country: 'JP', ad_valorem_rate: 0.125, effective_from: '2026-07-24' }),
]

const NO_EXCL: ProgramExclusion[] = []
const rateOf = (r: ReturnType<typeof resolvePrograms>, code: string) =>
  r.applied.find((a) => a.program_code === code)?.applied_rate ?? 0

describe('발효일 — 만료된 프로그램은 자동으로 빠진다', () => {
  it('2025-06 (IEEPA 시절): MFN + 중국301 + IEEPA', () => {
    const r = resolvePrograms(LEDGER, PROGRAMS, NO_EXCL, '6912004810', 'CN', '2025-06-01')
    expect(rateOf(r, 'ieepa')).toBeCloseTo(0.1, 10)
    expect(rateOf(r, '122')).toBe(0)
    expect(r.total).toBeCloseTo(0.098 + 0.25 + 0.1, 10)
  })

  it('2026-04 (Section 122 시절): IEEPA 는 무효라 빠지고 122 가 든다', () => {
    const r = resolvePrograms(LEDGER, PROGRAMS, NO_EXCL, '6912004810', 'CN', '2026-04-01')
    expect(rateOf(r, 'ieepa')).toBe(0) // 코드 수정 없이 데이터만으로 빠진다
    expect(rateOf(r, '122')).toBeCloseTo(0.1, 10)
    expect(r.total).toBeCloseTo(0.098 + 0.25 + 0.1, 10)
  })

  it('2026-07-29 (현행): 122 만료, 강제노동 301 12.5%', () => {
    const r = resolvePrograms(LEDGER, PROGRAMS, NO_EXCL, '6912004810', 'CN', '2026-07-29')
    expect(rateOf(r, 'ieepa')).toBe(0)
    expect(rateOf(r, '122')).toBe(0)
    expect(rateOf(r, '301-fl')).toBeCloseTo(0.125, 10)
    expect(r.total).toBeCloseTo(0.098 + 0.25 + 0.125, 10)
  })

  it('만료일 당일부터 미적용 (경계)', () => {
    expect(rateOf(resolvePrograms(LEDGER, PROGRAMS, NO_EXCL, '6912004810', 'CN', '2026-07-23'), '122')).toBeCloseTo(0.1, 10)
    expect(rateOf(resolvePrograms(LEDGER, PROGRAMS, NO_EXCL, '6912004810', 'CN', '2026-07-24'), '122')).toBe(0)
  })

  it('발효 전에는 적용되지 않는다', () => {
    expect(rateOf(resolvePrograms(LEDGER, PROGRAMS, NO_EXCL, '6912004810', 'CN', '2026-07-23'), '301-fl')).toBe(0)
  })
})

describe('scope_type — 적용 대상을 가른다', () => {
  it('country_and_hts: 중국 301 은 HTS 가 목록에 있어야 붙는다', () => {
    // 8518220000 은 중국301 원장 행(69120048)에 매칭되지 않는다
    const r = resolvePrograms(LEDGER, PROGRAMS, NO_EXCL, '8518220000', 'CN', '2026-07-29')
    expect(rateOf(r, '301-china-legacy')).toBe(0)
    expect(rateOf(r, 'mfn')).toBeCloseTo(0.049, 10)
    expect(rateOf(r, '301-fl')).toBeCloseTo(0.125, 10) // 국가 단위라 붙는다
  })

  it('country_and_hts: 원산지가 다르면 안 붙는다', () => {
    const r = resolvePrograms(LEDGER, PROGRAMS, NO_EXCL, '6912004810', 'VN', '2026-07-29')
    expect(rateOf(r, '301-china-legacy')).toBe(0)
  })

  it('country: 국가만 맞으면 HTS 무관하게 붙는다', () => {
    const r = resolvePrograms(LEDGER, PROGRAMS, NO_EXCL, '8518220000', 'IN', '2026-07-29')
    expect(rateOf(r, '301-fl')).toBeCloseTo(0.1, 10) // 인도 10%
  })

  it('all: 전 품목·전 원산지 (Section 122)', () => {
    const r = resolvePrograms(LEDGER, PROGRAMS, NO_EXCL, '8518220000', 'BR', '2026-04-01')
    expect(rateOf(r, '122')).toBeCloseTo(0.1, 10)
  })

  it('원장에 그 국가 행이 없으면 country 프로그램은 안 붙는다', () => {
    const r = resolvePrograms(LEDGER, PROGRAMS, NO_EXCL, '6912004810', 'BR', '2026-07-29')
    expect(rateOf(r, '301-fl')).toBe(0)
  })
})

describe('top_up_to_total — 합계 목표를 채우는 차액만', () => {
  it('EU: MFN 9.8% 면 301 은 0.2% 만 (합계 10%)', () => {
    const r = resolvePrograms(LEDGER, PROGRAMS, NO_EXCL, '6912004810', 'DE', '2026-07-29')
    expect(rateOf(r, '301-fl-topup')).toBeCloseTo(0.002, 10)
    expect(r.total).toBeCloseTo(0.1, 10)
  })

  it('일본: MFN 4.9% 면 301 은 7.6% (합계 12.5%)', () => {
    const r = resolvePrograms(LEDGER, PROGRAMS, NO_EXCL, '8518220000', 'JP', '2026-07-29')
    expect(rateOf(r, '301-fl-topup')).toBeCloseTo(0.076, 10)
    expect(r.total).toBeCloseTo(0.125, 10)
  })

  it('MFN 이 이미 목표를 넘으면 0 을 더한다 (음수 금지)', () => {
    const high: RateRow[] = [
      row({ program_code: 'mfn', hts_code: '6912004810', ad_valorem_rate: 0.30 }),
      row({ program_code: '301-fl-topup', origin_country: 'DE', ad_valorem_rate: 0.1, effective_from: '2026-07-24' }),
    ]
    const r = resolvePrograms(high, PROGRAMS, NO_EXCL, '6912004810', 'DE', '2026-07-29')
    expect(rateOf(r, '301-fl-topup')).toBe(0)
    expect(r.total).toBeCloseTo(0.30, 10)
  })

  it('가산이 먼저, 상한 보정이 나중 — 순서가 결과를 바꾼다', () => {
    // 현행 Σ layers 엔진이라면 0.098 + 0.1 = 19.8% 로 틀렸을 값
    const r = resolvePrograms(LEDGER, PROGRAMS, NO_EXCL, '6912004810', 'DE', '2026-07-29')
    expect(r.total).not.toBeCloseTo(0.198, 3)
    expect(r.total).toBeCloseTo(0.1, 10)
  })
})

describe('면제 목록 — 해당 프로그램만 0', () => {
  const EXCL: ProgramExclusion[] = [{ program_code: '301-fl', hts_code: '6912' }]

  it('면제되면 그 프로그램만 0, MFN 은 그대로', () => {
    const r = resolvePrograms(LEDGER, PROGRAMS, EXCL, '6912004810', 'CN', '2026-07-29')
    expect(rateOf(r, '301-fl')).toBe(0)
    expect(rateOf(r, 'mfn')).toBeCloseTo(0.098, 10)
    expect(rateOf(r, '301-china-legacy')).toBeCloseTo(0.25, 10) // 다른 프로그램은 영향 없음
    expect(r.total).toBeCloseTo(0.098 + 0.25, 10)
  })

  it('면제는 프리픽스 매칭', () => {
    expect(isExcluded(EXCL, '301-fl', '6912004810')).toBe(true)
    expect(isExcluded(EXCL, '301-fl', '8518220000')).toBe(false)
    expect(isExcluded(EXCL, '301-china-legacy', '6912004810')).toBe(false)
  })

  it('면제된 프로그램도 applied 에 남아 감사 추적이 된다', () => {
    const r = resolvePrograms(LEDGER, PROGRAMS, EXCL, '6912004810', 'CN', '2026-07-29')
    const fl = r.applied.find((a) => a.program_code === '301-fl')!
    expect(fl.excluded).toBe(true)
    expect(fl.ledger_rate).toBeCloseTo(0.125, 10)
    expect(fl.applied_rate).toBe(0)
  })
})

describe('리포트 라벨', () => {
  it('가산 프로그램을 나열한다', () => {
    const r = resolvePrograms(LEDGER, PROGRAMS, NO_EXCL, '6912004810', 'CN', '2026-07-29')
    const label = programBreakdownLabel(r.applied)
    expect(label).toContain('MFN 9.8%')
    expect(label).toContain('Section 301')
  })

  it('상한 보정형은 목표 합계를 함께 보여준다', () => {
    const r = resolvePrograms(LEDGER, PROGRAMS, NO_EXCL, '8518220000', 'JP', '2026-07-29')
    expect(programBreakdownLabel(r.applied)).toContain('to 12.5% total')
  })

  it('적용된 게 없으면 0%', () => {
    expect(programBreakdownLabel([])).toBe('0%')
  })
})
