/**
 * HTS 상태 — 2단계 (스펙 §1-3).
 *
 *   pending        분류 전 (CSV 만 올라온 상태, HTS 없음)
 *   suggested      모델이 제안했고 **사람이 확인하지 않았다**
 *   user_confirmed 사람이 확정했다
 *
 * auto_confirmed 는 삭제됐다. 골든 v3 실측에서 오답의 needs_review 격리율이 0% 였다 —
 * temperature 0 이면 k=3 투표가 94~100% 만장일치가 되고 (b)단계가 실제 라인만 주므로
 * "원장 실존"도 상시 참이라, 자동확정 조건이 사실상 상수였다. 자동으로 "확인됨"을
 * 붙일 근거가 없으므로 사람 확인 전에는 전부 suggested 로 둔다.
 *
 * 교차검증(haiku×sonnet)은 리뷰 큐 **정렬**에만 쓰고 자동확정 게이트로는 쓰지 않는다.
 */
import type { ClassifyItemResult } from './types'

export type ClassificationStatus = 'pending' | 'suggested' | 'user_confirmed'

/** 미확정 건에 리포트·CSV 로 노출할 표기 */
export const UNREVIEWED_LABEL = 'unreviewed'

export function resolveStatus(r: ClassifyItemResult): ClassificationStatus {
  return r.candidates.length === 0 ? 'pending' : 'suggested'
}

/** 사람이 확인했는가 — 리포트의 unreviewed 표기 기준 */
export function isReviewed(status: ClassificationStatus): boolean {
  return status === 'user_confirmed'
}

/** 리포트·UI 에 보여줄 판정 사유 한 줄 */
export function statusReason(r: ClassifyItemResult): string {
  if (r.candidates.length === 0) return 'No candidates returned'
  if (!r.consensus) return 'Model suggestion — not reviewed'
  return r.consensus.reason
}
