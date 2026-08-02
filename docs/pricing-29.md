# 유료 요금제 $29/월

무료 베타를 접고 돈을 받기 시작한다. 코드는 다 들어갔고, **Stripe 콘솔과
Supabase 시크릿은 사람이 넣어야 한다.** 그 절차가 이 문서다.

---

## 왜 $29 인가

목표는 **유료 회원 29명을 만들고 매각**하는 것이다. 그 목표를 고정하면 가격이
결과를 결정한다.

| 가격 | 29명 MRR | 연 ARR | 매각가 (ARR 2.5~4x) |
|---|---|---|---|
| $4.99 | $145 | $1,737 | $4,300 ~ 6,900 |
| $6.99 | $203 | $2,432 | $6,100 ~ 9,700 |
| **$29** | **$841** | **$10,092** | **$25,000 ~ 40,000** |
| $49 | $1,421 | $17,052 | $43,000 ~ 68,000 |

29명을 모으는 **광고비는 세 경우가 같다.** 낮은 가격은 전환을 높이지만, 아끼는
광고비($3,000 안팎)보다 잃는 매각가가 훨씬 크다.

$29 를 고른 이유는 그 사이다 — 회사 담당자가 결재 없이 카드로 지를 수 있는
상한선이고, 44명이면 $50,000 이 나오고, 나중에 위아래로 옮기기 쉽다.

**전환율은 아직 측정값이 아니다.** 유료 결제 전환은 한 번도 재본 적이 없다.
이 요금제의 첫 임무는 매출이 아니라 그 숫자를 만드는 것이다.

---

## 무엇이 무료이고 무엇이 유료인가

```
무료 (카드 불필요)    선적 2건 · SKU 25개
$29/월                선적·SKU 무제한
```

무료 범위는 **자기 제품을 직접 넣어 볼 수 있는 만큼**이다. 0 으로 두면 제품을
못 보고 나가고, 넉넉하면 돈을 낼 이유가 없어진다. 가입 즉시 샘플 선적 1건이
자동 생성되므로 실질 여유는 선적 1건이다.

값은 `src/lib/billing/plan.ts` 한 곳에 있다. DB 트리거가 같은 숫자를 갖고,
`tests/billing.plan.test.ts` 가 두 값을 대조한다 — 갈라지면 테스트가 죽는다.

### 한도는 화면이 아니라 DB 가 막는다

anon key 는 브라우저에 그대로 나가 있어서 비밀이 아니다. 화면에서만 막으면
PostgREST 를 직접 때려 무제한으로 쓸 수 있다. `enforce_free_limits()` 트리거가
insert 마다 센다.

RLS `with check` 를 안 쓴 이유가 있다 — 거기 들어간 `count(*)` 는 **같은 INSERT
문이 넣은 행을 보지 못한다.** SKU 는 500행씩 한 번에 들어가므로 25행 한도가 한
번의 대량 insert 로 통째로 뚫린다. transition table 을 쓰는 after-statement
트리거만 삽입된 행을 포함해 센다.

---

## 사람이 해야 할 일

### 0. 스크립트로 1~2단계를 한 번에

대시보드에서 손으로 해도 되지만, 두 군데가 조용히 틀리기 쉽다 — Price ID 대신
Product ID 를 복사하거나, 웹훅 이벤트를 하나 빠뜨리는 것. 둘 다 "설정은 다 한
것 같은데 안 되는" 증상이라 원인을 찾기 어렵다.

```bash
STRIPE_SECRET_KEY=sk_test_... npm run stripe:setup
```

Product · Price · 웹훅 엔드포인트를 만들고, 그대로 붙여 넣을
`supabase secrets set` 명령을 출력한다. 두 번 돌려도 중복이 생기지 않는다
(이미 있으면 그것을 쓴다). 금액은 `src/lib/billing/plan.ts` 에서 읽으므로
스크립트에 가격이 따로 적혀 있지 않다.

**테스트 키로 먼저 돌린다.** 확인되면 라이브 키로 다시 돌린다.

웹훅 서명 시크릿은 Stripe 가 **생성 시점에만** 보여준다. 이미 만들어 둔
엔드포인트가 있는데 시크릿을 모르면 `-- --recreate-webhook` 으로 새로 만든다.

아래 1~2단계는 이 스크립트가 하는 일을 손으로 할 때의 절차다.

### 1. Stripe 상품과 가격

Stripe 대시보드 → Product catalog → **Add product**

```
Name       LandedIQ Pro
Pricing    Recurring · Monthly · USD 29.00
```

저장하면 `price_...` 로 시작하는 **Price ID** 가 나온다. 이걸 쓴다.
Product ID(`prod_...`) 가 아니다 — 헷갈리면 체크아웃이 400 을 낸다.

### 2. 웹훅 엔드포인트

Stripe 대시보드 → Developers → Webhooks → **Add endpoint**

```
URL      https://hwcfjxwdmmlydnrfyjqk.supabase.co/functions/v1/stripe-webhook
```

보낼 이벤트 (이 여섯 개만). `supabase/functions/stripe-webhook/index.ts` 의
switch 문과 같은 목록이어야 한다 — 여기 없는 이벤트는 영영 안 온다:

```
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
customer.subscription.paused
customer.subscription.resumed
```

