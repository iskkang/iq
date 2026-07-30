/**
 * 발효일을 가진 참조 테이블마다 "만료된 행은 적용되지 않는다" 를 증명한다.
 *
 * ── 왜 테이블별로 따로 두는가 ────────────────────────────────────
 * CI 스키마 검사는 **컬럼 존재**만 본다. 컬럼이 있는데 코드가 안 읽는 경우를
 * 못 잡는다 — 실제로 두 번 있었다:
 *   isExcluded  effective_to 컬럼을 추가했는데 판정 로직이 읽지 않았다
 *   getFees     effective_from 최신 행만 집고 effective_to 를 조건에 안 넣었다
 * 그래서 테이블마다 "만료 행을 넣으면 적용 안 됨" 을 한 건씩 못박는다.
 * 새 참조 테이블이 생겼을 때 여기 빠진 게 눈에 띄도록 한 파일에 모은다.
 *
 * ── 이 파일이 덮지 못하는 것 ─────────────────────────────────────
 * fee_settings 의 실제 선택은 Supabase 쿼리(서버측 필터)에서 일어난다. 여기서는
 * **규칙(inEffect)** 이 맞는지만 본다. 쿼리가 그 규칙을 실제로 밀어넣는지는
 * SOP 분기 점검의 실조회가 담당한다 (2층). 이 한계를 적어두는 이유는, 적지
 * 않으면 다음 사람이 "테스트가 있으니 커버된다" 고 오해하기 때문이다.
 */
import { describe, expect, it } from 'vitest'
import { inEffect, resolvePrograms, exclusionStatus } from '../src/lib/calc/programs'
import type { DutyProgram, ProgramExclusion } from '../src/lib/calc/programs'
import type { RateRow } from '../src/lib/calc/types'

const AS_OF = '2026-07-29'

describe('발효 구간 규칙 — [from, to) 반열림', () => {
  it('만료일 당일부터 미적용이다', () => {
    expect(inEffect('2025-01-01', '2026-07-29', AS_OF), '만료일 당일은 미적용').toBe(false)
    expect(inEffect('2025-01-01', '2026-07-30', AS_OF), '만료 하루 전은 적용').toBe(true)
  })
  it('발효일 당일부터 적용된다', () => {
    expect(inEffect('2026-07-29', null, AS_OF)).toBe(true)
    expect(inEffect('2026-07-30', null, AS_OF), '발효 하루 전은 미적용').toBe(false)
  })
  it('effective_to 가 null 이면 현행이다', () => {
    expect(inEffect('2018-07-06', null, AS_OF)).toBe(true)
  })
})

const PROG = (over: Partial<DutyProgram> = {}): DutyProgram => ({
  code: 'p', name: 'p', authority: 'Section 301', rate_type: 'additive',
  scope_type: 'country', coverage: 'partial',
  effective_from: '2020-01-01', effective_to: null, ...over,
})
const ROW = (over: Partial<RateRow> = {}): RateRow =>
  ({
    program_code: 'p', hts_code: '*', origin_country: 'CN', layer: 'section301',
    ad_valorem_rate: 0.25, effective_from: '2020-01-01', effective_to: null, ...over,
  }) as RateRow
const total = (ledger: RateRow[], programs: DutyProgram[], excl: ProgramExclusion[] = []) =>
  resolvePrograms(ledger, programs, excl, '6912004400', 'CN', AS_OF).total

describe('만료된 행은 적용되지 않는다 — 테이블별', () => {
  it('rate_ledger — 만료된 원장 행', () => {
    expect(total([ROW()], [PROG()])).toBeCloseTo(0.25, 6)
    expect(total([ROW({ effective_to: '2026-02-24' })], [PROG()]), '만료 원장 행이 적용되면 안 된다').toBe(0)
  })

  it('duty_programs — 만료된 프로그램 (IEEPA 사례)', () => {
    expect(total([ROW()], [PROG({ effective_to: '2026-02-24' })], []), '만료 프로그램이 적용되면 안 된다').toBe(0)
  })

  it('program_exclusions — 만료된 면제는 세율을 0 으로 만들지 않는다', () => {
    const live: ProgramExclusion[] = [{ program_code: 'p', hts_code: '6912', source: 'USTR annex' }]
    const dead: ProgramExclusion[] = [{ ...live[0], effective_to: '2026-07-01' }]
    expect(total([ROW()], [PROG()], live), '유효 면제는 0').toBe(0)
    expect(total([ROW()], [PROG()], dead), '만료 면제가 계속 0 을 만들면 IEEPA 와 같은 실패다').toBeCloseTo(0.25, 6)
    expect(exclusionStatus(dead, 'p', '6912004400', AS_OF)).toBe('none')
  })

  /**
   * fee_settings 는 Supabase 쿼리가 서버측에서 고른다. 여기서는 규칙만 검증한다 —
   * getFees 가 `.lte(effective_from, asOf).or(effective_to.is.null, effective_to.gt.asOf)`
   * 로 같은 반열림 구간을 밀어넣는다.
   */
  it('fee_settings — 만료된 요율 행은 선택 대상이 아니다 (규칙 수준)', () => {
    const fy2025 = { effective_from: '2024-10-01', effective_to: '2025-10-01' }
    const fy2026 = { effective_from: '2025-10-01', effective_to: null }
    expect(inEffect(fy2025.effective_from, fy2025.effective_to, AS_OF), 'FY2025 는 만료됐다').toBe(false)
    expect(inEffect(fy2026.effective_from, fy2026.effective_to, AS_OF), 'FY2026 이 현행이다').toBe(true)
    // 2025-09-30 시점이면 반대여야 한다
    expect(inEffect(fy2025.effective_from, fy2025.effective_to, '2025-09-30')).toBe(true)
    expect(inEffect(fy2026.effective_from, fy2026.effective_to, '2025-09-30')).toBe(false)
  })
})
