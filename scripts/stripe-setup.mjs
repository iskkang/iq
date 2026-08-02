/**
 * Stripe 결제 설정을 API 로 한 번에 만든다.
 *
 * ── 왜 스크립트인가 ──────────────────────────────────────────────
 * 대시보드에서 손으로 하면 15번쯤 클릭하는데, 그중 두 군데가 조용히 틀리기 쉽다:
 *
 *   · Price ID 대신 Product ID(prod_…) 를 복사한다 → 체크아웃이 400
 *   · 웹훅 이벤트를 하나 빠뜨린다 → 결제는 되는데 상태가 안 바뀐다
 *
 * 둘 다 "설정은 다 한 것처럼 보이는데 안 되는" 종류라 원인을 찾기 어렵다.
 * 스크립트로 만들면 매번 같은 결과가 나오고, 두 번 돌려도 중복이 안 생긴다.
 *
 * ── 쓰는 법 ──────────────────────────────────────────────────────
 *   STRIPE_SECRET_KEY=sk_test_... npm run stripe:setup
 *
 * 테스트 키(sk_test_)로 먼저 한 바퀴 돌리고, 확인되면 라이브 키로 다시 돌린다.
 * 끝나면 그대로 붙여 넣을 `supabase secrets set` 명령을 출력한다.
 *
 * 이 스크립트는 **아무것도 지우지 않는다.** 이미 있으면 그것을 쓴다.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const PROJECT_REF = arg('project-ref', 'hwcfjxwdmmlydnrfyjqk')
const SITE_URL = arg('site', 'https://www.landediq.app')
const RECREATE_WEBHOOK = process.argv.includes('--recreate-webhook')

/** 가격은 src/lib/billing/plan.ts 가 단일 소스다. 여기에 숫자를 또 적지 않는다. */
function planPriceUsd() {
  const src = readFileSync(join(root, 'src/lib/billing/plan.ts'), 'utf-8')
  const m = src.match(/priceUsd:\s*(\d+(?:\.\d+)?)/)
  if (!m) throw new Error('src/lib/billing/plan.ts 에서 priceUsd 를 못 찾았다')
  return Number(m[1])
}

const KEY = process.env.STRIPE_SECRET_KEY
if (!KEY) {
  console.error('STRIPE_SECRET_KEY 가 없습니다.')
  console.error('  Stripe 대시보드 → Developers → API keys → Secret key')
  console.error('  STRIPE_SECRET_KEY=sk_test_... npm run stripe:setup')
  process.exit(1)
}
const LIVE = KEY.startsWith('sk_live_')

async function stripe(path, params, method = 'POST') {
  const url = `https://api.stripe.com/v1/${path}`
  const init = {
    method,
    headers: { Authorization: `Bearer ${KEY}` },
  }
  if (params && method === 'POST') {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded'
    init.body = new URLSearchParams(params)
  }
  let res
  try {
    res = await fetch(method === 'GET' && params ? `${url}?${new URLSearchParams(params)}` : url, init)
  } catch (e) {
    throw new Error(`api.stripe.com 에 연결할 수 없습니다 (${e.message}). 프록시·방화벽을 확인하세요.`)
  }

  // 응답이 JSON 이 아닐 수 있다 — 회사 프록시나 게이트웨이가 HTML 오류 페이지를
  // 돌려주는 경우다. 그대로 JSON.parse 하면 SyntaxError 로 죽고, 진짜 원인
  // (네트워크가 막혔다) 은 화면에 안 나온다.
  const raw = await res.text()
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    throw new Error(
      `api.stripe.com 이 JSON 이 아닌 응답을 돌려줬습니다 (HTTP ${res.status}). ` +
        `네트워크가 중간에서 가로채고 있을 수 있습니다:\n  ${raw.slice(0, 200)}`,
    )
  }

  if (!res.ok) throw new Error(`stripe ${method} ${path} ${res.status}: ${body?.error?.message ?? 'unknown'}`)
  return body
}

// Stripe 웹훅이 우리에게 보내야 하는 이벤트. supabase/functions/stripe-webhook/index.ts
// 의 switch 문과 같은 목록이어야 한다 — 여기 없으면 그 이벤트는 영영 안 온다.
const EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]

