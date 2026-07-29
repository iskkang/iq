/**
 * 2단계 선택형 HTS 분류 파이프라인 (자유 생성 금지).
 *
 *   (a) 상품 속성(소재·용도·구성) 정리 → 4자리 호 후보 1~3개
 *   (b) 해당 호의 USITC 실제 라인(코드+설명)만 보기로 제시 → 그중에서만 선택 + 갈림 근거 1줄
 *       보기 밖 코드가 나오면 실패 처리하고 1회 재시도
 *
 * 이 파일은 Edge Function(Deno) 과 로컬 골든 러너(Node) 가 함께 쓴다.
 * 프롬프트가 두 벌이 되면 §검증1 점수가 무의미해지므로 원본은 여기 하나뿐이다.
 * 따라서 Deno·Node 양쪽에서 도는 표준 API 만 쓴다 (fetch, crypto.subtle).
 */

export const PROMPT_VERSION = 'v2-constrained'
/** 결정론 확보 — 같은 입력에 같은 답 (요구사항 2) */
export const TEMPERATURE = 0
/** 만장일치 투표 수 (요구사항 3) */
export const VOTES = 3
/** 한 호당 보기로 제시할 최대 라인 수 — 프롬프트 폭주 방지 */
export const MAX_LINES_PER_HEADING = 60

export interface ClassifyInput {
  id: string
  product_name: string
  description_or_material: string
  origin_country: string
}

export interface CatalogLine {
  code: string
  heading: string
  description: string
}

/** 카탈로그 접근 — Edge 는 Supabase 테이블, 로컬은 JSON 파일로 구현 */
export interface Catalog {
  linesFor(headings: string[]): Promise<CatalogLine[]>
}

export interface Attributes {
  material: string
  use: string
  construction: string
}

export interface StageAResult {
  item_id: string
  attributes: Attributes
  headings: string[]
}

export interface Selection {
  item_id: string
  hts_code: string
  rationale: string
  /** 모델이 스스로 매긴 확신도 — 참고 표기용으로 강등됨 (요구사항 3) */
  confidence: number
}

export interface VoteOutcome {
  item_id: string
  attributes: Attributes | null
  headings: string[]
  /** 투표별 선택 코드 (무효표는 null) */
  votes: Array<string | null>
  /** 만장일치 코드. 갈리면 null */
  consensus: string | null
  unanimous: boolean
  /** 보기 밖 코드를 낸 횟수 (재시도 포함) */
  out_of_options: number
  selections: Selection[]
}

// ── 프롬프트 ──────────────────────────────────────────────────

export const STAGE_A_SYSTEM = `You are a U.S. HTS classification assistant. This is STEP 1 of 2.

Your ONLY job in this step: describe the product's classification-relevant attributes, then name 1-3 candidate 4-digit HTS headings.

Rules:
- Do NOT output 6-digit or 10-digit codes. Headings are exactly 4 digits.
- attributes.material: what it is physically made of (the constituent material that governs classification).
- attributes.use: what it is used for, and where (household, industrial, sport, etc.).
- attributes.construction: how it is made/assembled if that matters (knitted vs woven, vacuum-insulated, double-wall, molded, etc.).
- Order headings most-likely first. Include an alternative heading when the material and the use point to different chapters — that tension is exactly what step 2 resolves.
- Think about whether a specific heading (by function) beats a general one (by material). Vacuum vessels, sports equipment, and lamps are classified by what they ARE, not what they are made of.

Respond with ONLY valid JSON, no markdown fences:
{"results":[{"item_id":"...","attributes":{"material":"...","use":"...","construction":"..."},"headings":["1234","5678"]}]}`

export const STAGE_B_SYSTEM = `You are a U.S. HTS classification assistant. This is STEP 2 of 2.

You are given a product and a CLOSED LIST of real HTS lines taken from the official USITC tariff schedule.

ABSOLUTE RULE: you MUST return one of the listed codes, copied exactly. You may not invent, modify, or pad a code. If none seems perfect, choose the closest listed line — a listed "Other" line is always better than an unlisted code.

For each product return:
- hts_code: exactly one code copied from that product's option list.
- rationale: ONE sentence naming the attribute (material, use, or construction) that decided it BETWEEN the close options. Do not restate the product name.
- confidence: 0 to 1. Base it on how cleanly the product matches the chosen line versus the runner-up. If two listed lines are nearly equally defensible, stay below 0.7.

Respond with ONLY valid JSON, no markdown fences:
{"results":[{"item_id":"...","hts_code":"1234567890","rationale":"...","confidence":0.85}]}`

// ── 프롬프트 조립 ─────────────────────────────────────────────

export function stageAUser(items: ClassifyInput[]): string {
  return `Classify these products (step 1 — attributes and 4-digit headings):\n${JSON.stringify(
    items.map((i) => ({
      item_id: i.id,
      product_name: i.product_name,
      description_or_material: i.description_or_material,
      origin_country: i.origin_country,
    })),
    null,
    2,
  )}`
}

