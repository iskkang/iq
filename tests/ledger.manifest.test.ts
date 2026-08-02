/**
 * 원장 매니페스트 테스트 (백로그 A-2).
 *
 * ── 왜 있는가 ────────────────────────────────────────────────────
 * 탐지 계층의 실패는 조용하다. 해시가 입력 순서에 흔들리거나 아카이브 경계가
 * 하루 어긋나면, 매니페스트는 매번 "드리프트 없음" 을 찍으면서 실제 변경을
 * 놓친다. 그러면 없는 것보다 나쁘다 — 지켜지고 있다는 착각을 주기 때문이다.
 *
 * 그래서 세 가지를 못박는다: 순서 무관성, 경계일, 변화 종류의 구분.
 */
import { describe, it, expect } from 'vitest'
import { buildManifest, diffManifest, type LedgerRow } from '../scripts/lib/manifest'

const AS_OF = '2026-10-01' // FY2027 전환일 — 경계 버그가 실제로 나타났을 날

function row(over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    program_code: '301-china-list3',
    hts_code: '69120044',
    origin_country: 'CN',
    ad_valorem_rate: 0.25,
    effective_from: '2018-09-24',
    effective_to: null,
    ...over,
  }
}

describe('해시는 내용만 본다', () => {
  it('행 순서가 바뀌어도 같은 매니페스트다', () => {
    // PostgREST 는 정렬을 보장하지 않는다. 순서에 흔들리면 매일 거짓 드리프트가 뜬다
    const rows = [row(), row({ hts_code: '84011000' }), row({ hts_code: '39269056' })]
    const a = buildManifest(rows, AS_OF)
    const b = buildManifest([...rows].reverse(), AS_OF)
    expect(a.active['301-china-list3']).toEqual(b.active['301-china-list3'])
  })

  it('numeric 이 문자열로 와도 같은 해시다', () => {
    // PostgREST 는 numeric 을 문자열로 준다. 표기 차이로 해시가 흔들리면 안 된다
    const a = buildManifest([row({ ad_valorem_rate: 0.25 })], AS_OF)
    const b = buildManifest([row({ ad_valorem_rate: '0.250000' })], AS_OF)
    expect(a.active['301-china-list3'].rows_sha256).toBe(b.active['301-china-list3'].rows_sha256)
  })

  it('세율을 숫자로 못 읽으면 조용히 넘어가지 않는다', () => {
    expect(() => buildManifest([row({ ad_valorem_rate: 'n/a' })], AS_OF)).toThrow()
  })

  it('원산지 null 과 문자열 "*" 를 섞지 않는다', () => {
    const a = buildManifest([row({ origin_country: null })], AS_OF)
    const b = buildManifest([row({ origin_country: 'CN' })], AS_OF)
    expect(a.active['301-china-list3'].codes_sha256).not.toBe(b.active['301-china-list3'].codes_sha256)
  })
})

describe('아카이브 경계', () => {
  it('effective_to 가 as_of 인 행은 이미 아카이브다', () => {
    // 반열림 [from, to) — asOf >= effective_to 면 만료다. 하루짜리 구멍을 막는다
    const m = buildManifest([row({ effective_to: AS_OF })], AS_OF)
    expect(m.totals.archive).toBe(1)
    expect(m.totals.active).toBe(0)
  })

  it('내일 만료되는 행은 아직 살아 있다', () => {
    const m = buildManifest([row({ effective_to: '2026-10-02' })], AS_OF)
    expect(m.totals.active).toBe(1)
  })

  it('열린 행은 언제나 active 다', () => {
    expect(buildManifest([row({ effective_to: null })], AS_OF).totals.active).toBe(1)
  })
})

describe('드리프트 판정', () => {
  const base = buildManifest([row(), row({ hts_code: '84011000' })], AS_OF)

  it('변화가 없으면 조용하다', () => {
    expect(diffManifest(base, buildManifest([row({ hts_code: '84011000' }), row()], AS_OF))).toEqual([])
  })

  it('행이 사라지면 잡는다', () => {
    const d = diffManifest(base, buildManifest([row()], AS_OF))
    expect(d.map((x) => x.kind)).toContain('rows')
    expect(d.map((x) => x.kind)).toContain('membership')
  })

  it('구성원은 같은데 세율만 바뀌면 값 변화로 구분한다', () => {
    // "코드가 빠졌다" 와 "세율이 바뀌었다" 는 대응이 다르다
    const d = diffManifest(base, buildManifest([row({ ad_valorem_rate: 0.075 }), row({ hts_code: '84011000' })], AS_OF))
    expect(d).toHaveLength(1)
    expect(d[0].kind).toBe('values')
  })

  it('프로그램이 통째로 사라지면 잡는다', () => {
    const d = diffManifest(base, buildManifest([row({ program_code: '301-china-list1' }), row({ hts_code: '84011000' })], AS_OF))
    expect(d.map((x) => x.kind).sort()).toEqual(['added', 'membership', 'rows'])
  })

  it('아카이브 행이 지워지면 잡는다 — 과거 선적 재계산의 근거다', () => {
    const withArchive = buildManifest([row(), row({ effective_to: '2025-01-01' })], AS_OF)
    const d = diffManifest(withArchive, buildManifest([row()], AS_OF))
    expect(d.some((x) => x.section === 'archive' && x.kind === 'removed')).toBe(true)
  })
})
