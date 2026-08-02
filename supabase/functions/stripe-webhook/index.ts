/**
 * Stripe 웹훅 — 결제 상태를 subscriptions 에 반영한다.
 * 배포: supabase functions deploy stripe-webhook --no-verify-jwt
 *
 * ── --no-verify-jwt 가 필요한 이유, 그리고 그 대가 ────────────────
 * Stripe 는 Supabase JWT 를 갖고 있지 않다. 그래서 이 엔드포인트는 **인증 없이
 * 열려 있다.** 유일한 자물쇠가 서명 검증이고, 그게 없으면 아무나
 * `{"type":"customer.subscription.updated","status":"active"}` 를 보내
 * 결제 없이 유료 기능을 켤 수 있다.
 *
 * 검증 로직은 `src/lib/billing/stripeSignature.ts` 에 순수 함수로 있고
 * tests/billing.stripeSignature.test.ts 가 위조·변조·재전송을 확인한다.
 *
 * ── 응답 코드 규약 ────────────────────────────────────────────────
 * Stripe 는 2xx 가 아니면 재시도한다. 그래서 "우리가 안 다루는 이벤트" 는
 * 200 으로 받아 넘기고, 400/500 은 **정말 다시 보내야 할 때만** 낸다.
 * 모르는 이벤트에 400 을 내면 Stripe 가 며칠간 계속 두드린다.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { verifyStripeSignature } from '../../../src/lib/billing/stripeSignature.ts'

const env = (k: string) => Deno.env.get(k) ?? ''

const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } })

interface StripeSubscription {
  id: string
  customer: string
  status: string
  cancel_at_period_end?: boolean
  current_period_end?: number
  items?: { data?: Array<{ price?: { id?: string } }> }
  metadata?: Record<string, string>
}

interface StripeSession {
  customer: string
  subscription?: string
  metadata?: Record<string, string>
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return text('method not allowed', 405)

  // **원문 바이트 그대로** 읽는다. 파싱 후 재직렬화하면 서명이 절대 안 맞는다.
  const raw = await req.text()

  const verdict = await verifyStripeSignature({
    rawBody: raw,
    header: req.headers.get('stripe-signature'),
    secret: env('STRIPE_WEBHOOK_SECRET'),
    nowSeconds: Math.floor(Date.now() / 1000),
  })
  if (!verdict.ok) {
    console.error(`webhook rejected: ${verdict.reason}`)
    // 재전송해도 결과가 같으므로 400 이다. 단 missing_secret 은 우리 설정
    // 사고이므로 500 으로 내서 Stripe 가 다시 보내게 한다 (고치면 살아난다).
    return text(verdict.reason, verdict.reason === 'missing_secret' ? 500 : 400)
  }

  let event: { id?: string; type?: string; data?: { object?: unknown } }
  try {
    event = JSON.parse(raw)
  } catch {
    return text('invalid json', 400)
  }

  const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  })

  /** 고객 ID 로 워크스페이스를 찾는다. checkout 함수가 미리 행을 만들어 둔다. */
  async function workspaceFor(customerId: string, hint?: string): Promise<string | null> {
    if (hint) return hint
    const { data } = await admin
      .from('subscriptions')
      .select('workspace_id')
      .eq('stripe_customer_id', customerId)
      .maybeSingle()
    return (data?.workspace_id as string) ?? null
  }

  async function applySubscription(sub: StripeSubscription, hint?: string) {
    const ws = await workspaceFor(sub.customer, hint ?? sub.metadata?.workspace_id)
    if (!ws) {
      // 우리가 만들지 않은 고객이다. 조용히 넘기면 결제됐는데 반영이 안 된
      // 상태를 아무도 모른다 — 로그에 남기고 200 으로 받는다 (재전송해도 같다).
      console.error(`no workspace for stripe customer ${sub.customer} (sub ${sub.id})`)
      return
    }
    const { error } = await admin.from('subscriptions').upsert(
      {
        workspace_id: ws,
        stripe_customer_id: sub.customer,
        stripe_subscription_id: sub.id,
        status: sub.status,
        price_id: sub.items?.data?.[0]?.price?.id ?? null,
        current_period_end: sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : null,
        cancel_at_period_end: sub.cancel_at_period_end ?? false,
      },
      { onConflict: 'workspace_id' },
    )
    if (error) throw new Error(`upsert failed: ${error.message}`)
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data?.object as StripeSession
        if (!session?.subscription) break // 일회성 결제 — 이 제품엔 없다
        // 세션에는 status 가 없다. 구독을 조회해서 진짜 상태를 쓴다.
        const res = await fetch(`https://api.stripe.com/v1/subscriptions/${session.subscription}`, {
          headers: { Authorization: `Bearer ${env('STRIPE_SECRET_KEY')}` },
        })
        if (!res.ok) throw new Error(`could not fetch subscription ${session.subscription}: ${res.status}`)
        await applySubscription((await res.json()) as StripeSubscription, session.metadata?.workspace_id)
        break
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed': {
        await applySubscription(event.data?.object as StripeSubscription)
        break
      }
      default:
        // 구독하지 않은 이벤트 종류. 200 으로 받아야 재시도가 안 붙는다.
        break
    }
  } catch (e) {
    // 여기 실패는 우리 쪽 일시 장애일 수 있다. 500 을 내면 Stripe 가 재시도한다.
    console.error(`webhook handler failed (${event.type}): ${e instanceof Error ? e.message : String(e)}`)
    return text('handler failed', 500)
  }

  return text('ok')
})
