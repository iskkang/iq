/**
 * E2E 스모크 테스트 (데모 모드) — dist 빌드를 preview 서버로 띄우고
 * 가입 → CSV 업로드 → HTS 추정(mock) → 리포트 확인 전 플로우를 검증.
 * 실행: node scripts/smoke-e2e.mjs   (사전: npm run build)
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const PORT = 4173

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'pipe',
})
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('preview server timeout')), 15000)
  server.stdout.on('data', (d) => {
    if (String(d).includes('http')) {
      clearTimeout(t)
      resolve()
    }
  })
  server.on('exit', () => reject(new Error('preview server exited')))
})

const fails = []
const check = (name, cond) => {
  console.log(`${cond ? '✓' : '✗'} ${name}`)
  if (!cond) fails.push(name)
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

try {
  await page.goto(`http://localhost:${PORT}/`)

  // 1) 데모 로그인 (모든 화면 고지 §1-2 확인 포함)
  check('고지 문구(로그인 화면)', await page.getByText('Estimates only', { exact: false }).first().isVisible())
  await page.fill('input[type=email]', 'smoke@test.dev')
  await page.click('button:has-text("Start demo")')
  await page.waitForSelector('h1:has-text("Shipments")')
  check('데모 로그인 → 선적 목록', true)

  // 2) 선적 생성
  await page.fill('input[placeholder*="Ningbo"]', 'Smoke Test Shipment')
  const numInputs = page.locator('form input[type=number]')
  await numInputs.nth(0).fill('2000') // freight
  await numInputs.nth(1).fill('100') // insurance
  await page.click('button:has-text("Create shipment")')
  await page.waitForSelector('text=Upload CSV')
  check('선적 생성 → 상세 화면', true)

  // 3) CSV 업로드 (샘플 10행)
  await page.setInputFiles('input[type=file]', join(root, 'samples/sample_products.csv'))
  await page.waitForSelector('text=MUG-01')
  const rowCount = await page.locator('tbody tr').count()
  check(`CSV 10행 업로드 (표시 ${rowCount}행)`, rowCount === 10)

  // 4) HTS 추정 (mock)
  await page.click('button:has-text("Estimate HTS")')
  await page.waitForSelector('text=Auto-confirmed', { timeout: 15000 })
  const confirmed = await page.locator('text=Auto-confirmed').count()
  const review = await page.locator('span:has-text("Needs review")').count()
  check(`분류 완료 (자동확정 ${confirmed}, 리뷰 ${review})`, confirmed + review >= 10)

  // 5) 후보 확정 UI (첫 SKU에서 후보 확인)
  await page.locator('button:has-text("Confirm HTS")').first().click()
  await page.waitForSelector('text=LLM candidates')
  const candBtns = await page.locator('button:has-text("Use this")').count()
  check(`LLM 후보 2~3개 표시 (${candBtns}개)`, candBtns >= 2 && candBtns <= 3)
  await page.locator('button:has-text("Use this")').first().click()
  await page.getByText('Confirmed', { exact: true }).first().waitFor()
  check('후보 1개 확정 → 사용자 확정 상태', true)

  // 6) 리포트
  await page.click('button:has-text("Report")')
  await page.waitForSelector('text=Duty % breakdown')
  await page.waitForSelector('text=Rates as of')
  const reportRows = await page.locator('tbody tr').count()
  check(`리포트 테이블 10행 (표시 ${reportRows}행)`, reportRows === 10)
  const hasBreakdown = (await page.locator('td:has-text("MFN")').count()) > 0
  check('레이어 내역(MFN…) 표기', hasBreakdown)
  check('고지 문구(리포트 화면)', (await page.getByText('Estimates only', { exact: false }).count()) >= 2)

  // 7) CSV 다운로드
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('button:has-text("Download CSV")'),
  ])
  const path = await download.path()
  const { readFileSync } = await import('node:fs')
  const csvOut = readFileSync(path, 'utf-8')
  check('리포트 CSV에 고지 포함', csvOut.includes('Estimates only'))
  check('리포트 CSV에 rate 기준일 포함', csvOut.includes('Rates as of'))

  await page.screenshot({ path: join(root, 'smoke-report.png'), fullPage: true })
  check('런타임 에러 없음', errors.length === 0)
  if (errors.length) console.log('pageerrors:', errors)
} catch (e) {
  console.error('✗ 스모크 실패:', e)
  fails.push(String(e))
  await page.screenshot({ path: join(root, 'smoke-fail.png'), fullPage: true }).catch(() => {})
} finally {
  await browser.close()
  server.kill()
}

console.log(fails.length === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${fails.length})`)
process.exit(fails.length === 0 ? 0 : 1)
