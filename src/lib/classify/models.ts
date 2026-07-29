/**
 * 분류 모델 구성 + API 비용 단가.
 *
 * 주 모델은 **sonnet 고정**이다. 골든 v3 에서 haiku 는 5회 평균 5.2/10 (기준 7/10) 로
 * 이 제품에 쓸 수 없었고, sonnet 은 8.0/10 (5회 8–8, 재현 10/10) 이었다.
 * 비용은 모델 다운그레이드가 아니라 캐시로 방어한다.
 *
 * haiku 는 **교차검증 전용**이다 — 주 모델과 다른 코드를 내면 그 SKU 를 리뷰 큐
 * 최상위로 올린다. 자동확정 게이트로는 절대 쓰지 않는다 (두 모델이 일치해도
 * 둘 다 틀릴 수 있다: 골든 v3 BAG-01 은 양쪽 모두 5/5 오답).
 */

export const PRIMARY_MODEL = 'claude-sonnet-4-6'
export const CROSS_CHECK_MODEL = 'claude-haiku-4-5'

/** USD per million tokens (2026-06 기준 — 요금 개정 시 갱신) */
export interface ModelPricing {
  input: number
  output: number
  /** 캐시 읽기 — 기본 입력가의 약 0.1배 */
  cache_read: number
  /** 캐시 쓰기 (5분 TTL) — 기본 입력가의 1.25배 */
  cache_write_5m: number
  /** 캐시 쓰기 (1시간 TTL) — 기본 입력가의 2배 */
  cache_write_1h: number
  /** 캐시 가능한 최소 프리픽스 토큰 수 — 이보다 짧으면 조용히 캐시되지 않는다 */
  cache_min_tokens: number
}

export const PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-6': {
    input: 3.0,
    output: 15.0,
    cache_read: 0.3,
    cache_write_5m: 3.75,
    cache_write_1h: 6.0,
    cache_min_tokens: 1024,
  },
  'claude-haiku-4-5': {
    input: 1.0,
    output: 5.0,
    cache_read: 0.1,
    cache_write_5m: 1.25,
    cache_write_1h: 2.0,
    // haiku 4.5 는 최소 프리픽스가 4096 — sonnet(1024)보다 4배 크다.
    // 짧은 프롬프트는 캐시가 조용히 안 걸리므로 비용 모델에서 주의.
    cache_min_tokens: 4096,
  },
}

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** 호출 1건의 USD 비용 */
export function costOf(model: string, u: TokenUsage): number {
  const p = PRICING[model]
  if (!p) throw new Error(`pricing 미등록 모델: ${model}`)
  const M = 1_000_000
  return (
    (u.input_tokens * p.input) / M +
    (u.output_tokens * p.output) / M +
    ((u.cache_read_input_tokens ?? 0) * p.cache_read) / M +
    ((u.cache_creation_input_tokens ?? 0) * p.cache_write_5m) / M
  )
}

export const emptyUsage = (): TokenUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens:
      (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
  }
}

/**
 * 요금제 마진 판정.
 * Starter $29 / 월 50 SKU 기준으로 SKU당 비용이 얼마여야 하는지.
 */
export interface PlanMargin {
  plan: string
  price_usd: number
  sku_quota: number
  cost_per_sku: number
  api_cost_total: number
  gross_margin_pct: number
}

export const PLANS = [
  { plan: 'Starter', price_usd: 29, sku_quota: 50 },
  { plan: 'Growth', price_usd: 79, sku_quota: 500 },
  { plan: 'Pro', price_usd: 149, sku_quota: 2000 }, // 무제한 대신 실측용 상한
]

export function planMargins(costPerSku: number): PlanMargin[] {
  return PLANS.map((p) => {
    const api = costPerSku * p.sku_quota
    return {
      ...p,
      cost_per_sku: costPerSku,
      api_cost_total: api,
      gross_margin_pct: (p.price_usd - api) / p.price_usd,
    }
  })
}
