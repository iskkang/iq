/**
 * Stripe Checkout 세션 생성 ($29/월 구독).
 * 배포: supabase functions deploy stripe-checkout
 *
 * ── 왜 SDK 없이 fetch 인가 ────────────────────────────────────────
 * 이 저장소의 다른 Edge Function 과 같은 이유다 — `npm run check:edge` 가
 * deno 타입체크로 두 함수를 실제로 검사하는데, 의존성이 늘수록 그 검사가
 * 네트워크에 묶인다. Stripe REST 는 form-encoded POST 두 번이면 끝난다.
 *
 * ── 인증 ──────────────────────────────────────────────────────────
 * 호출자의 JWT 로 사용자를 확인하고, **워크스페이스는 서버가 정한다.**
 * 클라이언트가 workspace_id 를 넘기게 하면 남의 워크스페이스에 결제를
 * 붙일 수 있다.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

const env = (k: string) => Deno.env.get(k) ?? ''

async function stripe(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env('STRIPE_SECRET_KEY')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  })
  const body = (await res.json()) as Record<string, unknown>
  if (!res.ok) {
    const err = body.error as { message?: string } | undefined
    throw new Error(`stripe ${path} ${res.status}: ${err?.message ?? 'unknown error'}`)
  }
  return body
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    // 설정이 빠진 채로 도는 것이 이 저장소가 반복해서 당한 실패다.
    // 조용히 500 을 내지 말고 무엇이 없는지 말한다.
    for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID']) {
      if (!env(k)) return json({ error: `${k} is not configured on the function` }, 500)
    }

    const authHeader = req.headers.get('Authorization') ?? ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Sign in first.' }, 401)

    const asUser = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    })
    const { data: userData, error: userErr } = await asUser.auth.getUser()
    if (userErr || !userData.user) return json({ error: 'Sign in first.' }, 401)
    const user = userData.user

    const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    })

    // 워크스페이스는 계정당 1개다 (0001_init.sql: unique (owner)).
    const { data: ws, error: wsErr } = await admin
      .from('workspaces')
      .select('id')
      .eq('owner', user.id)
      .maybeSingle()
    if (wsErr) throw new Error(`workspace lookup failed: ${wsErr.message}`)
    if (!ws) return json({ error: 'No workspace for this account yet. Open the app once, then try again.' }, 409)

    // 이미 유료면 결제창을 또 열지 않는다 — 두 번 결제되는 사고를 막는다.
    const { data: existing, error: subErr } = await admin
      .from('subscriptions')
      .select('stripe_customer_id, status, current_period_end')
      .eq('workspace_id', ws.id)
      .maybeSingle()
    if (subErr) throw new Error(`subscription lookup failed: ${subErr.message}`)

    if (
      existing &&
      ['active', 'trialing'].includes(existing.status as string) &&
      (!existing.current_period_end || new Date(existing.current_period_end as string) > new Date())
    ) {
      return json({ error: 'This workspace is already subscribed.', already_subscribed: true }, 409)
    }

    let customerId = existing?.stripe_customer_id as string | undefined
    if (!customerId) {
      const customer = await stripe('customers', {
        email: user.email ?? '',
        'metadata[workspace_id]': ws.id,
        'metadata[user_id]': user.id,
      })
      customerId = customer.id as string
      // 고객 ID 를 먼저 저장한다. 여기서 실패하면 결제창을 열지 않는다 —
      // 열어 두고 저장에 실패하면 결제는 됐는데 우리가 누구인지 모른다.
      const { error: insErr } = await admin
        .from('subscriptions')
        .upsert({ workspace_id: ws.id, stripe_customer_id: customerId }, { onConflict: 'workspace_id' })
      if (insErr) throw new Error(`could not record customer: ${insErr.message}`)
    }

    const site = env('SITE_URL') || 'https://www.landediq.app'
    const session = await stripe('checkout/sessions', {
      mode: 'subscription',
      customer: customerId,
      'line_items[0][price]': env('STRIPE_PRICE_ID'),
      'line_items[0][quantity]': '1',
      success_url: `${site}/app?checkout=success`,
      cancel_url: `${site}/app?checkout=cancelled`,
      allow_promotion_codes: 'true',
      'metadata[workspace_id]': ws.id,
      // 구독 자체에도 남긴다. 나중에 오는 subscription.* 이벤트는 세션을
      // 참조하지 않으므로, 여기에 없으면 고객 ID 로만 역추적해야 한다.
      'subscription_data[metadata][workspace_id]': ws.id,
    })

    return json({ url: session.url })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
