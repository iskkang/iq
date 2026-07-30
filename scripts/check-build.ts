/**
 * 빌드 산출물 검사 — 조용히 깨진 채로 배포되는 걸 막는다.
 *
 * 이 저장소가 반복해서 겪은 실패는 전부 같은 모양이다: 틀린 상태가 정상처럼 보인다.
 * 원장에 행이 없으면 duty 0, 빈 명령이 "타입체크 통과", 치환 안 된 플레이스홀더가
 * 그대로 배포. 그래서 배포 직전에 눈으로 확인 가능한 것만 기계로 확인한다.
 *
 * 실행: npm run build (자동) 또는 npm run check:build
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

// ── 1. Vite env 치환 누락 ─────────────────────────────────────────
// index.html 은 %VITE_SUPABASE_URL% 을 빌드 시 치환한다. Vercel 에 env 가 없으면
// 문자열이 그대로 남고, 랜딩 폼은 존재하지 않는 호스트로 POST 한다 — 이메일이
// 조용히 사라진다. Formspree 플레이스홀더로 이미 한 번 겪었다.
for (const f of ['dist/index.html', 'dist/privacy.html', 'dist/app/index.html', 'dist/sample-report.html', 'dist/hts.html']) {
  const html = read(f)
  if (html === null) continue
  const leftover = [...html.matchAll(/%VITE_[A-Z0-9_]+%/g)].map((m) => m[0])
  if (leftover.length > 0) {
    fail.push(`${f}: Vite env 치환 누락 — ${[...new Set(leftover)].join(', ')}`)
  }
}

// ── 1b. Google Ads 태그 ───────────────────────────────────────────
// 전환 추적은 틀려도 화면이 멀쩡하다. 로더가 빠지면 전환이 0 으로 보이는데,
// 그건 "광고가 안 먹힌다" 로 읽혀서 잘못된 결론(예산 중단)까지 간다.
// 두 번 들어가면 반대로 전환이 부풀 수 있다. 그래서 **정확히 1회**를 본다.
const ADS_ID = 'AW-18359222502'
const ADS_LOADER = /googletagmanager\.com\/gtag\/js\?id=AW-18359222502/g

for (const f of ['dist/index.html', 'dist/privacy.html', 'dist/app/index.html', 'dist/sample-report.html', 'dist/hts.html']) {
  const html = read(f)
  if (html === null) continue
  const n = [...html.matchAll(ADS_LOADER)].length
  if (n !== 1) fail.push(`${f}: gtag 로더가 ${n}회 — 정확히 1회여야 한다`)
  if (!html.includes(`gtag('config', '${ADS_ID}')`)) fail.push(`${f}: gtag config 에 전환 ID ${ADS_ID} 가 없다`)
}

// 전환 라벨은 /ads.js 한 곳에만 있다. 이 파일이 빠지면 폼은 정상 동작하면서
// 전환만 조용히 안 잡힌다 — 페이지 HTML 만 봐서는 알 수 없는 실패다.
const ads = read('dist/ads.js')
if (ads === null) {
  fail.push('dist/ads.js 가 없다 — 전환 보고가 통째로 빠진다 (public/ads.js 확인)')
} else {
  if (!ads.includes(ADS_ID)) fail.push(`dist/ads.js: 전환 ID ${ADS_ID} 가 없다`)
  if (!/signup:\s*'[A-Za-z0-9_-]+'/.test(ads)) fail.push('dist/ads.js: signup 전환 라벨이 비어 있다')
}
// 폼이 있는 페이지는 /ads.js 를 실제로 불러야 한다 (파일만 있고 아무도 안 부르면 같은 결과다)
for (const f of ['dist/index.html', 'dist/sample-report.html', 'dist/hts.html']) {
  const html = read(f)
  if (html !== null && !html.includes('/ads.js')) fail.push(`${f}: /ads.js 를 불러오지 않는다 — 전환이 기록되지 않는다`)
}

// ── 2. 남아 있으면 안 되는 플레이스홀더 ────────────────────────────
const PLACEHOLDERS = ['YOUR_FORMSPREE_ID', 'YOUR_DOMAIN.com', 'YOUR_PROJECT', '<project-ref>', '[서울 주소']

// 도메인 이전 후 남으면 안 되는 것. 하나라도 남으면 Plausible 은 엉뚱한 사이트로
// 집계하고, 구 이메일은 심사·문의를 받지 못하는 곳으로 보낸다.
const STALE = ['iq-rose.vercel.app', 'metalogislab@gmail.com']

for (const f of ['dist/index.html', 'dist/privacy.html', 'dist/sample-report.html', 'dist/hts.html']) {
  const html = read(f)
  if (html === null) continue
  for (const ph of PLACEHOLDERS) {
    if (html.includes(ph)) fail.push(`${f}: 치환되지 않은 플레이스홀더 "${ph}"`)
  }
  for (const st of STALE) {
    if (html.includes(st)) fail.push(`${f}: 구 도메인/연락처 "${st}" 가 남아 있다`)
  }
}

// ── 3. 앱 번들에 Supabase 설정이 실렸는가 ─────────────────────────
// 없으면 프로덕션에서 인메모리 데모로 떨어진다. main.tsx 가 화면을 막긴 하지만,
// 배포 전에 잡는 편이 낫다.
const appHtml = read('dist/app/index.html')
if (appHtml !== null) {
  const m = appHtml.match(/\/assets\/[A-Za-z0-9._-]+\.js/)
  const bundle = m ? read('dist' + m[0]) : null
  if (bundle === null) {
    fail.push('dist/app: 번들을 찾지 못했다')
  } else if (!/https:\/\/[a-z0-9]+\.supabase\.(co|in|red)/.test(bundle)) {
    fail.push('dist/app 번들에 Supabase URL 이 없다 — VITE_SUPABASE_URL 미주입 (프로덕션이 데모로 떨어진다)')
  }
}

// ── 4. 사용자에게 보이면 안 되는 문구 ──────────────────────────────
const landing = read('dist/index.html')
if (landing !== null) {
  for (const w of ['demo mode', 'browser memory', 'DEMO MODE']) {
    if (landing.includes(w)) fail.push(`dist/index.html: 사용자 노출 문구 "${w}"`)
  }
}

if (fail.length > 0) {
  console.error('── 빌드 검사 실패 ───────────────────────────────')
  for (const f of fail) console.error('  ✗ ' + f)
  console.error('')
  process.exit(1)
}
console.log('빌드 검사 통과 — env 치환·플레이스홀더·번들 설정 이상 없음')
