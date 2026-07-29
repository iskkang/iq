/**
 * 분류 결과 → items.classification_status 판정 (스펙 §1-3).
 *
 * v1 은 `top.confidence >= 0.7` 로 판정했다. 골든 v2 실측에서 오답 5건이 전부
 * 85~91% 로 자동확정됐고 needs_review 는 0건이었다 — human-in-the-loop 이
 * 사실상 작동하지 않았다.
 *
 * v2 판정: Edge Function 이 낸 consensus(k=3 만장일치 + 원장 실존) 를 그대로 쓴다.
 * confidence 는 판정에서 완전히 빠지고 UI 참고 표기로만 남는다.
 */
import type { ClassifyItemResult } from './types'

export type ClassificationStatus = 'pending' | 'needs_review' | 'auto_confirmed' | 'user_confirmed'

export function resolveStatus(r: ClassifyItemResult): ClassificationStatus {
  if (r.candidates.length === 0) return 'pending'
  // consensus 가 없으면(구버전 응답·mock 등) 안전한 쪽으로 — 사람이 본다
  return r.consensus?.status === 'auto_confirmed' ? 'auto_confirmed' : 'needs_review'
}

/** 리포트·UI 에 보여줄 판정 사유 한 줄 */
export function statusReason(r: ClassifyItemResult): string {
  if (r.candidates.length === 0) return 'No candidates returned'
  if (!r.consensus) return 'No consensus data — needs review'
  return r.consensus.reason
}
