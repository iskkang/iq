/**
 * 랜딩 검증: 변형 스위칭(/a /b /c), 폼 제출(Formspree stub) → 성공 메시지,
 * hidden field(variant·intent·UTM) 전송값, Plausible 이벤트 1회, 샘플 리포트 게이트.
 * 실행: node verify.mjs  (사전: npm i -D playwright — landed-iq 쪽 것 재사용 가능)
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(join(__dirname, 'landing.html'))
const privacyHtml = readFileSync(join(__dirname, 'privacy.html'))

// vercel 라우팅 흉내: /a /b /c → landing.html, /privacy → privacy.html (cleanUrls)
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(req.url.startsWith('/privacy') ? privacyHtml : html)
}).listen(4180)

const fails = []
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!cond) fails.push(name)
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
const twScript = readFileSync(join(__dirname, 'node_modules/@tailwindcss/browser/dist/index.global.js'), 'utf-8')
/** 샌드박스에서 CDN 차단 → 로컬 사본으로 대체해 실제 스타일까지 검증 */
const stubCdns = async (p) => {
  await p.route('**/cdn.jsdelivr.net/npm/@tailwindcss/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: twScript }))
  await p.route('**/plausible.io/js/**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }))
}

try {
  // ── 1) 변형별 헤드라인 ──
  const heads = {}
  for (const v of ['a', 'b', 'c']) {
    const p = await browser.newPage()
    await stubCdns(p)
    await p.goto(`http://localhost:4180/${v}`)
    heads[v] = await p.locator('#headline').textContent()
    await p.close()
  }
  check('/a /b /c 헤드라인이 서로 다름', new Set(Object.values(heads)).size === 3)

  // ── 2) 제출 플로우 (모바일 뷰포트) ──
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const plausibleEvents = []
  await page.addInitScript(() => {
    window.plausible = (...args) => window.__pl.push(args)
    window.__pl = []
  })
  let submitted = null
  await page.route('**/formspree.io/**', async (route) => {
    submitted = JSON.parse(route.request().postData())
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  })
  await stubCdns(page)

  await page.goto('http://localhost:4180/b?utm_source=reddit&utm_campaign=smoke1&utm_medium=social')
  // Tailwind 스타일 적용 확인 (히어로 버튼 배경색이 indigo인지)
  await page.waitForFunction(() => {
    const b = document.querySelector('.signup-form button[type=submit]')
    return b && getComputedStyle(b).backgroundColor !== 'rgba(0, 0, 0, 0)'
  })
  const btnBg = await page.evaluate(() => getComputedStyle(document.querySelector('.signup-form button[type=submit]')).backgroundColor)
  check('Tailwind 스타일 적용됨', btnBg !== 'rgba(0, 0, 0, 0)', btnBg)

  // ── 수정요구 1: 기본 상태 = 폼 표시, 성공 메시지 없음 (모바일) ──
  const heroFormVisible = await page.locator('#signup .signup-form input[type=email]').isVisible()
  const successAbsent = (await page.getByText("You're in line").count()) === 0
  check('기본 상태: 히어로 이메일 폼 표시 (모바일 390px)', heroFormVisible)
  check('기본 상태: 성공 메시지 미표시', successAbsent)
  await page.screenshot({ path: join(__dirname, 'landing-mobile.png'), fullPage: true })

  // ── 수정요구 4: 문제 카드 lucide SVG 3개 ──
  const svgCount = await page.locator('section:has(h2:text("Your COGS is lying to you")) svg').count()
  const emojiGone = !(await page.content()).match(/📈|🕳️|🎯/)
  check(`문제 카드 lucide SVG ${svgCount}개 (이모지 제거됨)`, svgCount === 3 && emojiGone)

  // ── 수정요구 2: 푸터 /privacy 링크 ──
  check('푸터 Privacy 링크', await page.locator('footer a[href="/privacy"]').isVisible())
  check('변형 b 헤드라인 로드', (await page.locator('#headline').textContent()).includes('3 minutes'))

  // 샘플 리포트 게이트 → 같은 이메일 폼
  await page.click('#sample-btn')
  check('샘플 버튼 → 폼 라벨 변경', (await page.locator('.signup-form button[type=submit]').first().textContent()).includes('sample report'))

  await page.fill('.signup-form input[type=email]', 'smoke@seller.com')
  await page.click('.signup-form button[type=submit]')
  await page.waitForSelector("text=You're in line")
  check('제출 후 대기열 메시지 표시', true)

  check('Formspree payload: email', submitted?.email === 'smoke@seller.com')
  check('Formspree payload: variant=b', submitted?.variant === 'b')
  check('Formspree payload: intent=sample_report', submitted?.intent === 'sample_report')
  check('Formspree payload: UTM 저장', submitted?.utm_source === 'reddit' && submitted?.utm_campaign === 'smoke1' && submitted?.utm_medium === 'social')

  const events = await page.evaluate(() => window.__pl)
  check('Plausible 이벤트 1회 (email_signup)', events.length === 1 && events[0][0] === 'email_signup', JSON.stringify(events[0]?.[1]?.props ?? {}))

  await page.screenshot({ path: join(__dirname, 'landing-mobile-submitted.png'), fullPage: true })

  // ── 수정요구 2: /privacy 페이지 내용 ──
  const pv = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await stubCdns(pv)
  await pv.goto('http://localhost:4180/privacy')
  const pvText = await pv.locator('main').textContent()
  check('/privacy: 수집항목(email) 명시', /email address/i.test(pvText))
  check('/privacy: 목적(early access) 명시', /early access/i.test(pvText))
  check('/privacy: 삭제요청 연락처', await pv.locator('a[href^="mailto:"]').isVisible())
  await pv.close()

  // ── 3) 데스크톱 스크린샷 (변형 a) ──
  const d = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await stubCdns(d)
  await d.goto('http://localhost:4180/a')
  await d.waitForTimeout(600) // tailwind JIT 적용 대기
  await d.screenshot({ path: join(__dirname, 'landing-desktop.png'), fullPage: true })
  await d.close()
} catch (e) {
  console.error('✗ 검증 실패:', e)
  fails.push(String(e))
} finally {
  await browser.close()
  server.close()
}

console.log(fails.length === 0 ? '\nVERIFY PASS' : `\nVERIFY FAIL (${fails.length})`)
process.exit(fails.length === 0 ? 0 : 1)
