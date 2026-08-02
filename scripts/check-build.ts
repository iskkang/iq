/**
 * 빌드 산출물 검사 — 조용히 깨진 채로 배포되는 걸 막는다.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DISCLAIMER_EN } from '../src/lib/disclaimer'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail: string[] = []

function read(rel: string): string | null {
  const p = join(root, rel)
  return existsSync(p) ? readFileSync(p, 'utf-8') : null
}

const HTML_FILES = [
  'dist/index.html',
  'dist/privacy.html',
  'dist/about.html',
  'dist/methodology.html',
  'dist/terms.html',
  'dist/app/index.html',
  'dist/sample-report.html',
  'dist/hts.html',
  'dist/section-301.html',
]

// 공개 링크가 있는데 빌드 입력에서 빠지는 회귀를 즉시 실패시킨다.
for (const f of HTML_FILES) {
  const html = read(f)
  if (html === null) {
    fail.push(`${f}: 필수 빌드 산출물이 없다 — vite.config.ts input 확인`)
    continue
  }
  const leftover = [...html.matchAll(/%VITE_[A-Z0-9_]+%/g)].map((m) => m[0])
  if (leftover.length > 0) fail.push(`${f}: Vite env 치환 누락 — ${[...new Set(leftover)].join(', ')}`)
}

const ADS_ID = 'AW-18359222502'
const ADS_LOADER = /googletagmanager\.com\/gtag\/js\?id=AW-18359222502/g
const ADS_CONFIG = new RegExp(`gtag\\(\\s*['"]config['"]\\s*,\\s*['"]${ADS_ID}['"]\\s*\\)`)

for (const f of HTML_FILES) {
  const html = read(f)
  if (html === null) continue
  const n = [...html.matchAll(ADS_LOADER)].length
  if (n !== 1) fail.push(`${f}: gtag 로더가 ${n}회 — 정확히 1회여야 한다`)
  if (!ADS_CONFIG.test(html)) fail.push(`${f}: gtag config 에 전환 ID ${ADS_ID} 가 없다`)
}

const ads = read('dist/ads.js')
if (ads === null) {
  fail.push('dist/ads.js 가 없다 — 전환 보고가 통째로 빠진다 (public/ads.js 확인)')
} else {
  if (!ads.includes(ADS_ID)) fail.push(`dist/ads.js: 전환 ID ${ADS_ID} 가 없다`)
  for (const k of ['signup', 'sample']) {
    if (!new RegExp(`${k}:\\s*(SIGNUP|'[A-Za-z0-9_-]+')`).test(ads)) fail.push(`dist/ads.js: ${k} 전환 라벨이 비어 있다 — 그 전환은 기록되지 않는다`)
  }
  if (/send_to:\s*[^,]*\?\s*ID/.test(ads) || /send_to:\s*ID\s*[,}]/.test(ads)) fail.push('dist/ads.js: 라벨 없이 ID 만 보내는 경로가 있다 — 전환이 기록되지 않는다')
}

for (const f of ['dist/index.html', 'dist/sample-report.html', 'dist/hts.html', 'dist/section-301.html']) {
  const html = read(f)
  if (html !== null && !html.includes('/ads.js')) fail.push(`${f}: /ads.js 를 불러오지 않는다 — 전환이 기록되지 않는다`)
}

const PLACEHOLDERS = ['YOUR_FORMSPREE_ID', 'YOUR_DOMAIN.com', 'YOUR_PROJECT', '<project-ref>', '[서울 주소']
const STALE = [
  'iq-rose.vercel.app',
  'metalogislab@gmail.com',
  '471 Gonghang-daero',
  'Get early access',
  'Join $19 Beta List',
  '$19 Beta',
  '$29/mo',
  '$79/mo',
  '$149/mo',
  "We'll email you when your workspace is ready",
]
const PUBLIC_HTML = [
  'dist/index.html',
  'dist/privacy.html',
  'dist/about.html',
  'dist/methodology.html',
  'dist/terms.html',
  'dist/sample-report.html',
  'dist/hts.html',
  'dist/section-301.html',
]

// 폐기한 구가격·구CTA·상세 주소가 정적 공개 페이지에 다시 나타나면 배포를 막는다.
for (const f of PUBLIC_HTML) {
  const html = read(f)
  if (html === null) continue
  for (const ph of PLACEHOLDERS) if (html.includes(ph)) fail.push(`${f}: 치환되지 않은 플레이스홀더 "${ph}"`)
  for (const st of STALE) if (html.includes(st)) fail.push(`${f}: 폐기한 가격/CTA/주소 문구 "${st}" 가 남아 있다`)
}

/**
 * ── head 의 태그가 실제로 닫혔는가 · 공유 카드가 있는가 ──────────────
 * 이 가드는 실제 사고에서 나왔다. og 태그를 canonical 뒤에 끼워 넣는 스크립트가
 * `<link rel="canonical" href="…"` 까지만 매칭해서, 닫는 ` />` 앞에 태그를
 * 밀어 넣었다. 결과는 9 개 페이지 전부에서 canonical 이 닫히지 않고 본문 맨 위에
 * `/>` 가 글자로 찍히는 것이었다 — canonical 이 깨지면 색인이 통째로 어긋난다.
 *
 * 무서운 건 **아무것도 못 잡았다는 것**이다. 빌드 검사·252 개 테스트·브라우저
 * 퍼널 스모크가 전부 통과했다. 브라우저는 깨진 HTML 을 복구해서 렌더하므로
 * 스모크는 이벤트만 보고 넘어간다. 눈으로 스크린샷을 보고서야 발견했다.
 *
 * og:image 도 같이 본다. 없으면 링크를 붙였을 때 이미지 없는 맨 텍스트 카드가
 * 뜨고, 그건 조용히 "실체 없는 사이트" 로 읽힌다 — 역시 아무 검사도 안 하던 곳이다.
 */
