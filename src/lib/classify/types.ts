/** HTS 분류 (스펙 §5) — LLM은 후보 추정만, 계산에는 관여하지 않음 (§1-1) */

export const PROMPT_VERSION = 'v1'
/** 이 값 미만이면 자동 확정 금지 → needs_review (§1-3, §5) */
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

export interface ClassifyItemResult {
  item_id: string
  candidates: HtsCandidate[] // 2~3개, confidence 내림차순
}

export interface ClassifyRunMeta {
  model: string
  prompt_version: string
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