export function stageBUser(
  items: ClassifyInput[],
  stageA: Map<string, StageAResult>,
  linesByHeading: Map<string, CatalogLine[]>,
): string {
  const blocks = items.map((item) => {
    const a = stageA.get(item.id)
    const headings = a?.headings ?? []
    const options: string[] = []
    for (const h of headings) {
      for (const line of (linesByHeading.get(h) ?? []).slice(0, MAX_LINES_PER_HEADING)) {
        options.push(`  ${line.code}  ${line.description}`)
      }
    }
    return [
      `--- item_id: ${item.id}`,
      `product: ${item.product_name}`,
      `description/material: ${item.description_or_material}`,
      a ? `step-1 attributes: material=${a.attributes.material}; use=${a.attributes.use}; construction=${a.attributes.construction}` : '',
      `OPTIONS (choose exactly one code from this list):`,
      options.length > 0 ? options.join('\n') : '  (no options available)',
    ]
      .filter(Boolean)
      .join('\n')
  })
  return `Step 2 — pick one listed code per product.\n\n${blocks.join('\n\n')}`
}

// ── 응답 파싱 ─────────────────────────────────────────────────

export function extractJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end < 0) throw new Error('no JSON object in model output')
  return JSON.parse(cleaned.slice(start, end + 1))
}

export function parseStageA(parsed: unknown): Map<string, StageAResult> {
  const out = new Map<string, StageAResult>()
  const results = (parsed as { results?: unknown[] })?.results ?? []
  for (const r of results as Array<Record<string, unknown>>) {
    const id = String(r.item_id ?? '')
    if (!id) continue
    const attrs = (r.attributes ?? {}) as Record<string, unknown>
    const headings = (Array.isArray(r.headings) ? r.headings : [])
      .map((h) => String(h).replace(/\D/g, ''))
      .filter((h) => h.length === 4)
      .slice(0, 3)
    out.set(id, {
      item_id: id,
      attributes: {
        material: String(attrs.material ?? '').slice(0, 200),
        use: String(attrs.use ?? '').slice(0, 200),
        construction: String(attrs.construction ?? '').slice(0, 200),
      },
      headings,
    })
  }
  return out
}

export function parseStageB(parsed: unknown): Map<string, Selection> {
  const out = new Map<string, Selection>()
  const results = (parsed as { results?: unknown[] })?.results ?? []
  for (const r of results as Array<Record<string, unknown>>) {
    const id = String(r.item_id ?? '')
    const code = String(r.hts_code ?? '').replace(/\D/g, '')
    if (!id || code.length !== 10) continue
    const conf = Number(r.confidence)
    out.set(id, {
      item_id: id,
      hts_code: code,
      rationale: String(r.rationale ?? '').slice(0, 300),
      confidence: Number.isFinite(conf) ? Math.min(Math.max(conf, 0), 1) : 0,
    })
  }
  return out
}

// ── 정규화 해시 (요구사항 2: 동일 입력 재호출 금지) ───────────

/** 표기 차이를 흡수: 소문자·구두점 제거·공백 축약 */
export function normalizeForCache(item: ClassifyInput): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  return `${norm(item.product_name)}|${norm(item.description_or_material)}|${item.origin_country.trim().toUpperCase()}`
}

export async function cacheKey(item: ClassifyInput, model: string): Promise<string> {
  const payload = `${PROMPT_VERSION}|${model}|${normalizeForCache(item)}`
  const bytes = new TextEncoder().encode(payload)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ── 투표 집계 ─────────────────────────────────────────────────

export function tallyVotes(
  item: ClassifyInput,
  stageA: StageAResult | undefined,
  perVote: Array<{ selection: Selection | undefined; valid: boolean }>,
): VoteOutcome {
  const votes = perVote.map((v) => (v.valid && v.selection ? v.selection.hts_code : null))
  const cast = votes.filter((v): v is string => v !== null)
  const unanimous = cast.length === perVote.length && new Set(cast).size === 1
  return {
    item_id: item.id,
    attributes: stageA?.attributes ?? null,
    headings: stageA?.headings ?? [],
    votes,
    consensus: unanimous ? cast[0] : null,
    unanimous,
    out_of_options: perVote.filter((v) => !v.valid).length,
    selections: perVote.map((v) => v.selection).filter((s): s is Selection => s !== undefined),
  }
}

/**
 * 최종 상태 판정 (요구사항 3).
 *
 * auto_confirmed = k=3 만장일치 AND 코드가 rate 원장에 실존.
 * 그 외 전부 needs_review. confidence 는 판정에서 빠지고 참고 표기로만 남는다
 * — v2 측정에서 오답에도 85~91% 를 줘서 신호 역할을 못 했기 때문.
 */
export function decideStatus(
  outcome: VoteOutcome,
  inLedger: boolean,
): { status: 'auto_confirmed' | 'needs_review'; reason: string } {
  if (!outcome.unanimous) {
    const distinct = [...new Set(outcome.votes.filter(Boolean))]
    return {
      status: 'needs_review',
      reason:
        outcome.votes.some((v) => v === null)
          ? `${VOTES}회 투표 중 ${outcome.votes.filter((v) => v === null).length}회가 보기 밖 코드를 냄`
          : `${VOTES}회 투표가 갈림 (${distinct.join(', ')})`,
    }
  }
  if (!inLedger) {
    return {
      status: 'needs_review',
      reason: `만장일치(${outcome.consensus})지만 rate 원장에 해당 코드의 base MFN 이 없어 duty 를 계산할 수 없음`,
    }
  }
  return { status: 'auto_confirmed', reason: `${VOTES}회 만장일치 + 원장 실존` }
}
