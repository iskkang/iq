/**
 * 퍼널 계측 스모크 — 정적 공개 페이지가 실제로 이벤트를 보내는지 브라우저에서 확인.
 *
 * ── 왜 있는가 ────────────────────────────────────────────────────
 * 계측은 빠져도 페이지가 멀쩡히 동작한다. 그래서 사람이 알아채지 못한다 —
 * /app 안에만 계측이 있고 광고가 떨어지는 공개 페이지에는 하나도 없는 채로
 * 63 클릭 · ₩134,729 을 썼다. check-build 는 문자열 존재만 보므로, **정말
 * 전송되는지**는 브라우저를 띄워서만 알 수 있다.
 *
 * analytics_events 로 나가는 요청을 가로채서 검사한다. 실제 Supabase 는
 * 부르지 않는다.
 *
 * 실행: node scripts/smoke-funnel.mjs   (사전: npm run build)
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import net from 'node:net'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 4179

/**
 * npx 가 아니라 설치된 실행 파일을 직접 부른다.
 *
 * npx 는 로컬에 있어도 해석 단계를 한 번 더 거치고, CI 콜드 스타트에서 그
 * 시간이 준비 판정 창을 넘길 수 있다. 실제로 CI 첫 실행이 그렇게 죽었다.
 *
 * --host 127.0.0.1 을 명시하는 이유가 따로 있다. vite 의 기본 host 는
 * `localhost` 이고, 그건 **런타임이 해석하는 이름**이다. GitHub 러너처럼
 * localhost 가 ::1 로 먼저 풀리는 환경에서는 vite 가 [::1]:4179 에만 바인딩하고,
 * 아래 TCP 프로브(127.0.0.1)는 영원히 연결되지 않는다 — 서버는 멀쩡히 떠 있는데
 * "안 떴다" 로 죽는다. 이름 해석을 빼고 주소를 고정하면 그 어긋남이 사라진다.
 *
 * detached: 프로세스 그룹째 정리하려고 분리한다. 안 하면 vite 가 남아 포트를
 * 물고 이벤트 루프도 붙잡는다.
 */
const VITE = join(root, 'node_modules', '.bin', 'vite')
const server = spawn(VITE, ['preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})

/**
 * 서버 출력을 모아 둔다 — **실패했을 때 이유를 보여주기 위해서다.**
 *
 * 파이프로 삼키고 "안 떴다" 만 던지면, 가드가 왜 죽었는지 알 수 없어 사람들이
 * 가드를 끈다. CI 첫 실행이 정확히 그 상태였다.
 */
let serverLog = ''
const keep = (d) => { serverLog += String(d); if (serverLog.length > 4000) serverLog = serverLog.slice(-4000) }
server.stdout.on('data', keep)
server.stderr.on('data', keep)

let serverExited = null
server.on('exit', (code, signal) => { serverExited = signal ? `signal ${signal}` : `code ${code}` })

function stopServer() {
  try { process.kill(-server.pid) } catch { /* 이미 죽었으면 그만 */ }
}

/**
 * 포트가 열렸는지로 준비를 판정한다.
 *
 * stdout 파싱은 vite 버전마다 문자열이 바뀌고, 포트가 물려 있으면 서버가 조용히
 * 죽어 스크립트가 매달린다. 그렇다고 fetch 로 확인해도 안 된다 — 이 컨테이너는
 * HTTPS_PROXY 가 걸려 있어 localhost 요청까지 프록시로 새고 응답 없이 매달린다.
 * 그래서 TCP 연결만 본다. 프록시와 무관하다.
 */
function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    const done = (ok) => { sock.destroy(); resolve(ok) }
    sock.setTimeout(700)
    sock.on('connect', () => done(true))
    sock.on('timeout', () => done(false))
    sock.on('error', () => done(false))
  })
}

// CI 콜드 스타트는 로컬보다 느리다. 60 초까지 기다리되, 서버가 먼저 죽으면
// 기다릴 이유가 없으므로 즉시 빠져나온다.
let ready = false
for (let i = 0; i < 120 && !ready && serverExited === null; i++) {
  ready = await portOpen(PORT)
  if (!ready) await new Promise((r) => setTimeout(r, 500))
}
if (!ready) {
  stopServer()
  const why = serverExited ? `서버가 먼저 종료됐다 (${serverExited})` : '60초 안에 포트가 열리지 않았다'
  throw new Error(
    `preview 서버가 ${PORT} 에서 뜨지 않았다 — ${why}\n` +
      `── 서버 출력 ──────────────────────────────────\n${serverLog.trim() || '(출력 없음)'}`,
  )
}

const fails = []
/**
 * 실행 파일을 환경변수로 받을 수 있게 둔다.
 * CI·로컬은 Playwright 가 받은 브라우저를 쓰지만, 컨테이너에는 다른 빌드가
 * 미리 깔려 있어 버전이 어긋난다. 그때 PLAYWRIGHT_CHROMIUM 으로 지정한다.
 */