for (const f of [...PUBLIC_HTML, 'dist/blog.html']) {
  const html = read(f)
  if (html === null) continue
  const head = html.slice(0, html.indexOf('</head>'))

  // 여는 꺾쇠 뒤에 닫는 꺾쇠보다 다음 여는 꺾쇠가 먼저 오면 그 태그는 닫히지 않았다.
  const unclosed = /<(link|meta)\b[^>]*$/m.test(head.replace(/>[^<]*/g, '>'))
  if (unclosed) fail.push(`${f}: head 안에 닫히지 않은 link/meta 태그가 있다`)

  const canonical = head.match(/<link rel="canonical"[^>]*>/)
  if (!canonical) fail.push(`${f}: canonical 링크가 없다`)
  else if (!canonical[0].trimEnd().endsWith('/>')) fail.push(`${f}: canonical 링크가 닫히지 않았다`)

  if (!/<meta property="og:image" content="https:\/\/[^"]+"/.test(head)) {
    fail.push(`${f}: og:image 가 없다 — 링크 공유 시 이미지 없는 카드가 뜬다`)
  }
}

const appHtml = read('dist/app/index.html')
if (appHtml !== null) {
  const m = appHtml.match(/\/assets\/[A-Za-z0-9._-]+\.js/)
  const bundle = m ? read('dist' + m[0]) : null
  if (bundle === null) fail.push('dist/app: 번들을 찾지 못했다')
  else if (!/https:\/\/[a-z0-9]+\.supabase\.(co|in|red)/.test(bundle)) fail.push('dist/app 번들에 Supabase URL 이 없다 — VITE_SUPABASE_URL 미주입 (프로덕션이 데모로 떨어진다)')
}

const landing = read('dist/index.html')
if (landing !== null) {
  for (const w of ['demo mode', 'browser memory', 'DEMO MODE']) if (landing.includes(w)) fail.push(`dist/index.html: 사용자 노출 문구 "${w}"`)
  // 랜딩 샘플 카드는 엔진이 채운다. 마커가 사라지면 sample:verify 가 죽는데,
  // 실제로 랜딩 재설계 때 사라진 채 8 커밋을 갔다 — 그동안 표는 손으로 관리됐고
  // 요약 타일 두 개가 어긋나 있었다. 마커 자체를 빌드에서 지킨다.
  for (const m of ['SAMPLE_ROWS:START', 'SAMPLE_ROWS:END', 'SAMPLE_TILES:START', 'SAMPLE_TILES:END']) {
    if (!landing.includes(m)) fail.push(`dist/index.html: ${m} 마커가 없다 — 샘플 카드가 엔진과 끊긴다`)
  }
}

