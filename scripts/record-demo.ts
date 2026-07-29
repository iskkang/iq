/**
 * 데모 영상 녹화 — CSV 업로드 → 301 3층 스택 리포트.
 *
 * 말보다 화면이 싸게 신뢰를 만든다. 랜딩 히어로 바로 아래에 넣는다.
 *
 * 산출물: public/demo.webm  (Playwright 번들 ffmpeg 사용 — 외부 설치 불필요)
 * 실행:   npm run demo:record
 *
 * 데모용 계정은 admin API 로 만들고(확인 메일 우회) 끝나면 지운다.
 * 실패하면 data/demo-shots/ 에 단계별 스크린샷을 남긴다 — 셀렉터가 바뀌면
 * 그걸 보고 고치면 된다.
 */
import { chromium } from 'playwright'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(root, 'data/demo-shots')
const VIDEO_DIR = join(root, 'data/demo-video')
const OUT = join(root, 'public/demo.webm')
const BASE = process.env.DEMO_BASE ?? 'https://www.landediq.app'

function env(): Record<string, string> {
  const f = join(root, '.env')
  if (!existsSync(f)) return {}
  const o: Record<string, string> = {}
  for (const l of readFileSync(f, 'utf-8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
    if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
  return o
}
const E = env()
const SUPA = E.VITE_SUPABASE_URL!
const SRV = E.SUPABASE_SERVICE_ROLE_KEY!
const EMAIL = 'demo-recording@landediq.app'
const PW = 'Demo-Recording-2026!xy'

/** 중국산 5종. 백팩(4202.92.31 List 3)이 3층 스택을 만든다 */
const CSV = `sku,product_name,description_or_material,unit_cost_usd,origin_country,units_per_shipment,current_price_usd,hts_code
BACKPACK-01,Laptop backpack,100% polyester outer shell with padded straps,8.50,CN,400,39.99,4202923120
TSHIRT-01,Men's crew neck t-shirt,100% cotton knitted short-sleeve,3.20,CN,800,19.99,6109100012
MUG-01,Ceramic coffee mug 11oz,Glazed stoneware ceramic mug,2.50,CN,1000,12.99,6912004400
LAMP-01,LED table lamp,Aluminium body LED desk lamp for household use,7.90,CN,500,34.99,9405216010
TUMBLER-01,Insulated tumbler 20oz,Double-wall vacuum stainless steel,3.10,CN,600,24.99,9617001000
`

const admin = { 'Content-Type': 'application/json', apikey: SRV, Authorization: `Bearer ${SRV}` }
async function api(path: string, init?: RequestInit) {
  const r = await fetch(SUPA + path, { ...init, headers: { ...admin, ...(init?.headers ?? {}) } })
  return { status: r.status, text: await r.text() }
}

async function resetUser(): Promise<void> {
  const list = await api('/auth/v1/admin/users?per_page=200')
  if (list.status === 200) {
    for (const u of (JSON.parse(list.text).users ?? []) as Array<{ id: string; email: string }>) {
      if (u.email === EMAIL) await api(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE' })
    }
  }
  const c = await api('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PW, email_confirm: true }),
  })
  if (c.status >= 300) throw new Error(`데모 계정 생성 실패: ${c.status} ${c.text.slice(0, 200)}`)
}

async function main() {
  rmSync(SHOTS, { recursive: true, force: true })
  rmSync(VIDEO_DIR, { recursive: true, force: true })
  mkdirSync(SHOTS, { recursive: true })
  mkdirSync(join(root, 'public'), { recursive: true })

  console.log('데모 계정 준비…')
  await resetUser()

  const browser = await chromium.launch()
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 800 } },
  })
  const page = await ctx.newPage()
  let step = 0
  const shot = async (name: string) => {
    step += 1
    await page.screenshot({ path: join(SHOTS, `${String(step).padStart(2, '0')}-${name}.png`) })
    console.log(`  ${step}. ${name}`)
  }
  const pause = (ms: number) => page.waitForTimeout(ms)

  try {
    await page.goto(`${BASE}/app`, { waitUntil: 'networkidle', timeout: 60_000 })
    await shot('app-open')

    // ── 로그인 ────────────────────────────────────────────────
    await page.locator('input[type=email]').first().fill(EMAIL)
    await page.locator('input[type=password]').first().fill(PW)
    await pause(600)
    await shot('credentials')
    // AuthPage 에는 "Sign in" 이 둘 있다 — 탭 토글과 제출 버튼. 탭이 DOM 상
    // 먼저라 .first() 는 탭을 누른다(아무 일도 안 일어난다). 제출은 마지막 것이다.
    await page.getByRole('button', { name: /^Sign in$/ }).last().click()
    await page.waitForSelector('text=Shipments', { timeout: 60_000 })
    await pause(1200)
    await shot('signed-in')

    // ── 새 선적 ───────────────────────────────────────────────
    await page.locator('text=New shipment').first().click()
    await pause(500)
    const nameBox = page.locator('input[type=text]').first()
    await nameBox.fill('Q3 restock — China')
    await pause(400)
    await shot('new-shipment')
    await page.getByRole('button', { name: /Create|Save|Add|New shipment/i }).last().click()
    await page.waitForSelector('input[type=file]', { timeout: 60_000 })
    await pause(900)
    await shot('shipment-created')

    // ── CSV 업로드 ────────────────────────────────────────────
    await page.locator('input[type=file]').first().setInputFiles({
      name: 'q3-restock.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(CSV, 'utf-8'),
    })
    await page.waitForSelector('text=BACKPACK-01', { timeout: 60_000 })
    await pause(1500)
    await shot('csv-uploaded')

    // ── 리포트 ────────────────────────────────────────────────
    await page.waitForSelector('text=Landed cost', { timeout: 60_000 })
    await page.mouse.wheel(0, 400)
    await pause(2000)
    await shot('report')
    await page.mouse.wheel(0, 400)
    await pause(2500)
    await shot('report-scrolled')
  } catch (e) {
    console.error('실패:', String(e).slice(0, 300))
    await page.screenshot({ path: join(SHOTS, `99-failure.png`) }).catch(() => {})
    console.error(`단계별 스크린샷: ${SHOTS}`)
    await ctx.close()
    await browser.close()
    process.exitCode = 1
    return
  }

  await ctx.close() // 영상은 컨텍스트를 닫을 때 flush 된다
  await browser.close()

  const vids = readdirSync(VIDEO_DIR).filter((f) => f.endsWith('.webm'))
  if (vids.length === 0) throw new Error('영상 파일이 생성되지 않았다')
  renameSync(join(VIDEO_DIR, vids[0]), OUT)
  const bytes = readFileSync(OUT).length
  console.log()
  console.log(`→ public/demo.webm (${(bytes / 1e6).toFixed(2)} MB)`)

  // 정리
  const list = await api('/auth/v1/admin/users?per_page=200')
  for (const u of (JSON.parse(list.text).users ?? []) as Array<{ id: string; email: string }>) {
    if (u.email === EMAIL) await api(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE' })
  }
  console.log('데모 계정 삭제 완료')
}

main()