if (process.env.SMOKE_DEBUG) console.log('server ready, launching browser')
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
)
const ctx = await browser.newContext()

/**
 * 외부 호스트는 끊는다 (gtag · plausible). 이 스크립트가 검사하는 건 우리
 * 계측이지 서드파티가 아니고, 샌드박스에서는 외부 요청이 응답 없이 매달려
 * networkidle 이 영원히 안 온다.
 *
 * ── Tailwind 만은 예외다 ─────────────────────────────────────────
 * 랜딩(index.html)은 스타일 전체가 cdn.jsdelivr.net 의 Tailwind 브라우저
 * 빌드에 달려 있다. 그걸 끊으면 랜딩이 무스타일로 렌더되고, 레이아웃을 보는
 * 검사가 전부 무의미해진다 — 실제로 그 상태로 **랜딩이 모바일에서 가로로
 * 299px 넘치는 결함이 프로덕션까지 갔다.** 표(min-w 640px)를 담은 카드가
 * 그리드 아이템인데 min-width:auto 라 축소를 거부했고, 헤더와 본문이 서로
 * 어긋나 보였다. 아무 검사도 잡지 못했다.
 *
 * npm 으로 같은 빌드를 받아 로컬에서 응답한다. CDN 을 타지 않으므로
 * 네트워크에 매달리지 않고, 랜딩이 실제 스타일로 렌더된다.
 */
const TAILWIND = readFileSync(
  new URL('../node_modules/@tailwindcss/browser/dist/index.global.js', import.meta.url),
  'utf-8',
)

// 127.0.0.1 로 통일한다 — CI 에서 localhost 가 ::1 로 풀리면 vite 가 바인딩한
// 127.0.0.1 과 어긋나 페이지가 아예 안 열린다.
await ctx.route('**/*', (route) => {
  const url = route.request().url()
  if (url.includes('tailwindcss')) {
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: TAILWIND })
  }
  return url.includes('127.0.0.1') ? route.continue() : route.abort()
})

/** 이 페이지 로드에서 잡힌 이벤트 이름들 */
let seen = []
await ctx.route('**/rest/v1/analytics_events', async (route) => {
  try { seen.push(JSON.parse(route.request().postData() ?? '{}').event_name) } catch { /* 형식 오류는 아래 검사에서 드러난다 */ }
  await route.fulfill({ status: 201, body: '' })
})
// leads 저장은 실패시킨다 — 실패 경로가 이벤트를 남기고 화면에 보이는지 봐야 한다
await ctx.route('**/rest/v1/leads', (route) => route.fulfill({ status: 500, body: '{}' }))
await ctx.route('**/functions/v1/hts-lookup', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ as_of: '2026-07-29', results: [] }) }),
)

async function visit(path) {
  if (process.env.SMOKE_DEBUG) console.log('  visit', path)
  seen = []
  const page = await ctx.newPage()
  page.setDefaultTimeout(10000)
  await page.goto(`http://127.0.0.1:${PORT}${path}`, { waitUntil: 'load', timeout: 15000 })
  await page.waitForTimeout(400) // page_view 는 DOMContentLoaded 뒤에 나간다
  return page
}

function expect(cond, msg) {
  if (!cond) fails.push(msg)
}

// ── 0. 모바일에서 가로로 넘치지 않는다 ──────────────────────────
// 넘치면 헤더(뷰포트 폭 고정)와 본문이 어긋나 보이고, 사용자는 오른쪽으로
// 밀어야 내용을 본다. 광고가 착지하는 페이지에서 이건 조용한 손실이다.
// 실제로 랜딩이 390px 에서 689px 로 넘친 채 배포됐고 아무도 못 잡았다.
{
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })
  await mobile.route('**/*', (route) => {
    const url = route.request().url()
    if (url.includes('tailwindcss')) {
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: TAILWIND })
    }
    return url.includes('127.0.0.1') ? route.continue() : route.abort()
  })
  for (const path of ['/', '/hts', '/about', '/section-301', '/sample-report']) {
    const page = await mobile.newPage()
    page.setDefaultTimeout(10000)
    await page.goto(`http://127.0.0.1:${PORT}${path}`, { waitUntil: 'load', timeout: 15000 })
    await page.waitForTimeout(900) // Tailwind 브라우저 빌드가 CSS 를 만들 시간
    const { vw, sw } = await page.evaluate(() => ({
      vw: document.documentElement.clientWidth,
      sw: document.documentElement.scrollWidth,
    }))
    expect(sw <= vw + 1, `${path}: 모바일에서 가로로 넘친다 (scrollWidth ${sw} > viewport ${vw})`)
    await page.close()
  }
  await mobile.close()
}

// ── 1. page_view 가 모든 공개 페이지에서 나간다 ─────────────────
for (const path of ['/', '/hts', '/section-301']) {
  const page = await visit(path)
  expect(seen.includes('page_view'), `${path}: page_view 이벤트가 나가지 않았다`)
  await page.close()
}

