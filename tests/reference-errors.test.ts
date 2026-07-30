/**
 * 참조 데이터 조회 실패의 두 갈래 판정 (B-4).
 *
 * **체인 mock 을 쓰지 않는다.** .from().select().lte().or().order().limit()
 * .maybeSingle() 을 흉내내면 그 mock 자체가 유지 부담이 되고, 나중에 쿼리를 한
 * 군데 고칠 때 mock 을 안 고치면 테스트는 통과하면서 실제는 깨진다 — 이 저장소가
 * 반복해서 당한 패턴이다.
 *
 * 그래서 판정을 순수 함수(forEmptyLookup)로 분리해 입력만으로 검증한다.
 * "쿼리가 실제로 그 필터를 미는가" 는 SOP 분기 점검의 실조회 몫이다.
 */
import { describe, expect, it } from 'vitest'
import { ReferenceDataError } from '../src/lib/repo/errors'

const AS_OF = '2026-07-29'

describe('참조 데이터 조회 실패 — config vs coverage', () => {
  it('테이블이 비어 있으면 config (배포·설정 실패)', () => {
    const e = ReferenceDataError.forEmptyLookup('fee_settings', AS_OF, false)
    expect(e.kind).toBe('config')
    expect(e.table).toBe('fee_settings')
    expect(e.message, '운영자가 고칠 문제임이 드러나야 한다').toContain('configuration problem')
  })

  it('행은 있는데 기준일을 못 덮으면 coverage (사용자 입력 문제)', () => {
    const e = ReferenceDataError.forEmptyLookup('fee_settings', AS_OF, true)
    expect(e.kind).toBe('coverage')
    expect(e.message, '어느 날짜가 문제인지 알려줘야 한다').toContain(AS_OF)
  })

  /**
   * 둘이 뭉치면 전체 장애가 "날짜를 확인하세요" 로 나가고 아무도 원인을 못 찾는다.
   * 이 세션에서 잡은 문제 대부분이 "구분이 코드로 고정되지 않아 뭉쳐진 것" 이었다.
   */
  it('두 갈래가 실제로 구분된다', () => {
    const config = ReferenceDataError.forEmptyLookup('rate_ledger', AS_OF, false)
    const coverage = ReferenceDataError.forEmptyLookup('rate_ledger', AS_OF, true)
    expect(config.kind).not.toBe(coverage.kind)
    expect(config.message).not.toBe(coverage.message)
  })

  it('ReferenceDataError 는 Error 이므로 기존 .catch 경로로 전달된다', () => {
    const e = ReferenceDataError.config('duty_programs')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('ReferenceDataError')
  })
})
