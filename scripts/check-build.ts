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
const STALE = ['iq-rose.vercel.app', 'metalogislab@gmail.com']
for (const f of [
  'dist/index.html',
  'dist/privacy.html',
  'dist/about.html',
  'dist/methodology.html',
  'dist/terms.html',
  'dist/sample-report.html',
  'dist/hts.html',
  'dist/section-301.html',
]) {
  const html = read(f)
  if (html === null) continue
  for (const ph of PLACEHOLDERS) if (html.includes(ph)) fail.push(`${f}: 치환되지 않은 플레이스홀더 "${ph}"`)
  for (const st of STALE) if (html.includes(st)) fail.push(`${f}: 구 도메인/연락처 "${st}" 가 남아 있다`)
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
}

if (fail.length > 0) {
  console.error('── 빌드 검사 실패 ───────────────────────────────')
  for (const f of fail) console.error('  ✗ ' + f)
  console.error('')
  process.exit(1)
}
console.log('빌드 검사 통과 — 필수 페이지·env 치환·플레이스홀더·번들 설정 이상 없음')
