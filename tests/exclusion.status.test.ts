import { describe, expect, it } from 'vitest'
import { exclusionStatus, resolvePrograms } from '../src/lib/calc/programs'
import type { DutyProgram, ProgramExclusion } from '../src/lib/calc/programs'
import type { RateRow } from '../src/lib/calc/types'

const AS_OF = '2026-07-29'
const PROGRAMS: DutyProgram[] = [
  {
    code: '301-fl', name: 'Section 301 (forced labor)', authority: 'Section 301',
    rate_type: 'additive', scope_type: 'country', coverage: 'partial',
    effective_from: '2026-07-24', effective_to: null,
  },
]
const LEDGER: RateRow[] = [
  {
    program_code: '301-fl', hts_code: '*', origin_country: 'CN', layer: 'section301',
    ad_valorem_rate: 0.125, effective_from: '2026-07-24', effective_to: null,
  } as RateRow,
]
const rate = (excl: ProgramExclusion[]) =>
  resolvePrograms(LEDGER, PROGRAMS, excl, '6912004400', 'CN', AS_OF).total

describe('면제 판정 — 발효일과 미검증 구분', () => {
  const base = { program_code: '301-fl', hts_code: '6912' }

  it('근거가 확인된 면제는 세율을 0 으로 만든다', () => {
    const e: ProgramExclusion[] = [{ ...base, effective_from: '2026-07-24', source: 'USTR annex X' }]
    expect(exclusionStatus(e, '301-fl', '6912004400', AS_OF)).toBe('confirmed')
    expect(rate(e)).toBe(0)
  })

  /**
   * 오차 비대칭: 과대계상은 예산을 넉넉히 잡게 할 뿐이지만, 과소계상은 가격을
   * 잘못 매겨 마진을 잃는다 — 이 제품이 없애준다고 약속한 손해다.
   */
  it('미검증 면제는 적용하지 않고 전액 부과한다', () => {
    const e: ProgramExclusion[] = [
      { ...base, effective_from: '2026-07-24', source: 'UNVERIFIED — USTR 고시 미대조' },
    ]
    expect(exclusionStatus(e, '301-fl', '6912004400', AS_OF)).toBe('unverified')
    expect(rate(e), '미검증 면제가 세율을 0 으로 만들면 안 된다').toBeCloseTo(0.125, 6)
  })

  /** 발효일 규칙 — 만료된 면제는 적용되지 않는다 (rate_ledger 와 같은 규칙) */
  it('만료된 면제는 적용되지 않는다', () => {
    const e: ProgramExclusion[] = [
      { ...base, effective_from: '2026-07-24', effective_to: '2026-07-28', source: 'USTR annex X' },
    ]
    expect(exclusionStatus(e, '301-fl', '6912004400', AS_OF)).toBe('none')
    expect(rate(e), '만료 면제가 계속 0 을 만들면 무효 IEEPA 조항과 같은 실패다').toBeCloseTo(0.125, 6)
  })

  it('아직 발효 전인 면제도 적용되지 않는다', () => {
    const e: ProgramExclusion[] = [{ ...base, effective_from: '2026-08-01', source: 'USTR annex X' }]
    expect(exclusionStatus(e, '301-fl', '6912004400', AS_OF)).toBe('none')
    expect(rate(e)).toBeCloseTo(0.125, 6)
  })

  it('확인된 면제와 미검증 면제가 겹치면 확인된 쪽이 이긴다', () => {
    const e: ProgramExclusion[] = [
      { ...base, effective_from: '2026-07-24', source: 'UNVERIFIED — 미대조' },
      { ...base, effective_from: '2026-07-24', source: 'USTR annex X' },
    ]
    expect(exclusionStatus(e, '301-fl', '6912004400', AS_OF)).toBe('confirmed')
    expect(rate(e)).toBe(0)
  })
})