// /hts 하위 경로는 폴백이라 색인 대상이 아니다. 이 가드가 빠지면 고정 canonical 이
// 다시 모든 코드 경로를 /hts 로 합친다 (docs/seo-indexing-policy.md §6).
const htsPage = read('dist/hts.html')
if (htsPage !== null && !/noindex,follow/.test(htsPage)) {
  fail.push('dist/hts.html: 하위 경로 noindex 가드가 없다 — 코드 경로가 /hts 로 합쳐진다')
}

// 샘플 리포트는 §1-2 estimates-only 고지를 그대로 실어야 한다. 재설계 과정에서
// 이 블록이 통째로 빠지고 푸터 축약본만 남은 적이 있다 — 축약본은 "세액은 원장
// 스냅샷 기준 추정" 을 말하지 않아 같은 고지가 아니다.
const report = read('dist/sample-report.html')
if (report !== null && !report.includes(DISCLAIMER_EN)) {
  fail.push('dist/sample-report.html: §1-2 estimates-only 고지가 없다 (src/lib/disclaimer.ts 단일 소스)')
}

// 광고 트래픽이 떨어지는 페이지는 퍼널을 계측해야 한다. 이게 없으면 광고
// 리포트의 "전환 0" 이 어디서 죽었는지 영원히 알 수 없다 — 실제로 63 클릭
// ₩134,729 을 그 상태로 썼다. 계측이 빠져도 페이지는 멀쩡히 동작하므로
// 사람이 알아챌 방법이 없다. 빌드에서 막는다.
const FUNNEL_PAGES: Array<[string, string[]]> = [
  ['dist/index.html', ['signup_submitted', 'signup_saved', 'signup_failed']],
  ['dist/hts.html', ['hts_lookup_submitted', 'hts_lookup_results', 'watch_submitted', 'watch_saved', 'watch_failed']],
  ['dist/section-301.html', ['section301_lookup_submitted', 'section301_watch_submitted', 'section301_watch_failed']],
]
for (const [file, events] of FUNNEL_PAGES) {
  const html = read(file)
  if (html === null) continue
  if (!html.includes('/analytics.js')) fail.push(`${file}: /analytics.js 를 불러오지 않는다 — 퍼널이 측정되지 않는다`)
  for (const e of events) if (!html.includes(e)) fail.push(`${file}: 퍼널 이벤트 ${e} 가 없다`)
}

// analytics.js 는 호출 시점에 window.CONFIG 를 읽는다. 페이지가 `const CONFIG` 로
// 선언하면 렉시컬 바인딩이라 window 에 붙지 않아 계측이 조용히 죽는다.
for (const f of ['dist/index.html', 'dist/hts.html', 'dist/section-301.html', 'dist/sample-report.html']) {
  const html = read(f)
  if (html !== null && /(const|let)\s+CONFIG\s*=/.test(html)) {
    fail.push(`${f}: CONFIG 가 const/let 이다 — window.CONFIG 가 없어 계측이 죽는다 (var 로 둘 것)`)
  }
}

// 에디토리얼은 사실 층과 의견 층을 분리한다 (docs/seo-indexing-policy.md §8).
// 그 분리는 화면에 배지로 보여야 의미가 있다 — 독자가 어디까지가 데이터이고
// 어디부터가 우리 베팅인지 구분할 수 있어야 한다. 템플릿을 고치다 배지가 빠지면
// 글은 멀쩡히 나가고 구분만 사라진다. 조용한 실패라 빌드에서 막는다.
const blogDir = join(root, 'dist/blog')
if (existsSync(join(root, 'dist/blog.html'))) {
  const posts = existsSync(blogDir) ? readdirSync(blogDir).filter((f) => f.endsWith('.html')) : []
  if (posts.length === 0) fail.push('dist/blog.html 은 있는데 발행된 글이 없다')
  for (const f of posts) {
    const html = read(`dist/blog/${f}`)
    if (html === null) continue
    for (const [needle, why] of [
      ['badge fact', '사실 층 배지가 없다'],
      ['badge opinion', '의견 층 배지가 없다 — 추측이 사실처럼 읽힌다'],
      ['id="cform"', '댓글 폼이 없다 — 답글을 보려고 만든 글이다'],
      ['rel="canonical"', 'canonical 이 없다'],
      ['/analytics.js', '퍼널 계측을 불러오지 않는다'],
      ['<figure class="fig"', '본문 그림이 없다 — 표만으로는 코드별 격차가 훑어야 보인다'],
      ['role="img"', '그림에 접근성 라벨이 없다'],
    ] as const) {
      if (!html.includes(needle)) fail.push(`dist/blog/${f}: ${why}`)
    }
    if (!/href="\/hts\/\d{8}"/.test(html)) fail.push(`dist/blog/${f}: 코드 페이지 내부 링크가 없다 (정책 §8)`)
  }
}