const LOOKUP_KEY = 'landediq_pro_monthly'
const WEBHOOK_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/stripe-webhook`

const priceUsd = planPriceUsd()

console.log(`모드      ${LIVE ? '\x1b[31mLIVE — 실제 청구됩니다\x1b[0m' : 'TEST'}`)
console.log(`가격      $${priceUsd}/월 (src/lib/billing/plan.ts)`)
console.log(`웹훅      ${WEBHOOK_URL}`)
console.log(`착지      ${SITE_URL}/app`)
console.log()

async function main() {
  // ── 1. Price (없으면 Product 부터) ────────────────────────────────
  // lookup_key 로 찾는다. 계정 안에서 유일하므로 두 번 돌려도 하나만 생긴다.
  let price = (await stripe('prices', { 'lookup_keys[]': LOOKUP_KEY, limit: '1' }, 'GET')).data?.[0]

  if (price) {
    console.log(`✓ Price 이미 있음   ${price.id}  ($${price.unit_amount / 100}/${price.recurring?.interval})`)
    if (price.unit_amount !== Math.round(priceUsd * 100)) {
      console.log(`  \x1b[33m경고: Stripe 는 $${price.unit_amount / 100} 인데 코드는 $${priceUsd} 입니다.\x1b[0m`)
      console.log(`  Stripe 의 Price 는 금액을 수정할 수 없습니다. 새 Price 를 만들고`)
      console.log(`  이 Price 의 lookup_key 를 떼어낸 뒤 다시 돌리세요.`)
    }
  } else {
    const product = await stripe('products', {
      name: 'LandedIQ Pro',
      description: 'Unlimited shipments and SKUs, full duty stack and landed cost.',
      'metadata[app]': 'landediq',
    })
    console.log(`+ Product 생성      ${product.id}`)
    price = await stripe('prices', {
      product: product.id,
      unit_amount: String(Math.round(priceUsd * 100)),
      currency: 'usd',
      'recurring[interval]': 'month',
      lookup_key: LOOKUP_KEY,
    })
    console.log(`+ Price 생성        ${price.id}  ($${priceUsd}/월)`)
  }

  // ── 2. 웹훅 엔드포인트 ────────────────────────────────────────────
  const existing = (await stripe('webhook_endpoints', { limit: '100' }, 'GET')).data.find((e) => e.url === WEBHOOK_URL)

  let webhookSecret = null
  if (existing && !RECREATE_WEBHOOK) {
    const missing = EVENTS.filter((e) => !existing.enabled_events.includes(e) && !existing.enabled_events.includes('*'))
    console.log(`✓ 웹훅 이미 있음    ${existing.id}${missing.length ? '' : '  (이벤트 6종 모두 등록됨)'}`)
    if (missing.length) {
      const params = { }
      EVENTS.forEach((e, i) => { params[`enabled_events[${i}]`] = e })
      await stripe(`webhook_endpoints/${existing.id}`, params)
      console.log(`  → 빠져 있던 이벤트 추가: ${missing.join(', ')}`)
    }
    console.log()
    console.log('\x1b[33m서명 시크릿(whsec_…)은 생성 시점에만 볼 수 있습니다.\x1b[0m')
    console.log('  이미 갖고 계시면 그대로 쓰시고, 모르면 다음으로 새로 만드세요:')
    console.log('    npm run stripe:setup -- --recreate-webhook')
  } else {
    if (existing) {
      await stripe(`webhook_endpoints/${existing.id}`, null, 'DELETE')
      console.log(`- 기존 웹훅 삭제    ${existing.id}`)
    }
    const params = { url: WEBHOOK_URL, description: 'LandedIQ subscription sync' }
    EVENTS.forEach((e, i) => { params[`enabled_events[${i}]`] = e })
    const hook = await stripe('webhook_endpoints', params)
    webhookSecret = hook.secret
    console.log(`+ 웹훅 생성         ${hook.id}  (이벤트 ${EVENTS.length}종)`)
  }

  // ── 3. 다음에 할 일 ───────────────────────────────────────────────
  console.log()
  console.log('─'.repeat(70))
  console.log('이제 Supabase 에 시크릿을 넣습니다. 아래를 그대로 붙여 넣으세요:')
  console.log()
  console.log(`supabase secrets set \\`)
  console.log(`  STRIPE_SECRET_KEY=${KEY.slice(0, 12)}… \\   ← 실제 키로 바꿔 주세요`)
  console.log(`  STRIPE_PRICE_ID=${price.id} \\`)
  console.log(`  STRIPE_WEBHOOK_SECRET=${webhookSecret ?? 'whsec_…  ← 위 안내 참고'} \\`)
  console.log(`  SITE_URL=${SITE_URL} \\`)
  console.log(`  --project-ref ${PROJECT_REF}`)
  console.log()
  console.log('그다음 마이그레이션을 SQL Editor 에 붙여 넣습니다:')
  console.log('  supabase/migrations/20260802150000_subscriptions.sql')
  console.log()
  console.log('적용 확인 (둘 다 t 여야 합니다):')
  console.log("  select to_regclass('public.subscriptions') is not null as table_ok,")
  console.log("         (select count(*) from pg_trigger")
  console.log("           where tgname in ('shipments_free_limit','items_free_limit')) = 2 as triggers_ok;")
  console.log()
  if (LIVE) {
    console.log('\x1b[31m라이브 키로 만들었습니다. 실제 카드가 청구됩니다.\x1b[0m')
  } else {
    console.log('테스트 모드입니다. 카드 4242 4242 4242 4242 로 한 바퀴 돌려 보고,')
    console.log('되면 라이브 키로 다시 실행하세요.')
  }
}

// 이 스크립트를 돌리는 사람은 Stripe 설정 중이지 Node 디버깅 중이 아니다.
// 스택 트레이스 대신 원인 한 줄만 보여준다.
main().catch((e) => {
  console.error(`\n실패: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
