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
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import net from 'node:net'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 4179

// detached: npx 가 vite 를 자식으로 띄우므로 npx 만 죽이면 vite 가 남아
// 포트를 물고 이벤트 루프도 붙잡는다. 프로세스 그룹째 정리하려고 분리한다.
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'pipe',
  detached: true,
})
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

let ready = false
for (let i = 0; i < 40 && !ready; i++) {
  ready = await portOpen(PORT)
  if (!ready) await new Promise((r) => setTimeout(r, 500))
}
if (!ready) {
  stopServer()
  throw new Error(`preview 서버가 ${PORT} 에서 뜨지 않았다 (포트 점유 여부를 확인할 것)`)
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
 * 외부 호스트는 끊는다 (gtag · plausible · tailwind CDN).
 * 이 스크립트가 검사하는 건 우리 계측이지 서드파티가 아니고, 샌드박스에서는
 * 외부 요청이 응답 없이 매달려 networkidle 이 영원히 안 온다.
 */
await ctx.route('**/*', (route) => {
  const url = route.request().url()
  return url.includes('localhost') ? route.continue() : route.abort()
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
  await page.goto(`http://localhost:${PORT}${path}`, { waitUntil: 'load', timeout: 15000 })
  await page.waitForTimeout(400) // page_view 는 DOMContentLoaded 뒤에 나간다
  return page
}

function expect(cond, msg) {
  if (!cond) fails.push(msg)
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
