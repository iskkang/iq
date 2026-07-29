/**
 * 리뷰 큐 정렬.
 *
 * 500건을 다 볼 수는 없다. 목표는 **상위 N건만 봐도 금액 노출의 대부분을 덮는 것**이다.
 * 정렬 우선순위 (계획서 지시):
 *   ① 모델 불일치 (haiku × sonnet 이 다른 코드를 냈다)
 *   ② (a)단계 호 후보가 2개 이상 (경합이 있었다 — 소호 오답의 주요 원인)
 *   ③ duty 금액 큰 순 (unit_duty × units)
 *
 * ①은 **정렬 신호일 뿐 자동확정 게이트가 아니다.** 두 모델이 일치해도 둘 다 틀릴 수 있다
 * (골든 v3: BAG-01 은 haiku·sonnet 모두 5/5 오답). 일치는 "덜 급하다"는 뜻이지
 * "맞다"는 뜻이 아니며, 확인 전에는 여전히 suggested 다.
 */
import type { ClassifyConsensus } from './types'

export interface ReviewCandidate {
  sku: string
  /** 주 모델이 제안한 코드 */
  hts_code: string | null
  /** 교차검증 모델이 제안한 코드. null = 교차검증 미실행 */
  cross_check_code?: string | null
  /** (a)단계 호 후보 */
  headings?: string[]
  consensus?: ClassifyConsensus | null
  /** 단위당 duty USD */
  duty_per_unit: number
  units: number
  /** 이미 사람이 확인했으면 큐에서 뺀다 */
  reviewed?: boolean
}

export interface RankedReviewItem extends ReviewCandidate {
  /** 선적 전체 duty 중 이 SKU 가 차지하는 금액 */
  duty_total: number
  /** ① 모델 불일치 */
  models_disagree: boolean
  /** ② 호 후보 2개 이상 */
  heading_contested: boolean
  /** ③ 순위 (1부터) */
  rank: number
  /** 왜 이 순위인지 — UI 표시용 */
  reasons: string[]
}

/** 6자리(소호)까지 같으면 같은 판단으로 본다 — 통계 suffix 차이는 duty 에 거의 영향이 없다 */
function sameSubheading(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return a.slice(0, 6) === b.slice(0, 6)
}

export function rankReviewQueue(items: ReviewCandidate[]): RankedReviewItem[] {
  const enriched = items
    .filter((it) => !it.reviewed)
    .map((it) => {
      const models_disagree =
        it.cross_check_code != null && it.hts_code != null && !sameSubheading(it.hts_code, it.cross_check_code)
      const heading_contested = (it.headings?.length ?? 0) >= 2
      const duty_total = it.duty_per_unit * it.units
      const reasons: string[] = []
      if (models_disagree) reasons.push(`모델 불일치 (${it.hts_code?.slice(0, 6)} vs ${it.cross_check_code?.slice(0, 6)})`)
      if (heading_contested) reasons.push(`호 경합 (${it.headings!.join(', ')})`)
      if (it.consensus && !it.consensus.unanimous) reasons.push('투표 불일치')
      if (it.consensus && !it.consensus.in_ledger) reasons.push('원장에 base MFN 없음')
      return { ...it, duty_total, models_disagree, heading_contested, reasons, rank: 0 }
    })

  enriched.sort((a, b) => {
    // ① 모델 불일치 우선
    if (a.models_disagree !== b.models_disagree) return a.models_disagree ? -1 : 1
    // ② 호 후보 2개 이상
    if (a.heading_contested !== b.heading_contested) return a.heading_contested ? -1 : 1
    // ③ duty 금액 큰 순
    if (b.duty_total !== a.duty_total) return b.duty_total - a.duty_total
    return a.sku.localeCompare(b.sku)
  })

  return enriched.map((it, i) => ({ ...it, rank: i + 1 }))
}

/**
 * 상위 N건이 전체 duty 노출의 몇 %를 덮는지.
 * "500건 중 상위 20건만 봐도 대부분 덮인다"를 실제 데이터로 확인하는 용도.
 */
export function coverageOfTopN(ranked: RankedReviewItem[], n: number): {
  covered_usd: number
  total_usd: number
  pct: number
} {
  const total = ranked.reduce((a, r) => a + r.duty_total, 0)
  const covered = ranked.slice(0, n).reduce((a, r) => a + r.duty_total, 0)
  return { covered_usd: covered, total_usd: total, pct: total > 0 ? covered / total : 0 }
}
