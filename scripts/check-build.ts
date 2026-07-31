/**
 * 빌드 산출물 검사 — 조용히 깨진 채로 배포되는 걸 막는다.
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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

for (const f of PUBLIC_HTML) {
  const html = read(f)
  if (html === null) continue
  for (const ph of PLACEHOLDERS) if (html.includes(ph)) fail.push(`${f}: 치환되지 않은 플레이스홀더 "${ph}"`)
  for (const st of STALE) if (html.includes(st)) fail.push(`${f}: 폐기한 가격/CTA/주소 문구 "${st}" 가 남아 있다`)
}

const REQUIRED_COPY: Record<string, string[]> = {
  'dist/index.html': ['Private beta', 'Get Beta Access', 'Free during validation', 'no automatic charge'],
  'dist/hts.html': ['Official USITC base data', 'Report a data issue', 'Free during validation'],
  'dist/section-301.html': ['Official USITC Chapter 99 source', 'Report a data issue', 'Free during validation'],
  'dist/sample-report.html': ['Product proof', 'Working beta workflow', 'Free during validation'],
  'dist/about.html': ['Current product stage', 'Working beta, free during validation'],
  'dist/methodology.html': ['Official data sources', 'Current data coverage', 'Data corrections and support'],
  'dist/terms.html': ['Current beta status', 'does not automatically convert'],
  'dist/privacy.html': ['will not automatically convert'],
}
for (const [f, expected] of Object.entries(REQUIRED_COPY)) {
  const html = read(f)
  if (html === null) continue
  for (const text of expected) if (!html.includes(text)) fail.push(`${f}: 필수 신뢰/가격 문구 "${text}" 가 없다`)
}

const appHtml = read('dist/app/index.html')
if (appHtml !== null) {
  const m = appHtml.match(/\/assets\/[A-Za-z0-9._-]+\.js/)
  const bundle = m ? read('dist' + m[0]) : null
  if (bundle === null) fail.push('dist/app: 번들을 찾지 못했다')
  else {
    if (!/https:\/\/[a-z0-9]+\.supabase\.(co|in|red)/.test(bundle)) fail.push('dist/app 번들에 Supabase URL 이 없다 — VITE_SUPABASE_URL 미주입 (프로덕션이 데모로 떨어진다)')
    if (!bundle.includes('Free during validation')) fail.push('dist/app 번들에 현재 베타 가격 상태가 없다')
    if (!bundle.includes('no automatic charge')) fail.push('dist/app 번들에 자동 유료 전환 없음 문구가 없다')
  }
}

const landing = read('dist/index.html')
if (landing !== null) {
  for (const w of ['demo mode', 'browser memory', 'DEMO MODE']) if (landing.includes(w)) fail.push(`dist/index.html: 사용자 노출 문구 "${w}"`)
}

if (fail.length > 0) {
  console.error('── 빌드 검사 실패 ───────────────────────────────')
  for (const f of fail) console.error('  ✗ ' + f)
  console.error('')
  process.exit(1)
}
console.log('빌드 검사 통과 — 필수 페이지·신뢰 문구·가격 상태·env 치환·전환 태그·번들 설정 이상 없음')
