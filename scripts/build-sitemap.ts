/**
 * robots.txt · 사이트맵 생성 (docs/seo-indexing-policy.md §6).
 *
 *   npm run sitemap:build    public/robots.txt · public/sitemap.xml · public/sitemaps/pages.xml
 *   npm run sitemap:verify   재생성 결과가 커밋본과 같은지 (CI 가 대조한다)
 *
 * ── URL 을 손으로 나열하지 않는다 ────────────────────────────────
 * 각 페이지의 canonical 을 읽어 그대로 쓴다. 손으로 관리하면 canonical 과
 * 갈라지고, 그 둘이 다르면 크롤러에게 서로 다른 정본을 말하는 것이라 색인을
 * 도우려다 방해하게 된다.
 *
 * canonical 이 없는 화면(`/app`)은 자동으로 빠진다 — 제외 목록을 따로 관리할
 * 필요가 없다. 목록의 진실 출처는 페이지 자신이다.
 *
 * ── public/ 에 쓰는 이유 ─────────────────────────────────────────
 * Vite 가 그대로 복사하는 자리라 robots.txt · sitemap.xml 이 루트 경로로 나간다.
 * %VITE_*% 치환이 없는 자리지만 이 파일들에는 치환할 것이 없다.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { canonicalOf, isNoindex, robotsTxt, sitemapIndexXml, urlsetXml, type SitemapEntry } from './lib/sitemap'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ORIGIN = 'https://www.landediq.app'
const PUBLIC = join(root, 'public')
const SITEMAP_DIR = join(PUBLIC, 'sitemaps')

/** 발행 날짜를 아는 것은 글뿐이다. 나머지는 lastmod 를 넣지 않는다 — 틀린 값보다 없는 게 낫다. */
function blogDates(): Map<string, string> {
  const dir = join(root, 'content/blog')
  const out = new Map<string, string>()
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    const m = readFileSync(join(dir, f), 'utf-8').match(/^---\n([\s\S]*?)\n---/)
    if (!m) continue
    try {
      const meta = JSON.parse(m[1]) as { slug?: string; date?: string }
      if (meta.slug && meta.date) out.set(`${ORIGIN}/blog/${meta.slug}`, meta.date)
    } catch {
      // front matter 오류는 blog:build 가 잡는다. 여기서 두 번 말하지 않는다
    }
  }
  return out
}

/** 사이트맵 후보 HTML. app/ 은 빼지 않는다 — canonical 이 없어 알아서 빠진다. */
function candidateFiles(): string[] {
  const files = readdirSync(root).filter((f) => f.endsWith('.html'))
  const blogDir = join(root, 'blog')
  if (existsSync(blogDir)) {
    for (const f of readdirSync(blogDir).filter((x) => x.endsWith('.html'))) files.push(`blog/${f}`)
  }
  files.push('app/index.html')
  return files
}

function main() {
  const dates = blogDates()
  const entries: SitemapEntry[] = []
  const skipped: string[] = []

  for (const rel of candidateFiles()) {
    const path = join(root, rel)
    if (!existsSync(path)) continue
    const html = readFileSync(path, 'utf-8')
    const loc = canonicalOf(html)
    if (!loc) { skipped.push(`${rel} (canonical 없음)`); continue }
    if (isNoindex(html)) { skipped.push(`${rel} (noindex)`); continue }
    const lastmod = dates.get(loc)
    entries.push(lastmod ? { loc, lastmod } : { loc })
  }

  mkdirSync(SITEMAP_DIR, { recursive: true })
  writeFileSync(join(SITEMAP_DIR, 'pages.xml'), urlsetXml(entries), 'utf-8')

  // 코드 페이지는 장(chapter) 별로 쪼갠다 (§6). 크기 때문이 아니라 진단 가능성
  // 때문이다 — 한 덩어리면 Search Console 에서 색인률이 전체 평균으로만 보이고,
  // 어느 영역이 실패하는지 알 수 없다. 그 신호가 웨이브 게이트의 입력이다.
  const wave = join(root, 'data/wave1.json')
  let codePages = 0
  if (existsSync(wave)) {
    const byChapter = new Map<string, SitemapEntry[]>()
    for (const c of (JSON.parse(readFileSync(wave, 'utf-8')) as { codes: Array<{ code: string }> }).codes) {
      const ch = c.code.slice(0, 2)
      byChapter.set(ch, [...(byChapter.get(ch) ?? []), { loc: `${ORIGIN}/hts/${c.code}` }])
    }
    for (const [ch, list] of byChapter) {
      writeFileSync(join(SITEMAP_DIR, `hts-ch${ch}.xml`), urlsetXml(list), 'utf-8')
      codePages += list.length
    }
  }

  // 인덱스는 디렉터리를 그대로 읽는다 — 코드 페이지 장별 사이트맵이 생기면
  // 이 파일을 고치지 않아도 자동으로 들어온다 (§6)
  const maps = readdirSync(SITEMAP_DIR).filter((f) => f.endsWith('.xml')).map((f) => `/sitemaps/${f}`)
  writeFileSync(join(PUBLIC, 'sitemap.xml'), sitemapIndexXml(maps, ORIGIN), 'utf-8')
  writeFileSync(join(PUBLIC, 'robots.txt'), robotsTxt(ORIGIN), 'utf-8')

  console.log('── 사이트맵 생성 ──────────────────────────────')
  console.log(`  등록 ${entries.length}건`)
  for (const e of [...entries].sort((a, b) => a.loc.localeCompare(b.loc))) {
    console.log(`    ${e.loc}${e.lastmod ? `  (${e.lastmod})` : ''}`)
  }
  if (skipped.length > 0) console.log(`  제외 ${skipped.length}건: ${skipped.join(', ')}`)
  console.log(codePages > 0 ? `  코드 페이지 ${codePages}장 (장별 분할)` : '  코드 페이지 없음 — 웨이브 미발행')
  console.log(`  인덱스 ${maps.length}개: ${maps.join(', ')}`)
  console.log('→ public/robots.txt · public/sitemap.xml · public/sitemaps/pages.xml — 커밋할 것')
}

main()