// ── 2. /hts 조회 퍼널 ───────────────────────────────────────────
{
  const page = await visit('/hts')
  await page.fill('#q', '6912.00.44')
  await page.click('#q-form button')
  await page.waitForTimeout(700)
  expect(seen.includes('hts_lookup_submitted'), '/hts: hts_lookup_submitted 가 없다')
  expect(seen.includes('hts_lookup_empty'), '/hts: 결과 0건인데 hts_lookup_empty 가 없다')
  await page.close()
}

// ── 3. /hts 폼 실패가 이벤트를 남기고 화면에도 보인다 ───────────
{
  const page = await visit('/hts')
  await page.fill('#watch-form input[type=email]', 'smoke@example.com')
  await page.selectOption('#watch-form select', '1–10')
  await page.click('#watch-form button')
  await page.waitForTimeout(700)
  expect(seen.includes('watch_submitted'), '/hts: watch_submitted 가 없다')
  expect(seen.includes('watch_failed'), '/hts: 저장 실패인데 watch_failed 가 없다')
  const err = await page.textContent('.form-err').catch(() => null)
  expect(err && err.length > 0, '/hts: 저장이 실패했는데 사용자에게 아무 메시지도 없다')
  await page.close()
}

// ── 4. 랜딩 가입 폼 실패도 마찬가지 ─────────────────────────────
{
  const page = await visit('/')
  await page.fill('.signup-form input[type=email]', 'smoke@example.com')
  await page.click('.signup-form button')
  await page.waitForTimeout(700)
  expect(seen.includes('signup_submitted'), '/: signup_submitted 가 없다')
  expect(seen.includes('signup_failed'), '/: 저장 실패인데 signup_failed 가 없다')
  const err = await page.textContent('.form-err').catch(() => null)
  expect(err && err.length > 0, '/: 저장이 실패했는데 사용자에게 아무 메시지도 없다')
  await page.close()
}

// ── 5. 에디토리얼 — 댓글은 이 기능의 존재 이유다 ────────────────
{
  const slug = readdirSync(join(root, 'blog'))
    .filter((f) => f.endsWith('.html'))[0]
    ?.replace(/\.html$/, '')
  if (!slug) fails.push('blog/ 에 발행된 글이 없다')
  else {
    // 기존 댓글이 그려지는가
    let postedBody = null
    await ctx.route('**/rest/v1/blog_comments*', async (route) => {
      if (route.request().method() === 'POST') {
        postedBody = JSON.parse(route.request().postData() ?? '{}')
        return route.fulfill({ status: 201, body: '' })
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ author: 'Existing <b>reader</b>', body: 'prior reply', created_at: '2026-08-01T00:00:00Z' }]),
      })
    })

    const page = await visit(`/blog/${slug}`)
    expect(seen.includes('page_view'), `/blog/${slug}: page_view 가 없다`)
    const rendered = (await page.textContent('#cmts')) ?? ''
    expect(rendered.includes('prior reply'), '기존 댓글이 그려지지 않았다')
    // 방문자가 쓴 글이 그대로 HTML 이 되면 XSS 다
    expect((await page.innerHTML('#cmts')).includes('&lt;b&gt;'), '댓글 작성자 이름이 escape 되지 않았다')

    await page.fill('#cform input[name=author]', 'Smoke Tester')
    await page.fill('#cform textarea[name=body]', 'This is a smoke reply.')
    await page.click('#cform button')
    await page.waitForTimeout(700)
    expect(seen.includes('comment_submitted'), 'comment_submitted 가 없다')
    expect(seen.includes('comment_posted'), 'comment_posted 가 없다')
    expect(postedBody?.post_slug === slug, `댓글이 slug 없이 저장됐다: ${JSON.stringify(postedBody)}`)
    await page.close()

    // 저장 실패도 조용하지 않아야 한다
    await ctx.route('**/rest/v1/blog_comments*', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 500, body: '{}' })
        : route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    )
    const page2 = await visit(`/blog/${slug}`)
    await page2.fill('#cform input[name=author]', 'Smoke Tester')
    await page2.fill('#cform textarea[name=body]', 'This should fail.')
    await page2.click('#cform button')
    await page2.waitForTimeout(700)
    expect(seen.includes('comment_failed'), 'comment_failed 가 없다')
    expect(((await page2.textContent('#cerr')) ?? '').length > 0, '댓글 저장이 실패했는데 화면에 아무 말이 없다')
    await page2.close()
  }
}

await browser.close()
stopServer()

if (fails.length > 0) {
  console.error('── 퍼널 스모크 실패 ────────────────────────────')
  for (const f of fails) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log('퍼널 스모크 통과 — page_view · 조회 · 폼 제출/실패 이벤트와 실패 메시지 확인')
process.exit(0)