만들면 **Signing secret** (`whsec_...`) 이 나온다. 이게 이 엔드포인트의 유일한
자물쇠다 — 없으면 아무나 `status: active` 를 POST 해서 결제 없이 유료 기능을
켤 수 있다.

### 3. Supabase 시크릿

```bash
supabase secrets set \
  STRIPE_SECRET_KEY=sk_live_... \
  STRIPE_PRICE_ID=price_... \
  STRIPE_WEBHOOK_SECRET=whsec_... \
  SITE_URL=https://www.landediq.app \
  --project-ref hwcfjxwdmmlydnrfyjqk
```

넷 중 하나라도 빠지면 체크아웃이 500 과 함께 **무엇이 없는지 말한다.** 조용히
실패하지 않는다.

### 4. 마이그레이션 적용

저장소는 Supabase 에 연결돼 있지 않다. SQL Editor 에 직접 붙여 넣는다:

```
supabase/migrations/20260802150000_subscriptions.sql
```

적용 확인 — 이 쿼리가 `t` 를 돌려주면 트리거까지 들어간 것이다:

```sql
select
  to_regclass('public.subscriptions') is not null              as table_ok,
  (select count(*) from pg_trigger
    where tgname in ('shipments_free_limit', 'items_free_limit')) = 2 as triggers_ok;
```

### 5. Google Ads 전환 액션

지금 `public/ads.js` 의 `subscribe` 는 **가입 라벨을 같이 쓴다.** 그러면 Ads 가
$29 결제와 이메일 수집을 구분하지 못하고, 입찰이 계속 이메일에 최적화된다.

Ads → 목표 → 전환 → **새 전환 액션** (웹사이트, 카테고리 "구매", 값 29 USD) 을
만들고 나온 라벨로 `ads.js` 의 `SUBSCRIBE` 를 바꾼다.

---

## 배포 순서

순서가 중요하다. 거꾸로 하면 결제는 되는데 반영이 안 되는 구간이 생긴다.

1. **마이그레이션** — 테이블이 없으면 웹훅이 저장할 곳이 없다
2. **시크릿** — 함수가 뜨자마자 읽는다
3. **코드 머지** → `deploy-functions` 워크플로가 두 함수를 자동 배포한다
   (`stripe-webhook` 은 `--no-verify-jwt` 로 나간다 — Stripe 는 Supabase JWT 가 없다)
4. **Stripe 웹훅 엔드포인트 등록** — 함수가 뜬 뒤에 해야 첫 이벤트가 안 버려진다

## 검증

Stripe **테스트 모드**로 먼저 한 바퀴 돈다. 테스트 키·테스트 Price ID·테스트
웹훅 시크릿을 넣고 카드 `4242 4242 4242 4242` 로 결제한다.

| 확인할 것 | 어떻게 |
|---|---|
| 체크아웃이 열리는가 | 앱에서 `Subscribe — $29/mo` |
| 상태가 반영되는가 | 결제 후 배너가 `Pro · $29/mo` 로 바뀐다 |
| 웹훅이 도착했는가 | Stripe → Webhooks → 해당 엔드포인트의 최근 전송 200 |
| 한도가 실제로 막는가 | 무료 계정으로 선적 3건째 생성 시도 |
| 서명 검증이 도는가 | `npm run check` (tests/billing.stripeSignature.test.ts) |

결제 후 화면이 몇 초간 `activating…` 인 것은 정상이다 — Stripe 는 사용자를
먼저 돌려보내고 웹훅은 나중에 온다. 20초 안에 안 켜지면
`subscription_activation_slow` 이벤트가 남는다.

---

## 측정

전환은 `subscription_started` 다. 앱 번들에 이 이벤트가 없으면
`npm run build` 가 실패한다 (`scripts/check-build.ts`).

```
checkout_started               결제창 열기
checkout_failed                열기 실패 (사유 포함)
subscription_started           결제 완료 ← 전환
subscription_activation_slow   20초 안에 웹훅이 안 옴
checkout_abandoned             결제창에서 취소
plan_limit_hit                 무료 한도에 부딪힘
```

`plan_limit_hit` 이 많은데 `checkout_started` 가 적으면 한도는 맞게 걸렸는데
가격이 안 팔리는 것이다. 그건 한도를 늘려서 풀 문제가 아니다.

읽는 쿼리는 `supabase/funnel.sql` 7번.

---

## 아직 안 된 것

- **해지·결제수단 변경 화면이 없다.** 지금은 Stripe 가 보내는 이메일의 링크로만
  가능하다. 유료 회원이 생기면 Billing Portal 을 붙여야 한다.
- **$19 를 약속했던 사람들.** 사이트가 "Planned Starter price: $19/month" 를 네
  페이지에서 말하고 있었다. 그 문구를 보고 이메일을 남긴 사람이 있으면 $19 로
  받는 것이 맞다 (Stripe 쿠폰 34% 로 처리 가능). 대상자 수:
  ```sql
  select count(*) from public.leads where created_at < '2026-08-02';
  ```
- **연간 요금제가 없다.** 월 결제만 있다. 연간은 이탈을 낮추고 매각 시
  유지율 근거가 되지만, 지금은 월 전환율부터 재는 게 먼저다.
