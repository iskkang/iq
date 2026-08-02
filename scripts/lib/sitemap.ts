/**
 * 사이트맵 XML 조립 (docs/seo-indexing-policy.md §6).
 *
 * ── 설계 결정: URL 을 손으로 나열하지 않는다 ─────────────────────
 * 사이트맵을 손으로 관리하면 canonical 과 갈라진다. 그 둘이 다르면 크롤러에게
 * 서로 다른 정본을 말하는 것이고, 그건 색인을 도우려다 방해하는 상태다.
 *
 * 그래서 각 페이지의 `<link rel="canonical">` 을 그대로 읽어 쓴다. 목록의 진실
 * 출처는 페이지 자신이다 — 페이지가 없으면 URL 도 없고, canonical 이 바뀌면
 * 사이트맵도 따라간다. 손으로 적을 자리가 없으면 갈라질 수 없다.
 *
 * 슬래시 하나까지 canonical 그대로 쓴다. `/` 와 `/index` 처럼 표기가 다르면
 * 그 자체가 중복 신호가 된다.
 */

const XML: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
export const escXml = (s: string) => s.replace(/[&<>"']/g, (c) => XML[c])

export interface SitemapEntry {
  loc: string
  /** YYYY-MM-DD. 믿을 수 없는 값이면 넣지 않는다 — 틀린 lastmod 는 무시당하는 게 아니라 신뢰를 깎는다 */
  lastmod?: string
}

function assertEntries(entries: readonly SitemapEntry[]): void {
  if (entries.length === 0) throw new Error('사이트맵이 비어 있다 — 빈 사이트맵을 내보내지 않는다')
  const seen = new Set<string>()
  for (const e of entries) {
    if (!/^https:\/\/[^\s<>"]+$/.test(e.loc)) throw new Error(`사이트맵 loc 은 절대 https URL 이어야 한다: ${e.loc}`)
    if (e.lastmod !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(e.lastmod)) {
      throw new Error(`lastmod 는 YYYY-MM-DD 여야 한다: ${e.lastmod}`)
    }
    if (seen.has(e.loc)) throw new Error(`사이트맵에 중복 URL 이 있다: ${e.loc}`)
    seen.add(e.loc)
  }
}

/** urlset. 순서는 loc 오름차순 — 같은 입력이면 같은 파일이 나와야 diff 가 의미를 갖는다 */
export function urlsetXml(entries: readonly SitemapEntry[]): string {
  assertEntries(entries)
  const body = [...entries]
    .sort((a, b) => a.loc.localeCompare(b.loc))
    .map((e) => `  <url><loc>${escXml(e.loc)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ''}</url>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`
}

/**
 * 사이트맵 인덱스.
 *
 * 지금은 페이지 하나뿐이지만 인덱스로 시작한다 — 코드 페이지가 장별로 붙을 때
 * (§6) 최상위 URL 을 바꾸지 않아도 되기 때문이다. robots.txt 와 Search Console 에
 * 등록된 주소가 바뀌면 그때부터 등록을 다시 해야 하고, 그 절차는 잊힌다.
 */
export function sitemapIndexXml(paths: readonly string[], origin: string): string {
  if (paths.length === 0) throw new Error('사이트맵 인덱스가 비어 있다')
  const body = [...paths]
    .sort()
    .map((p) => `  <sitemap><loc>${escXml(origin + p)}</loc></sitemap>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`
}

/**
 * HTML 에서 canonical 을 뽑는다. 없으면 null — **사이트맵에 넣지 않는다는 뜻이다.**
 * `/app` 처럼 색인 대상이 아닌 화면은 canonical 이 없고, 그게 곧 제외 신호가 된다.
 */
export function canonicalOf(html: string): string | null {
  const m = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i)
  return m ? m[1] : null
}

/** 정적 마크업에 noindex 가 박혀 있으면 제외한다 (JS 로 주입하는 폴백은 여기 해당하지 않는다) */
export function isNoindex(html: string): boolean {
  return /<meta\s+name="robots"\s+content="[^"]*noindex/i.test(html)
}

export function robotsTxt(origin: string): string {
  return [
    '# 색인 정책: docs/seo-indexing-policy.md',
    'User-agent: *',
    'Allow: /',
    '',
    '# 로그인 뒤 워크스페이스. 공개 콘텐츠가 없고 canonical 도 없다.',
    'Disallow: /app',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n')
}
