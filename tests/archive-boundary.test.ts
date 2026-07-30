/**
 * 아카이브 경계일 회귀 테스트.
 *
 * ── 왜 있는가 ────────────────────────────────────────────────────
 * 아카이브 규칙을 넣을 때 날짜 판정이 **두 벌**이 됐다:
 *   deleteOwned 의 PostgREST 필터 → effective_to.gte.today
 *   seed-rates 의 JS 필터        → effective_to <  today
 * 두 경계가 서로 달랐고, 둘 다 getFees 의 `gt` 와도 달랐다.
 *
 * 반열림 `[from, to)` 규칙에서 `asOf >= effective_to` 면 이미 만료다. 따라서
 * **effective_to 가 오늘인 행은 오늘 이미 아카이브**이고 삭제 대상이 아니다.
 * `gte` 를 쓰면 그 행이 하루 동안만 삭제 가능 집합에 들어간다.
 *
 * 하루짜리 버그라 잡히지 않는다 — 그리고 그 하루가 하필 FY2027 전환일
 * (2026-10-01) 처럼 실제로 세율이 바뀌는 날이다.
 */
import { describe, it, expect } from 'vitest'
import { isArchived, archiveSafeFilter } from '../scripts/lib/db'
import { inEffect } from '../src/lib/calc/programs'

const TODAY = '2026-10-01' // FY2027 전환일 — 이 버그가 실제로 나타났을 날

describe('아카이브 경계일', () => {
  it('오늘 만료되는 행은 오늘 이미 아카이브다', () => {
    expect(isArchived(TODAY, TODAY)).toBe(true)
  })

  it('내일 만료되는 행은 아직 살아 있다', () => {
    expect(isArchived('2026-10-02', TODAY)).toBe(false)
  })

  it('어제 만료된 행은 아카이브다', () => {
    expect(isArchived('2026-09-30', TODAY)).toBe(true)
  })

  it('열린 행(effective_to 없음)은 아카이브가 아니다', () => {
    expect(isArchived(null, TODAY)).toBe(false)
    expect(isArchived(undefined, TODAY)).toBe(false)
    expect(isArchived('', TODAY)).toBe(false)
  })

  it('inEffect 와 같은 경계를 쓴다 (판정이 한 곳에만 있다)', () => {
    for (const to of ['2026-09-30', TODAY, '2026-10-02']) {
      expect(isArchived(to, TODAY)).toBe(!inEffect('1900-01-01', to, TODAY))
    }
  })
})

/**
 * PostgREST 필터 문자열을 실제로 평가해 JS 판정과 대조한다.
 *
 * 필터는 SQL 문자열이라 inEffect 를 직접 부를 수 없다 — 그래서 두 벌이 될
 * 수밖에 없고, 그 둘이 같은지는 여기서만 확인할 수 있다.
 */
function matchesFilter(filter: string, effectiveTo: string | null): boolean {
  const m = filter.match(/^or=\(effective_to\.is\.null,effective_to\.(gt|gte)\.(\d{4}-\d{2}-\d{2})\)$/)
  if (!m) throw new Error(`필터 모양이 바뀌었다 — 테스트를 같이 고칠 것: ${filter}`)
  const [, op, date] = m
  if (effectiveTo === null) return true
  return op === 'gt' ? effectiveTo > date : effectiveTo >= date
}

describe('deleteOwned 삭제 필터', () => {
  const filter = archiveSafeFilter(TODAY)

  it('gte 가 아니라 gt 를 쓴다', () => {
    expect(filter).toContain('.gt.')
    expect(filter).not.toContain('.gte.')
  })

  it('effective_to == 오늘인 행은 삭제 대상에 들어가지 않는다', () => {
    expect(matchesFilter(filter, TODAY)).toBe(false)
  })

  it('모든 날짜에서 isArchived 와 정확히 반대다', () => {
    const dates = ['2020-01-01', '2026-09-30', TODAY, '2026-10-02', '2099-01-01']
    for (const to of dates) {
      expect(matchesFilter(filter, to)).toBe(!isArchived(to, TODAY))
    }
    expect(matchesFilter(filter, null)).toBe(!isArchived(null, TODAY))
  })
})
