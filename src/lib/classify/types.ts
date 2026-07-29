/** HTS 분류 (스펙 §5) — LLM은 후보 추정만, 계산에는 관여하지 않음 (§1-1) */

export const PROMPT_VERSION = 'v2-constrained'

/**
 * @deprecated 자동확정 판정에서 빠졌다.
 *
 * v2 측정에서 오답에도 confidence 85~91% 가 나와 needs_review 격리가 0건이었다
 * (§1-3 human-in-the-loop 이 무력). 이제 판정은 `ClassifyConsensus` 가 하고
 * confidence 는 UI 참고 표기로만 남는다. 이 값은 표기 색상 기준으로만 쓴다.
 */
export const CONFIDENCE_THRESHOLD = 0.7

export interface HtsCandidate {
  hts_code: string // 10자리 숫자
  confidence: number // 0~1
  rationale: string // 근거 1문장
}

export interface ClassifyItemInput {
  id: string
  product_name: string
  description_or_material: string
  origin_country: string
}

/** 2단계 분류 (a) 단계가 정리한 상품 속성 */
export interface ClassifyAttributes {
  material: string
  use: string
  construction: string
}

/**
 * k=3 투표 결과와 자동확정 판정 근거.
 *
 * auto_confirmed = 만장일치 AND 코드가 rate 원장에 실존.
 * 그 외는 전부 needs_review — 사람이 봐야 한다 (§1-3).
 */
export interface ClassifyConsensus {
  /** 만장일치 코드. 갈리면 null */
  code: string | null
  unanimous: boolean
  /** 투표별 선택 (보기 밖·무응답은 null) */
  votes: Array<string | null>
  in_ledger: boolean
  /** 보기 밖 코드를 낸 횟수 (재시도 후에도 실패한 건) */
  out_of_options: number
  status: 'auto_confirmed' | 'needs_review'
  reason: string
}

export interface ClassifyItemResult {
  item_id: string
  candidates: HtsCandidate[] // 투표에서 나온 서로 다른 선택들
  attributes?: ClassifyAttributes | null
  headings?: string[]
  consensus?: ClassifyConsensus | null
  /** 캐시에서 나온 결과인지 (LLM 재호출 없음) */
  cached?: boolean
}

export interface ClassifyRunMeta {
  model: string
  prompt_version: string
  temperature?: number
  votes?: number
  cache_hits?: number
}

export interface ClassifyBatchResult {
  results: ClassifyItemResult[]
  meta: ClassifyRunMeta
  raw_output: unknown
}

/** 후보 형식 검증: 10자리 코드·confidence 범위·최소 1개 */
export function sanitizeCandidates(raw: unknown): HtsCandidate[] {
  if (!Array.isArray(raw)) return []
  const out: HtsCandidate[] = []
  for (const c of raw.slice(0, 3)) {
    if (typeof c !== 'object' || c === null) continue
    const rec = c as Record<string, unknown>
    const code = String(rec.hts_code ?? '').replace(/\D/g, '')
    const conf = Number(rec.confidence)
    if (code.length !== 10 || !Number.isFinite(conf)) continue
    out.push({
      hts_code: code,
      confidence: Math.min(Math.max(conf, 0), 1),
      rationale: String(rec.rationale ?? '').slice(0, 300),
    })
  }
  return out.sort((a, b) => b.confidence - a.confidence)
}
