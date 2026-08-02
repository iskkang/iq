/**
 * 웨이브 1 선정 테스트.
 *
 * ── 왜 있는가 ────────────────────────────────────────────────────
 * 웨이브 1 은 "코드 페이지가 색인될 만한가" 를 재는 표본이다. 표본이 한 장에
 * 쏠리거나 게이트를 통과 못 한 코드가 섞이면, 나온 색인률은 카탈로그 전체에
 * 대해 아무것도 말해주지 않는다. 그 상태로 웨이브 2 를 내보내면 잘못된 근거로
 * 수천 장을 발행하게 된다.
 *
 * 정책: docs/seo-indexing-policy.md §5
 */
import { describe, it, expect } from 'vitest'
import { selectWave, isSeed, chapterSpread, type WaveCandidate } from '../src/lib/seo/wave'

function c(code: string, over: Partial<WaveCandidate> = {}): WaveCandidate {
  return {
    code,
    description: 'Ceramic tableware > Other than porcelain > Mugs and other steins',
    adValorem: 0.098,
    programs: ['301-list3'],
    programRate: 0.25,
    demandRank: null,
    ...over,
  }
}

describe('시드 판정', () => {
  it('관측 질의는 6자리라 접두어로 맞춘다', () => {
    // 광고 검색어가 "711319 hs code" 였다 — 8자리가 아니다
    expect(isSeed('71131900', ['711319'])).toBe(true)
    expect(isSeed('71131950', ['711319'])).toBe(true)
  })

  it('다른 코드는 시드가 아니다', () => {
    expect(isSeed('69120044', ['711319'])).toBe(false)
  })
})

describe('선정', () => {
  it('게이트를 통과 못 한 코드는 뽑지 않는다', () => {
    const out = selectWave(
      [c('69120044'), c('69120055', { adValorem: null }), c('69120066', { description: 'Other > Other' })],
      [],
      { size: 10, maxPerChapter: 10 },
    )
    expect(out.map((x) => x.code)).toEqual(['69120044'])
  })

  it('관측된 코드가 먼저다 — 프로그램 세율이 낮아도', () => {
    const out = selectWave([c('69120044', { programRate: 0.25 }), c('71131900', { programRate: 0.075 })], ['711319'], {
      size: 2,
      maxPerChapter: 10,
    })
    expect(out[0].code).toBe('71131900')
  })

  it('시드가 없으면 프로그램 세율이 두꺼운 순이다', () => {
    const out = selectWave([c('69120044', { programRate: 0.075 }), c('84011000', { programRate: 0.25 })], [], {
      size: 2,
      maxPerChapter: 10,
    })
    expect(out[0].code).toBe('84011000')
  })

  it('한 장이 웨이브를 쓸어가지 못한다', () => {
    // 표본이 한 장에 몰리면 색인률이 카탈로그에 대해 말해주는 게 없다
    const many = Array.from({ length: 30 }, (_, i) => c('3921' + String(i).padStart(4, '0')))
    const other = [c('69120044'), c('84011000')]
    const out = selectWave([...many, ...other], [], { size: 10, maxPerChapter: 3 })
    expect(chapterSpread(out).get('39')).toBe(3)
    expect(out).toHaveLength(5) // 39 에서 3 + 69·84 에서 각 1
  })

  it('요청한 크기를 넘지 않는다', () => {
    const pool = Array.from({ length: 50 }, (_, i) => c(String(10000000 + i)))
    expect(selectWave(pool, [], { size: 20, maxPerChapter: 50 })).toHaveLength(20)
  })

  it('같은 입력이면 같은 목록이 나온다', () => {
    const pool = [c('84011000'), c('69120044'), c('71131900')]
    const opts = { size: 3, maxPerChapter: 10 }
    expect(selectWave(pool, [], opts).map((x) => x.code)).toEqual(selectWave([...pool].reverse(), [], opts).map((x) => x.code))
  })
})
