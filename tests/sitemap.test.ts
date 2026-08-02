/**
 * 사이트맵 테스트.
 *
 * ── 왜 있는가 ────────────────────────────────────────────────────
 * 사이트맵의 실패는 조용하다. 잘못된 URL 이나 중복이 들어가도 파일은 만들어지고
 * 배포되며, 크롤러가 무시하기 시작한 걸 알아채는 데 몇 주가 걸린다. 그때는
 * "왜 색인이 안 되지" 를 엉뚱한 데서 찾게 된다.
 *
 * 특히 canonical 과 어긋나는 URL 은 색인을 도우려다 방해하는 상태다 — 크롤러에게
 * 서로 다른 정본을 말하는 것이다. 그래서 목록을 손으로 적지 않고 canonical 에서
 * 뽑는데, 그 추출과 조립을 여기서 못박는다.
 */
import { describe, it, expect } from 'vitest'
import { urlsetXml, sitemapIndexXml, canonicalOf, isNoindex, escXml, robotsTxt } from '../scripts/lib/sitemap'

const ORIGIN = 'https://www.landediq.app'

describe('urlset', () => {
  it('loc 오름차순으로 낸다 — 같은 입력이면 같은 파일이어야 diff 가 의미를 갖는다', () => {
    const xml = urlsetXml([{ loc: `${ORIGIN}/hts` }, { loc: `${ORIGIN}/about` }])
    expect(xml.indexOf('/about')).toBeLessThan(xml.indexOf('/hts'))
  })

  it('lastmod 는 있을 때만 넣는다', () => {
    expect(urlsetXml([{ loc: `${ORIGIN}/blog/x`, lastmod: '2026-08-02' }])).toContain('<lastmod>2026-08-02</lastmod>')
    expect(urlsetXml([{ loc: `${ORIGIN}/about` }])).not.toContain('lastmod')
  })

  it('빈 사이트맵은 내보내지 않는다', () => {
    expect(() => urlsetXml([])).toThrow(/비어 있다/)
  })

  it('중복 URL 을 거부한다', () => {
    expect(() => urlsetXml([{ loc: `${ORIGIN}/a` }, { loc: `${ORIGIN}/a` }])).toThrow(/중복/)
  })

  it('상대 경로와 http 를 거부한다', () => {
    expect(() => urlsetXml([{ loc: '/hts' }])).toThrow(/절대 https/)
    expect(() => urlsetXml([{ loc: 'http://www.landediq.app/hts' }])).toThrow(/절대 https/)
  })

  it('형식이 틀린 lastmod 를 거부한다 — 틀린 값은 신뢰를 깎는다', () => {
    expect(() => urlsetXml([{ loc: `${ORIGIN}/a`, lastmod: '2026-8-2' }])).toThrow(/lastmod/)
  })

  it('XML 특수문자를 escape 한다', () => {
    expect(escXml('a&b<c>')).toBe('a&amp;b&lt;c&gt;')
  })
})

describe('사이트맵 인덱스', () => {
  it('경로를 origin 에 붙여 절대 URL 로 만든다', () => {
    const xml = sitemapIndexXml(['/sitemaps/pages.xml'], ORIGIN)
    expect(xml).toContain(`<loc>${ORIGIN}/sitemaps/pages.xml</loc>`)
    expect(xml).toContain('<sitemapindex')
  })

  it('장별 사이트맵이 붙어도 정렬돼 들어간다', () => {
    // 코드 페이지가 나가면 여기 hts-ch{NN} 이 늘어난다 (§6)
    const xml = sitemapIndexXml(['/sitemaps/hts-ch69.xml', '/sitemaps/pages.xml', '/sitemaps/hts-ch39.xml'], ORIGIN)
    expect(xml.indexOf('ch39')).toBeLessThan(xml.indexOf('ch69'))
  })
})

describe('페이지에서 뽑아내기', () => {
  it('canonical 을 슬래시까지 그대로 읽는다', () => {
    expect(canonicalOf('<link rel="canonical" href="https://www.landediq.app/" />')).toBe('https://www.landediq.app/')
  })

  it('canonical 이 없으면 null — 사이트맵에 넣지 않는다는 뜻이다', () => {
    // /app 이 이 경우다. 제외 목록을 손으로 관리하지 않아도 된다
    expect(canonicalOf('<html><head><title>app</title></head>')).toBeNull()
  })

  it('정적 noindex 는 제외 신호다', () => {
    expect(isNoindex('<meta name="robots" content="noindex,follow" />')).toBe(true)
    expect(isNoindex('<meta name="description" content="x" />')).toBe(false)
  })
})

describe('robots.txt', () => {
  it('사이트맵 인덱스를 가리키고 /app 을 막는다', () => {
    const txt = robotsTxt(ORIGIN)
    expect(txt).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`)
    expect(txt).toContain('Disallow: /app')
  })
})
