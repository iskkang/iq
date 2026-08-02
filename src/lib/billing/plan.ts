/**
 * 요금제 단일 소스.
 *
 * ── 왜 상수로 두는가 ─────────────────────────────────────────────
 * 가격 문자열은 랜딩·앱·문서·광고 문안 네 곳에 나온다. 예전에 $29/$79/$149
 * 3단 요금제를 걷어냈을 때 페이지마다 다른 값이 남았고, 그래서
 * `scripts/check-build.ts` 에 "폐기한 가격이 다시 나타나면 빌드 실패" 가드가
 * 생겼다 (7d4111d). 값을 여기 한 곳에 두고 가드가 이 값을 읽게 한다.
 *
 * 무료 한도는 **서버에서도 강제된다** — DB 트리거가 같은 숫자를 갖는다
 * (`supabase/migrations/20260802150000_subscriptions.sql`). 두 값이 갈라지면
 * 화면은 막는데 API 로는 뚫리거나 그 반대가 된다. plan.test.ts 가 대조한다.
 */
export const PLAN = {
  priceUsd: 29,
  currency: 'usd',
  interval: 'month',
  /** 화면·문서에 그대로 쓰는 표기 */
  label: '$29/mo',
  /**
   * 로그인만 한 사용자가 결제 없이 쓸 수 있는 범위.
   *
   * 0 으로 두면 제품을 못 보고 나가고, 넉넉하면 돈을 낼 이유가 없어진다.
   * 샘플 선적 1건이 가입 즉시 자동 생성되므로(§MVP) 실질 여유는 선적 1건이다.
   */
  free: { shipments: 2, items: 25 },
} as const

/** 결제 상태 중 "쓸 수 있음" 으로 치는 값 — DB 함수 workspace_is_paid 와 같은 목록 */
export const ACTIVE_STATUSES = ['active', 'trialing'] as const

export interface Subscription {
  status: string
  /** 현재 결제 주기 종료 시각 (ISO). null 이면 미상 */
  current_period_end: string | null
  /** 주기 말에 해지 예약됨 */
  cancel_at_period_end: boolean
}

/** 지금 유료인가. 만료 시각이 지났으면 status 와 무관하게 false */
export function isActive(sub: Subscription | null, now: Date = new Date()): boolean {
  if (!sub) return false
  if (!(ACTIVE_STATUSES as readonly string[]).includes(sub.status)) return false
  if (!sub.current_period_end) return true
  return new Date(sub.current_period_end).getTime() > now.getTime()
}
