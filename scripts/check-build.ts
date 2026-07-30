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