// robots.txt · 사이트맵이 빠지면 색인이 느려지는 게 아니라 시작을 안 한다.
// public/ 은 Vite 가 복사만 하므로 파일이 없어도 빌드는 조용히 성공한다.
const robots = read('dist/robots.txt')
if (robots === null) fail.push('dist/robots.txt 가 없다 (npm run sitemap:build)')
else if (!robots.includes('Sitemap: https://www.landediq.app/sitemap.xml')) {
  fail.push('dist/robots.txt: 사이트맵 인덱스를 가리키지 않는다')
}

const sitemapIndex = read('dist/sitemap.xml')
const pagesMap = read('dist/sitemaps/pages.xml')
if (sitemapIndex === null) fail.push('dist/sitemap.xml 이 없다 (npm run sitemap:build)')
if (pagesMap === null) fail.push('dist/sitemaps/pages.xml 이 없다 (npm run sitemap:build)')
else {
  // 사이트맵은 canonical 에서 뽑는다. 손으로 관리하지 않는다는 규칙이 지켜지는지
  // 확인하는 대신, 결과가 canonical 과 일치하는지를 본다.
  for (const [f, loc] of [
    ['dist/index.html', 'https://www.landediq.app/'],
    ['dist/hts.html', 'https://www.landediq.app/hts'],
    ['dist/blog.html', 'https://www.landediq.app/blog'],
  ] as const) {
    if (read(f) !== null && !pagesMap.includes(`<loc>${loc}</loc>`)) {
      fail.push(`dist/sitemaps/pages.xml: ${loc} 가 빠졌다 — canonical 과 사이트맵이 갈라졌다`)
    }
  }
  // 색인 대상이 아닌 화면이 들어가면 크롤 예산을 거기 쓴다
  if (pagesMap.includes('landediq.app/app')) fail.push('dist/sitemaps/pages.xml: /app 이 들어 있다 — 색인 대상이 아니다')
  if (existsSync(join(root, 'dist/blog')) && !/\/blog\/[a-z0-9-]+<\/loc>/.test(pagesMap)) {
    fail.push('dist/sitemaps/pages.xml: 발행된 글이 하나도 없다')
  }
}

// 웨이브 파일은 "무엇을 발행하기로 했는가" 이고 dist/hts 는 "무엇이 발행됐는가" 다.
// 둘이 어긋나면 사이트맵에는 있는데 페이지는 없는(또는 그 반대) 상태가 배포된다 —
// 크롤러에게 404 를 주는 URL 을 우리가 직접 제출하는 꼴이다.
const waveFile = join(root, 'data/wave1.json')
if (existsSync(waveFile)) {
  const wave = JSON.parse(readFileSync(waveFile, 'utf-8')) as { codes: Array<{ code: string }> }
  const dir = join(root, 'dist/hts')
  const built = existsSync(dir) ? new Set(readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, ''))) : new Set<string>()
  const missing = wave.codes.map((c) => c.code).filter((c) => !built.has(c))
  if (missing.length > 0) {
    fail.push(`dist/hts: 웨이브 ${wave.codes.length}개 중 ${missing.length}개가 발행되지 않았다 (${missing.slice(0, 3).join(', ')}…)`)
  }
  const sm = read(`dist/sitemaps/hts-ch${wave.codes[0]?.code.slice(0, 2)}.xml`)
  if (wave.codes.length > 0 && sm === null) fail.push('dist/sitemaps: 장별 코드 사이트맵이 없다 (npm run sitemap:build)')
}

if (fail.length > 0) {
  console.error('── 빌드 검사 실패 ───────────────────────────────')
  for (const f of fail) console.error('  ✗ ' + f)
  console.error('')
  process.exit(1)
}
console.log('빌드 검사 통과 — 필수 페이지·구가격 차단·env 치환·전환 태그·번들 설정 이상 없음')
