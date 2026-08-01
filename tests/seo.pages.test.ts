/**
 * HTS 코드 페이지 색인 정책 테스트.
 *
 * ── 왜 있는가 ────────────────────────────────────────────────────
 * 이 정책의 실패 모드는 조용하다. 게이트가 느슨해져도 빌드는 통과하고 배포도
 * 되며, 몇 주 뒤 Search Console 에 "Crawled – currently not indexed" 가
 * 쌓이고 나서야 보인다. 그때는 이미 수천 장이 발행돼 있고, 색인 제거는 발행
 * 보다 느리다.
 *
 * 그래서 정책의 경계값을 여기 고정한다. 게이트를 바꾸려면 이 테스트를 같이
 * 고쳐야 하고, 그 diff 가 리뷰에서 보인다.
 *
 * 정책 전문: docs/seo-indexing-policy.md
 */
import { describe, it, expect } from 'vitest'
import {
  decidePage,
  dotted,
  pagePath,
  canonicalUrl,
  parentPageCode,
  chapterOf,
  sitemapFor,
  pageTitle,
  pageDescription,
  meaningfulDescription,
  MAX_TITLE,
  MAX_META_DESCRIPTION,
  TIER_A_DEMAND_RANK,
  type PageInput,
} from '../src/lib/seo/pages'

/** 실재하는 라인 — 세라믹 머그, 중국 301 List 3 (`/hts` 실측 22.5%) */
const MUG: PageInput = {
  code: '69120044',
  description: 'Ceramic tableware, kitchenware > Other than of porcelain or china > Mugs and other steins',
  adValorem: 0.098,
  programs: ['301-list3'],
  demandRank: null,
}

describe('게이트 — 색인 자격', () => {
  it('세율·설명이 있는 8자리는 색인한다', () => {
    const d = decidePage(MUG)
    expect(d.indexable).toBe(true)
    expect(d.blockers).toEqual([])
  })

  it('종가세로 해석되지 않는 라인은 색인하지 않는다', () => {
    // 종량세·복합세 라인은 화면에 "unresolved" 밖에 못 띄운다. 세율을 묻는
    // 검색어로 들어온 사람에게 세율이 없는 페이지를 주는 것이다.
    const d = decidePage({ ...MUG, adValorem: null })
    expect(d.indexable).toBe(false)
    expect(d.tier).toBe('D')
    expect(d.blockers).toContain('rate-unresolved')
  })

  it('"Other" 만 남는 설명은 색인하지 않는다', () => {
    const d = decidePage({ ...MUG, description: 'Other > Other' })
    expect(d.indexable).toBe(false)
    expect(d.blockers).toContain('description-too-thin')
  })

  it('10자리 코드는 페이지 단위가 아니다', () => {
    // 8자리 자식들은 세율이 같다 — 각각 내면 near-duplicate 를 스스로 찍는 것이다
    const d = decidePage({ ...MUG, code: '6912004810' })
    expect(d.indexable).toBe(false)
    expect(d.blockers).toContain('code-not-8-digit')
  })

  it('막힌 사유는 전부 모아서 돌려준다', () => {
    // 하나만 고치고 통과했다고 오해하지 않도록
    const d = decidePage({ code: '6912', description: 'Other', adValorem: null, programs: [], demandRank: null })
    expect(d.blockers).toHaveLength(3)
  })
})

describe('Tier — 발행 순서', () => {
  it('실측 수요 상위는 A', () => {
    expect(decidePage({ ...MUG, demandRank: 1 }).tier).toBe('A')
    expect(decidePage({ ...MUG, demandRank: TIER_A_DEMAND_RANK }).tier).toBe('A')
  })

  it('수요 순위가 경계를 넘으면 A 가 아니다', () => {
    expect(decidePage({ ...MUG, demandRank: TIER_A_DEMAND_RANK + 1 }).tier).not.toBe('A')
  })

  it('수요 데이터가 없어도 프로그램이 붙으면 B', () => {
    expect(decidePage(MUG).tier).toBe('B')
  })

  it('MFN 뿐이면 C', () => {
    expect(decidePage({ ...MUG, programs: [] }).tier).toBe('C')
  })

  it('색인 불가는 Tier 로 승격되지 않는다', () => {
    // 수요가 아무리 높아도 답할 수 없는 페이지는 내지 않는다
    expect(decidePage({ ...MUG, adValorem: null, demandRank: 1 }).tier).toBe('D')
  })
})

describe('URL — 표기는 하나만', () => {
  it('경로는 숫자만 쓴다', () => {
    // hts.html 의 기존 딥링크가 숫자 형태다. 표기가 둘이면 같은 페이지가 두 URL 로 갈린다
    expect(pagePath('6912.00.44')).toBe('/hts/69120044')
    expect(pagePath('69120044')).toBe('/hts/69120044')
  })

  it('canonical 은 절대 URL 이다', () => {
    expect(canonicalUrl('69120044')).toBe('https://www.landediq.app/hts/69120044')
  })

  it('10자리는 부모 8자리로 접는다', () => {
    expect(parentPageCode('6912004410')).toBe('69120044')
  })

  it('8자리는 자기가 페이지라 부모가 없다', () => {
    expect(parentPageCode('69120044')).toBeNull()
  })

  it('표시 표기는 점을 넣는다', () => {
    expect(dotted('69120044')).toBe('6912.00.44')
    expect(dotted('6912004410')).toBe('6912.00.44.10')
  })
})

describe('사이트맵 분할', () => {
  it('장 단위로 나눈다', () => {
    expect(chapterOf('69120044')).toBe('69')
    expect(sitemapFor('69120044')).toBe('/sitemaps/hts-ch69.xml')
  })

  it('같은 장은 같은 사이트맵에 모인다', () => {
    expect(sitemapFor('69120044')).toBe(sitemapFor('69111000'))
  })
})

describe('메타 — 잘리지 않고, 지어내지 않는다', () => {
  it('제목은 검색 결과에서 잘리는 길이를 넘지 않는다', () => {
    expect(pageTitle(MUG).length).toBeLessThanOrEqual(MAX_TITLE)
  })

  it('설명이 길어도 제목은 단어 중간에서 끊지 않는다', () => {
    const long = pageTitle({ ...MUG, description: 'A '.repeat(80) + 'ceramic drinking vessels of stoneware' })
    expect(long.length).toBeLessThanOrEqual(MAX_TITLE)
    expect(long.endsWith(' | LandedIQ')).toBe(true)
  })

  it('제목에 코드가 들어간다 — 사람들은 코드로 검색한다', () => {
    // 광고 검색어 리포트의 "711319 hs code" 가 근거다
    expect(pageTitle(MUG)).toContain('6912.00.44')
  })

  it('meta description 은 상한을 지킨다', () => {
    expect(pageDescription(MUG).length).toBeLessThanOrEqual(MAX_META_DESCRIPTION)
  })

  it('meta description 은 원장 값만으로 조립된다', () => {
    const text = pageDescription(MUG)
    expect(text).toContain('9.8% MFN')
    expect(text).toContain('301-list3')
  })

  it('세율이 없으면 있는 척하지 않는다', () => {
    expect(pageDescription({ ...MUG, adValorem: null })).toContain('unresolved')
  })
})

describe('설명 정규화', () => {
  it('일반어 마디를 걷어낸다', () => {
    expect(meaningfulDescription('Other > Mugs and other steins')).toBe('Mugs and other steins')
  })

  it('전부 일반어면 빈 문자열이다', () => {
    expect(meaningfulDescription('Other > Others > NESOI')).toBe('')
  })
})
