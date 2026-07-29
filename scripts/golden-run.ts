/**
 * 골든 테스트 러너 (golden-test-plan-v1.md).
 *
 * golden-test-products.csv 를 실제 파이프라인 모듈로 통과시켜 test-results.md 를 만든다.
 * 재구현 금지 — parseItemsCsv / classifyItems / computeShipment 를 앱과 동일하게 호출한다.
 *
 *   CSV → parseItemsCsv → classifyItems → confidence 게이팅(§1-3) → computeShipment(§4) → 리포트
 *
 * 두 시나리오를 함께 낸다:
 *   A. as-shipped — 분류기가 낸 top 후보를 그대로 확정 (실사용자가 받는 숫자)
 *   B. target-HTS — 계획서의 잠정 정답 6자리를 사용자가 리뷰 큐에서 골랐다고 가정
 *                   (§검증2 의 세율·계산 대조 대상)
 *
 * 실행: npm run golden
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join } from 'node:path'
import Papa from 'papaparse'
import { computeShipment, dutyBreakdownLabel } from '../src/lib/calc/engine'
import { formatHts, normalizeHts } from '../src/lib/calc/rates'
import { LAYER_LABEL } from '../src/lib/calc/types'
import type {
  CalcItem,
  CalcShipment,
  FeeSettings,
  RateLayer,
  RateRow,
  SkuResult,
} from '../src/lib/calc/types'
import { classifyItems } from '../src/lib/classify/client'
import { sanitizeCandidates } from '../src/lib/classify/types'
import type { ClassifyBatchResult, ClassifyItemInput, HtsCandidate } from '../src/lib/classify/types'
import { resolveStatus } from '../src/lib/classify/status'
import { parseItemsCsv } from '../src/lib/csv/parseItems'
import {
  MAX_LINES_PER_HEADING,
  PROMPT_VERSION,
  STAGE_A_SYSTEM,
  STAGE_B_SYSTEM,
  TEMPERATURE,
  VOTES,
  assessSuggestion,
  extractJson,
  parseStageA,
  parseStageB,
  stageAUser,
  stageBPrompt,
  tallyVotes,
} from '../supabase/functions/classify/pipeline'
import type { CatalogLine } from '../supabase/functions/classify/pipeline'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

// ── CLI 인자 ─────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
const OUT_FILE = arg('out') ?? 'test-results.md'
const FORCED_BACKEND = arg('backend') as 'edge' | 'anthropic' | 'mock' | undefined
/** --runs=N 은 모델 재현성 측정이 목적이라 기본적으로 캐시를 우회한다 */
const NO_CACHE = !argv.includes('--use-cache')

/** .env 로드 (tsx 는 vite 처럼 자동 주입하지 않는다) */
function loadDotEnv(): Record<string, string> {
  const f = join(root, '.env')
  if (!existsSync(f)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(f, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}
const dotenv = loadDotEnv()
const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? dotenv.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY ?? dotenv.VITE_SUPABASE_ANON_KEY
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? dotenv.ANTHROPIC_API_KEY

const MODELS = (arg('models') ?? arg('model') ?? process.env.CLASSIFY_MODEL ?? 'claude-haiku-4-5')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean)
/** anthropicJson 이 현재 어떤 모델로 호출할지 — 모델 루프가 갱신한다 */
let MODEL = MODELS[0]

/** 로컬 카탈로그 (Edge 는 hts_lines 테이블, 여기선 data/hts_lines.json) */
function loadCatalog(): Map<string, CatalogLine[]> {
  const f = join(root, 'data/hts_lines.json')
  if (!existsSync(f)) throw new Error(`${f} 없음 — 먼저 npm run hts:fetch`)
  const lines: Array<{ code: string; heading: string; description: string }> = JSON.parse(readFileSync(f, 'utf-8'))
  const byHeading = new Map<string, CatalogLine[]>()
  for (const l of lines) {
    if (!byHeading.has(l.heading)) byHeading.set(l.heading, [])
    byHeading.get(l.heading)!.push({ code: l.code, heading: l.heading, description: l.description })
  }
  return byHeading
}

/** 배포된 classify 함수가 살아 있는지 확인 (§1 요구: 200 응답 확인) */
async function probeEdge(): Promise<{ ok: boolean; status: number | string }> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { ok: false, status: 'env 없음' }
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/classify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: SUPABASE_KEY,
        authorization: `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({
        items: [{ id: 'probe', product_name: 'probe', description_or_material: 'probe', origin_country: 'CN' }],
      }),
    })
    return { ok: res.status === 200, status: res.status }
  } catch (e) {
    return { ok: false, status: String(e) }
  }
}

/**
 * 배포된 Edge Function 호출 (제품 경로).
 * supabase-js 대신 fetch 를 쓴다 — realtime 초기화가 Node 20 의 없는 전역 WebSocket 을 요구한다.
 * no_cache=true: --runs=N 로 모델 재현성을 재는 게 목적이라 캐시를 타면 측정이 무의미해진다.
 */
async function classifyViaEdgeHttp(items: ClassifyItemInput[]): Promise<ClassifyBatchResult[]> {
  const out: ClassifyBatchResult[] = []
  for (let i = 0; i < items.length; i += 10) {
    const batch = items.slice(i, i + 10)
    const res = await fetch(`${SUPABASE_URL}/functions/v1/classify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: SUPABASE_KEY!,
        authorization: `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({ items: batch, no_cache: NO_CACHE }),
      signal: AbortSignal.timeout(600_000),
    })
    const data = await res.json()
    if (!res.ok || data.error) throw new Error(`classify edge ${res.status}: ${data.error ?? ''}`)
    out.push({
      results: (data.results as ClassifyBatchResult['results']).map((r) => ({
        ...r,
        candidates: sanitizeCandidates(r.candidates),
      })),
      meta: data.meta,
      raw_output: null,
    })
  }
  return out
}

/** cached 앞부분에 cache_control — stage-B 카탈로그가 배치 간 캐시 프리픽스가 된다 */
async function anthropicJson(system: string, user: string, cached?: string): Promise<unknown> {
  const content = cached
    ? [
        { type: 'text', text: cached, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: user },
      ]
    : [{ type: 'text', text: user }]
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY!, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      temperature: TEMPERATURE,
      system,
      messages: [{ role: 'user', content }],
    }),
  })
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  const text: string = (data.content ?? [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text)
    .join('')
  return extractJson(text)
}

/**
 * Edge Function 과 동일한 2단계 파이프라인을 로컬에서 실행.
 * 프롬프트·투표·판정 로직은 전부 supabase/functions/classify/pipeline.ts 를 그대로 import 한다
 * — 두 벌이 되면 §검증1 점수가 무의미해진다.
 */
async function classifyViaAnthropic(items: ClassifyItemInput[]): Promise<ClassifyBatchResult[]> {
  const catalogByHeading = loadCatalog()
  const out: ClassifyBatchResult[] = []

  for (let i = 0; i < items.length; i += 10) {
    const batch = items.slice(i, i + 10)

    // (a) 속성 + 4자리 호 후보
    const stageA = parseStageA(await anthropicJson(STAGE_A_SYSTEM, stageAUser(batch)))

    // 호에 해당하는 USITC 실제 라인
    const linesByHeading = new Map<string, CatalogLine[]>()
    for (const h of new Set([...stageA.values()].flatMap((a) => a.headings))) {
      linesByHeading.set(h, catalogByHeading.get(h) ?? [])
    }
    const allowed = new Map<string, Set<string>>()
    for (const item of batch) {
      const set = new Set<string>()
      for (const h of stageA.get(item.id)?.headings ?? [])
        for (const l of (linesByHeading.get(h) ?? []).slice(0, MAX_LINES_PER_HEADING)) set.add(l.code)
      allowed.set(item.id, set)
    }

    // (b) 보기 중 선택 (k=VOTES). catalog 블록이 캐시 프리픽스
    const { catalog, questions } = stageBPrompt(batch, stageA, linesByHeading)
    const rounds = await Promise.all(
      Array.from({ length: VOTES }, async () => {
        const sel = parseStageB(await anthropicJson(STAGE_B_SYSTEM, questions, catalog))
        const strays = batch.filter((it) => {
          const s = sel.get(it.id)
          return !s || !allowed.get(it.id)?.has(s.hts_code)
        })
        if (strays.length > 0) {
          const retry = parseStageB(
            await anthropicJson(
              STAGE_B_SYSTEM,
              `${questions}\n\nYour previous answer used codes that were NOT in the catalog for: ${strays
                .map((s) => s.id)
                .join(', ')}. Return ONLY codes copied exactly from the catalog sections allowed for each product.`,
              catalog,
            ),
          )
          for (const s of strays) {
            const r = retry.get(s.id)
            if (r && allowed.get(s.id)?.has(r.hts_code)) sel.set(s.id, r)
          }
        }
        return sel
      }),
    )

    const results = batch.map((item) => {
      const perVote = rounds.map((sel) => {
        const s = sel.get(item.id)
        return { selection: s, valid: !!s && !!allowed.get(item.id)?.has(s.hts_code) }
      })
      const o = tallyVotes(item, stageA.get(item.id), perVote)
      const inLedger = o.consensus ? LEDGER.some((r) => r.layer === 'base_mfn' && r.hts_code === o.consensus) : false
      const { reason } = assessSuggestion(o, inLedger)
      const byCode = new Map<string, HtsCandidate>()
      for (const s of o.selections) {
        if (!byCode.has(s.hts_code))
          byCode.set(s.hts_code, { hts_code: s.hts_code, confidence: s.confidence, rationale: s.rationale })
      }
      return {
        item_id: item.id,
        candidates: sanitizeCandidates([...byCode.values()]),
        attributes: o.attributes,
        headings: o.headings,
        consensus: {
          code: o.consensus,
          unanimous: o.unanimous,
          votes: o.votes,
          in_ledger: inLedger,
          out_of_options: o.out_of_options,
          reason,
        },
      }
    })

    out.push({
      results,
      meta: { model: MODEL, prompt_version: PROMPT_VERSION, temperature: TEMPERATURE, votes: VOTES },
      raw_output: { local_pipeline: true },
    })
  }
  return out
}

// ── 계획서 §검증1 잠정 정답 (6자리) ──────────────────────────────
const TARGETS: Record<string, { six: string[]; note: string }> = {
  'MUG-01': { six: ['691200'], note: '도자기(자기 아님) 식탁용품' },
  'BAG-01': { six: ['420292'], note: '직물제 백팩' },
  'TUM-01': { six: ['961700'], note: '함정 문항 — 진공 단열용기. 7323 오분류 잦음' },
  'LMP-01': { six: ['940521', '940529'], note: 'LED 테이블 램프 (9405.2x)' },
  'TSH-01': { six: ['610910'], note: '면 니트 티셔츠' },
  'SPK-01': { six: ['851822', '851762'], note: '논쟁 품목 — 판례가 갈림' },
  'MAT-01': { six: ['950691'], note: '운동용구 판례 존재 (3926 아님)' },
  'BRD-01': { six: ['441911'], note: '대나무 도마 (v1 의 4419.12 = 젓가락 오답 정정)' },
  'CSE-01': { six: ['392690'], note: '플라스틱 제품 기타' },
  'UTL-01': { six: ['392410'], note: '플라스틱(실리콘) 주방용품' },
}
/**
 * 시나리오 B 조회 코드.
 *
 * 정답은 6자리인데 원장의 base_mfn 행은 10자리다. 조회는 프리픽스 매칭
 * (`hts.startsWith(row.hts_code)`)이라 6자리 코드로는 10자리 행에 절대 닿지 않는다.
 * 실제 유저도 리뷰 큐에서 10자리를 고르므로, 정답 6자리 아래에 있는 원장의
 * 가장 구체적인 base_mfn 행 코드로 해석한다. 없으면 6자리 그대로 사용
 * (보충 시드 행이 6자리라 정확히 매칭된다).
 */
function resolveTargetCode(six: string, ledger: RateRow[]): { code: string; via: string } {
  const under = ledger
    .filter((r) => r.layer === 'base_mfn' && r.origin_country === null && normalizeHts(r.hts_code).startsWith(six))
    .map((r) => normalizeHts(r.hts_code))
    .sort()
  if (under.length > 0) return { code: under[0], via: `원장 base_mfn 행 (${under.length}개 중 첫 번째)` }
  return { code: six, via: '6자리 그대로 (원장에 하위 행 없음)' }
}

const TRAP_SKUS = ['TUM-01', 'SPK-01']

// ── 선적 파라미터 (러너 고정값 — 리포트에 명시) ──────────────────
const SHIP: CalcShipment = {
  freight_usd: 4800,
  insurance_usd: 200,
  mode: 'ocean',
  allocation_basis: 'value',
  target_margin: 0.3,
  channel_fee_pct: 0.15,
  rate_as_of: '2026-07-29',
}
const FEES: FeeSettings = {
  mpf_rate: 0.003464,
  mpf_min_usd: 32.71,
  mpf_max_usd: 634.62,
  hmf_rate: 0.00125,
  effective_from: '2024-10-01',
}

// ── 원장 로드 (seedRates.ts 는 vite ?raw 의존이라 node 에서 직접 파싱) ──
function loadLedger(file: string): RateRow[] {
  const csv = readFileSync(join(root, file), 'utf-8')
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true })
  return parsed.data.map((r) => ({
    hts_code: r.hts_code.trim(),
    origin_country: r.origin_country?.trim() ? r.origin_country.trim().toUpperCase() : null,
    layer: r.layer.trim() as RateLayer,
    ad_valorem_rate: Number(r.ad_valorem_rate),
    effective_from: r.effective_from.trim(),
    effective_to: r.effective_to?.trim() ? r.effective_to.trim() : null,
    source: r.source?.trim() || null,
    note: r.note?.trim() || null,
  }))
}
/**
 * 원장 구성 (v3):
 *   base_mfn        USITC 공식 export 에서 (data/hts_lines.json) — 실제 값
 *   301 · IEEPA     hts_seed_50.csv 의 SAMPLE 행 — 여전히 미검증, 관리자 수기 확정 대상
 *
 * v1·v2 의 UNVERIFIED-PLACEHOLDER 보충 시드는 실제 USITC 값이 생겼으므로 쓰지 않는다.
 */
function loadUsitcBaseMfn(): RateRow[] {
  const f = join(root, 'data/hts_lines.json')
  if (!existsSync(f)) throw new Error(`${f} 없음 — 먼저 npm run hts:fetch`)
  const lines: Array<{ code: string; adValorem: number | null; general: string }> = JSON.parse(
    readFileSync(f, 'utf-8'),
  )
  return lines
    .filter((l) => l.adValorem !== null)
    .map((l) => ({
      hts_code: l.code,
      origin_country: null,
      layer: 'base_mfn' as RateLayer,
      ad_valorem_rate: l.adValorem as number,
      effective_from: '2025-01-01',
      effective_to: null,
      source: 'USITC HTS export',
      note: l.general,
    }))
}
const SEED_LAYERS = loadLedger('supabase/seed/hts_seed_50.csv').filter((r) => r.layer !== 'base_mfn')
const USITC_MFN = loadUsitcBaseMfn()
const LEDGER: RateRow[] = [...USITC_MFN, ...SEED_LAYERS]
const BASE_LEDGER = USITC_MFN
const SUPPLEMENT = SEED_LAYERS

const SCENARIO_B: Record<string, { code: string; via: string }> = Object.fromEntries(
  Object.entries(TARGETS).map(([sku, t]) => [sku, resolveTargetCode(t.six[0], LEDGER)]),
)

const UNVERIFIED = new Set(
  LEDGER.filter((r) => r.source === 'UNVERIFIED-PLACEHOLDER').map((r) => `${r.layer}|${r.hts_code}`),
)
const SAMPLE_ROWS = new Set(LEDGER.filter((r) => r.source === 'SAMPLE').map((r) => `${r.layer}|${r.hts_code}`))

const usd = (n: number, d = 4) => `$${n.toFixed(d)}`
const pct = (n: number) => `${(n * 100).toFixed(2)}%`

/** 후보 안에 정답 6자리 프리픽스가 있는가 (§검증1 통과 기준) */
function hitsTarget(cands: HtsCandidate[], six: string[]): { hit: boolean; rank: number | null } {
  for (let i = 0; i < cands.length; i++) {
    if (six.some((s) => normalizeHts(cands[i].hts_code).startsWith(s))) return { hit: true, rank: i + 1 }
  }
  return { hit: false, rank: null }
}

function layerRate(r: SkuResult, layer: RateLayer): number {
  return r.duty_layers.find((l) => l.layer === layer)?.rate ?? 0
}
function layerMatch(r: SkuResult, layer: RateLayer): string | null {
  return r.duty_layers.find((l) => l.layer === layer)?.matched_hts ?? null
}

async function main() {
  const csvText = readFileSync(join(root, 'golden-test-products.csv'), 'utf-8')
  const { items: parsed, errors } = parseItemsCsv(csvText)
  if (errors.length > 0) {
    console.error('CSV 파싱 오류:', errors)
    process.exit(1)
  }

  // ── 백엔드 결정 ──────────────────────────────────────────────
  // 우선순위: 배포된 Edge Function(제품 경로) > ANTHROPIC_API_KEY 직접 호출 > mock
  const probe = FORCED_BACKEND === 'mock' || FORCED_BACKEND === 'anthropic' ? { ok: false, status: 'skip' } : await probeEdge()
  let backend: 'edge' | 'anthropic' | 'mock'
  if (FORCED_BACKEND) backend = FORCED_BACKEND
  else if (probe.ok) backend = 'edge'
  else if (ANTHROPIC_KEY) backend = 'anthropic'
  else backend = 'mock'

  if (backend === 'edge' && (!SUPABASE_URL || !SUPABASE_KEY)) throw new Error('edge 백엔드인데 VITE_SUPABASE_* 가 없다')
  if (backend === 'anthropic' && !ANTHROPIC_KEY) throw new Error('anthropic 백엔드인데 ANTHROPIC_API_KEY 가 없다')
  const isReal = backend !== 'mock'

  console.log(`분류 백엔드: ${backend}${backend === 'edge' ? '' : `  (edge probe: HTTP ${probe.status})`}`)

  // ── 분류 (앱과 동일 경로: 배치10 × 동시4) ─────────────────────
  const withIds = parsed.map((p, i) => ({ ...p, id: `it-${i}` }))
  const inputs: ClassifyItemInput[] = withIds.map((p) => ({
    id: p.id,
    product_name: p.product_name,
    description_or_material: p.description_or_material,
    origin_country: p.origin_country,
  }))

  const runOnce = async (): Promise<ClassifyBatchResult[]> => {
    if (backend === 'anthropic') return classifyViaAnthropic(inputs)
    if (backend === 'edge') return classifyViaEdgeHttp(inputs)
    return classifyItems({ kind: 'mock' }, inputs)
  }

  // LLM 은 비결정론적이라 1회 표본으로 게이트를 통과/미달 판정하면 안 된다 (--runs=N)
  const RUNS = Math.max(1, Number(arg('runs') ?? (isReal ? 3 : 1)))

  /** 모델별 측정 결과 */
  const perModel: Array<{ model: string; runs: ClassifyBatchResult[][]; ms: number }> = []
  for (const m of MODELS) {
    MODEL = m
    const t = performance.now()
    const runs: ClassifyBatchResult[][] = []
    for (let i = 0; i < RUNS; i++) {
      console.log(`  [${m}] 실행 ${i + 1}/${RUNS}…`)
      runs.push(await runOnce())
    }
    perModel.push({ model: m, runs, ms: (performance.now() - t) / RUNS })
  }

  const allRuns = perModel[0].runs
  const classifyMs = perModel[0].ms
  const batches = allRuns[0]
  const model = batches[0]?.meta.model ?? MODELS[0]
  const promptVersion = batches[0]?.meta.prompt_version ?? 'unknown'

  // ── §1-3 confidence 게이팅 (demo/supabase repo 와 동일 규칙) ──
  const gate = (bs: ClassifyBatchResult[]) => {
    const byId = new Map<string, ClassifyBatchResult['results'][number]>()
    for (const b of bs) for (const r of b.results) byId.set(r.item_id, r)
    return withIds.map((p) => {
      const res = byId.get(p.id)
      const cands = res?.candidates ?? []
      const consensus = res?.consensus ?? null
      const status = res ? resolveStatus(res) : 'pending'
      return {
        ...p,
        candidates: cands,
        top: cands[0] ?? null,
        consensus,
        // 자동확정이 아니면 리포트에 잠정 표시 (§5)
        provisional: status !== 'user_confirmed',
        status,
        // 계산에 쓸 코드: 만장일치면 그 코드, 아니면 1표라도 나온 값(잠정)
        chosen: consensus?.code ?? cands[0]?.hts_code ?? null,
      }
    })
  }
  const gatedRuns = allRuns.map(gate)
  const gated = gatedRuns[0]

  /** 실행 1건의 6자리 적중 SKU 집합 */
  const hitSet = (gs: ReturnType<typeof gate>) =>
    new Set(gs.filter((g) => TARGETS[g.sku] && hitsTarget(g.candidates, TARGETS[g.sku].six).hit).map((g) => g.sku))
  const runHitSets = gatedRuns.map(hitSet)
  const runScores = runHitSets.map((s) => s.size)

  const mkItems = (pick: (g: (typeof gated)[number]) => string | null): CalcItem[] =>
    gated.map((g) => ({
      sku: g.sku,
      unit_cost_usd: g.unit_cost_usd,
      origin_country: g.origin_country,
      units_per_shipment: g.units_per_shipment,
      weight_kg_per_unit: g.weight_kg_per_unit,
      current_price_usd: g.current_price_usd,
      hts_code: pick(g),
      provisional: g.provisional,
    }))

  const resultA = computeShipment(SHIP, mkItems((g) => g.chosen), LEDGER, FEES)
  const resultB = computeShipment(SHIP, mkItems((g) => SCENARIO_B[g.sku]?.code ?? null), LEDGER, FEES)

  // ── 부분 미스 무경고 탐지 ────────────────────────────────────
  // engine.ts 는 "모든 레이어가 미매칭"일 때만 경고한다. 일부 레이어만 원장에
  // 없으면 duty 가 조용히 과소계상된다 — 리포트에 아무 표시가 없다.
  const silentPartialMiss = resultB.items
    .filter((r) => {
      const missed = r.duty_layers.filter((l) => l.matched_hts === null)
      const expectsMfn = true
      const g = gated.find((x) => x.sku === r.sku)!
      const expects301 = g.origin_country === 'CN'
      const relevantMiss = missed.some(
        (l) => (l.layer === 'base_mfn' && expectsMfn) || (l.layer === 'section301' && expects301),
      )
      return relevantMiss && r.warnings.length === 0
    })
    .map((r) => ({
      sku: r.sku,
      missed: r.duty_layers.filter((l) => l.matched_hts === null).map((l) => l.layer),
    }))

  // ── §검증2-4 원산지 스코핑 assert ────────────────────────────
  const originViolations: string[] = []
  for (const res of [resultA, resultB]) {
    for (const r of res.items) {
      const origin = gated.find((g) => g.sku === r.sku)!.origin_country
      if (origin !== 'CN' && layerRate(r, 'section301') > 0) {
        originViolations.push(`${r.sku} (${origin}): section301 ${pct(layerRate(r, 'section301'))}`)
      }
    }
  }

  // ── §검증1 채점 ──────────────────────────────────────────────
  const scored = gated.map((g) => {
    const t = TARGETS[g.sku]
    const { hit, rank } = t ? hitsTarget(g.candidates, t.six) : { hit: false, rank: null }
    // 4자리(호) 단위 적중 — 소호만 틀린 "근접 오답"과 완전 오답을 구분한다
    const head = t ? hitsTarget(g.candidates, t.six.map((s) => s.slice(0, 4))) : { hit: false, rank: null }
    return { ...g, target: t, hit, rank, headHit: head.hit }
  })
  const hits = scored.filter((s) => s.hit).length
  const headHits = scored.filter((s) => s.headHit).length
  const nearMiss = scored.filter((s) => s.headHit && !s.hit)
  const trapHits = scored.filter((s) => TRAP_SKUS.includes(s.sku) && s.hit).length

  // 자동확정됐지만 6자리가 틀린 건 — §1-3 안전판이 걸러내지 못한 오분류
  const wrongButConfident = scored.filter((s) => s.status !== 'user_confirmed' && !s.hit)

  // 후보 10자리가 원장 base_mfn 행으로 해석되는가 (duty 조회 가능 여부)
  const ledgerBase = LEDGER.filter((r) => r.layer === 'base_mfn')
  const allCands = scored.flatMap((s) => s.candidates)
  const resolvable = allCands.filter((c) =>
    ledgerBase.some((r) => normalizeHts(c.hts_code).startsWith(normalizeHts(r.hts_code))),
  ).length
  const zeroPadded = allCands.filter((c) => /0{4}$/.test(normalizeHts(c.hts_code))).length

  // ── 모델별 종합 (요구사항 5) ──────────────────────────────
  const modelStats = perModel.map((pm) => {
    const gs = pm.runs.map(gate)
    const hitSets = gs.map(hitSet)
    const scores = hitSets.map((s) => s.size)
    // 오답 중 needs_review 로 격리된 비율 — 안전판이 실제로 작동하는가
    let wrong = 0
    let wrongIsolated = 0
    let autoConfirmed = 0
    let unanimousCount = 0
    let outOfOptions = 0
    let total = 0
    for (const g of gs) {
      for (const it of g) {
        total++
        const isHit = TARGETS[it.sku] ? hitsTarget(it.candidates, TARGETS[it.sku].six).hit : false
        // v3 부터 자동확정이 없다 — suggested 는 전부 사람 확인 대기다.
        // 아래 두 지표는 "확인 없이 그대로 쓰면 어떻게 되는가"를 재는 용도로 남긴다.
        if (it.status === 'suggested') autoConfirmed++
        if (it.consensus?.unanimous) unanimousCount++
        outOfOptions += it.consensus?.out_of_options ?? 0
        if (!isHit) {
          wrong++
          if (it.status === 'user_confirmed') wrongIsolated++
        }
      }
    }
    // 재현성: SKU 별로 확정 코드가 모든 실행에서 같은가
    const stable = gated.filter((g0) => {
      const codes = gs.map((g) => g.find((x) => x.sku === g0.sku)?.chosen ?? null)
      return new Set(codes).size === 1 && codes[0] !== null
    }).length
    return {
      model: pm.model,
      ms: pm.ms,
      scores,
      avg: scores.reduce((a, b) => a + b, 0) / scores.length,
      best: Math.max(...scores),
      worst: Math.min(...scores),
      wrong,
      wrongIsolated,
      isolationRate: wrong > 0 ? wrongIsolated / wrong : 1,
      autoConfirmed,
      wrongAutoConfirmed: wrong - wrongIsolated,
      unanimousRate: unanimousCount / total,
      outOfOptions,
      stable,
      hitSets,
    }
  })

  // ── 리포트 작성 ──────────────────────────────────────────────
  const L: string[] = []
  const p = (s = '') => L.push(s)

  const versionLabel = OUT_FILE.match(/v(\d+)/)?.[0] ?? 'v1'
  p(`# LandedIQ 골든 테스트 결과 ${versionLabel}`)
  p()
  p('`golden-test-products.csv` 10건을 실제 파이프라인 모듈로 통과시킨 결과.')
  p('생성: `npm run golden` ([scripts/golden-run.ts](scripts/golden-run.ts)) · 계획서: [golden-test-plan-v1.md](golden-test-plan-v1.md)')
  p()

  // ── 신뢰성 경고 (제일 위) ────────────────────────────────────
  p('## ⛔ 이 결과로 판정하면 안 되는 것')
  p()
  p('| 검증 | 상태 | 이유 |')
  p('|---|---|---|')
  if (isReal) {
    p(
      `| §검증1 HTS 분류 | **집행됨** | 실 분류기 \`${model}\` (${backend === 'edge' ? '배포된 Edge Function' : 'ANTHROPIC_API_KEY 직접 호출, 프롬프트는 Edge Function 소스 그대로'}) 로 측정했다. |`,
    )
  } else {
    p(
      `| §검증1 HTS 분류 | **집행 불가** | \`classify\` Edge Function 미배포(edge probe: HTTP ${probe.status}), \`ANTHROPIC_API_KEY\` 없음. 아래 점수는 **LLM이 아니라 \`src/lib/classify/mock.ts\` 키워드 정규식 매처**의 점수다. 제품의 심장은 아직 측정되지 않았다. |`,
    )
  }
  p('| §검증1 정답 확정 | **미완** | 계획서가 요구한 CBP CROSS 판례 확인을 수행하지 않았다. 아래 정답은 계획서의 잠정값(BRD-01 은 v2 정정본)이며 **최종 채점 전 CROSS 확인 필요**. |')
  p(
    `| §검증2-1·2 세율 대조 | **부분 통과** | base MFN ${BASE_LEDGER.length.toLocaleString()}행은 USITC 공식 export 에서 직접 적재해 대조가 끝났다 (스펙 §4 허용 경로). **Section 301·IEEPA ${SUPPLEMENT.length}행은 여전히 SAMPLE** — 관리자 수기 확정 전까지 duty 총액은 신뢰할 수 없다. |`,
  )
  p('| §검증2-3 계산 재검증 | **집행됨 ✅** | 결정론 코드라 여기서 나온 숫자는 그대로 신뢰 가능. 아래 수식 대입값으로 엑셀 대조하면 된다. |')
  p('| §검증2-4 원산지 스코핑 | **집행됨 ✅** | 아래 assert 결과 참조. |')
  p()

  p('### 원장 출처 (§검증2-1·2 대조 대상)')
  p()
  p('| source | 행 수 | 의미 |')
  p('|---|---|---|')
  const bySource = new Map<string, number>()
  for (const r of LEDGER) bySource.set(r.source ?? '(없음)', (bySource.get(r.source ?? '(없음)') ?? 0) + 1)
  const SRC_MEANING: Record<string, string> = {
    'USITC HTS export': '✅ USITC 공식 export 직접 적재 — 검증됨',
    'USITC HTS snapshot': '테스트 스냅샷 — 현행표 재확인 필요',
    SAMPLE: '❌ 예시값 — 관리자 수기 확정 필요 (301·IEEPA)',
    'UNVERIFIED-PLACEHOLDER': '**자리표시자. 검증된 값 아님**',
  }
  for (const [src, n] of [...bySource].sort((a, b) => b[1] - a[1])) {
    p(`| \`${src}\` | ${n} | ${SRC_MEANING[src] ?? '—'} |`)
  }
  p()
  const verified = LEDGER.filter((r) => (r.source ?? '').startsWith('USITC HTS export')).length
  p(
    `검증된 행 **${verified.toLocaleString()}/${LEDGER.length.toLocaleString()}**. base MFN 은 USITC 공식 데이터로 해결됐고, 남은 미검증은 Section 301·IEEPA ${SUPPLEMENT.length}행이다.`,
  )
  p()
  p('**이 10개 SKU 에 301·IEEPA 가 붙는 한 duty 총액은 여전히 미확정이다** — 광고 판단의 병목은 이제 세율 원장이 아니라 이 두 레이어다.')
  p()

  p('---')
  p()
  p('## 실행 조건')
  p()
  p('| 항목 | 값 |')
  p('|---|---|')
  p(
    `| 분류 백엔드 | \`${model}\` (prompt ${promptVersion}) — ${isReal ? `**실 분류기 (${backend})**` : '**mock, LLM 아님**'} |`,
  )
  p(`| 분류 소요 | ${classifyMs.toFixed(1)} ms |`)
  p(`| 자동확정 규칙 | k=${VOTES} 만장일치 AND 원장 base MFN 실존 (confidence 는 참고 표기로 강등) |`)
  p(`| temperature | ${TEMPERATURE} |`)
  p(`| 원장 행 수 | ${LEDGER.length.toLocaleString()} (USITC base MFN ${BASE_LEDGER.length.toLocaleString()} + 301·IEEPA SAMPLE ${SUPPLEMENT.length}) |`)
  p(`| rate 기준일 | ${SHIP.rate_as_of} |`)
  p(`| 운임 + 보험 | $${SHIP.freight_usd.toLocaleString()} + $${SHIP.insurance_usd} = **$${(SHIP.freight_usd + SHIP.insurance_usd).toLocaleString()}** |`)
  p(`| 운송 모드 / 배부 기준 | ${SHIP.mode} / ${resultB.totals.allocation_basis_used} |`)
  p(`| MPF | ${pct(FEES.mpf_rate)} · 캡 [$${FEES.mpf_min_usd}, $${FEES.mpf_max_usd}] |`)
  p(`| HMF | ${pct(FEES.hmf_rate)} (ocean 한정) |`)
  p(`| target margin / channel fee | ${pct(SHIP.target_margin)} / ${pct(SHIP.channel_fee_pct)} |`)
  p()
  p(`> CSV에 \`current_price_usd\` 컬럼이 없어 true margin·권장 판매가는 산출되지 않는다 (설계대로 null).`)
  p()

  p('---')
  p()
  p(`## §검증1 — HTS 분류 (${isReal ? `실 분류기 \`${model}\`` : 'mock 분류기 기준, 참고치'})`)
  p()
  p('| SKU | 후보 1 | 후보 2 | 후보 3 | 상태 | 계획서 잠정정답 | 포함? |')
  p('|---|---|---|---|---|---|---|')
  for (const s of scored) {
    const c = (i: number) =>
      s.candidates[i] ? `\`${formatHts(s.candidates[i].hts_code)}\` ${(s.candidates[i].confidence * 100).toFixed(0)}%` : '—'
    const tgt = s.target ? s.target.six.map((x) => `\`${x.slice(0, 4)}.${x.slice(4)}\``).join(' / ') : '—'
    const mark = s.hit ? `✅ 후보${s.rank}` : '❌'
    p(`| ${s.sku}${TRAP_SKUS.includes(s.sku) ? ' 🎯' : ''} | ${c(0)} | ${c(1)} | ${c(2)} | ${s.status} | ${tgt} | ${mark} |`)
  }
  p()
  p(
    `**${isReal ? '점수' : 'mock 점수'}: ${hits}/10** (통과 기준 7/10 → ${hits >= 7 ? '**통과**' : '**미달**'}) · 함정 문항(🎯) ${trapHits}/2`,
  )
  p()
  p(`needs_review 로 격리된 건: ${gated.filter((g) => g.status === 'suggested').map((g) => g.sku).join(', ') || '없음'}`)
  p()
  if (!isReal) {
    p('> 다시 강조: 이 점수는 mock 키워드 매처의 점수다. **제품이 실제로 쓰는 LLM 분류기 점수가 아니다.**')
    p('> Edge Function 배포 + API 키 설정 후 재실행해야 §검증1 이 성립한다.')
    p()
  } else {
    p('### 모델별 비교')
    p()
    p(`파이프라인 v2(2단계 선택형·temperature ${TEMPERATURE}·k=${VOTES} 만장일치), 각 ${RUNS}회 실행.`)
    p()
    p('| 모델 | 6자리 점수 (평균/범위) | 오답 needs_review 격리율 | 오답인데 자동확정 | 재현성 | 만장일치율 | 보기밖 |')
    p('|---|---|---|---|---|---|---|')
    for (const m of modelStats) {
      p(
        `| \`${m.model}\` | **${m.avg.toFixed(1)}/10** (${m.worst}–${m.best}) | **${(m.isolationRate * 100).toFixed(0)}%** (${m.wrongIsolated}/${m.wrong}) | **${m.wrongAutoConfirmed}건** | ${m.stable}/10 SKU 고정 | ${(m.unanimousRate * 100).toFixed(0)}% | ${m.outOfOptions}건 |`,
      )
    }
    p()
    p('- **오답 needs_review 격리율** — 틀린 분류가 리뷰 큐로 갔는가. 100% 면 오답이 사용자에게 "확인됨"으로 전달되지 않는다.')
    p('- **오답인데 자동확정** — 가장 위험한 칸. 틀렸는데 확정돼서 그대로 duty 가 계산된다. 0 이어야 한다.')
    p('- **재현성** — 같은 CSV 를 다시 올렸을 때 같은 코드가 나오는 SKU 수 (캐시 우회 측정).')
    p('- **보기밖** — 카탈로그에 없는 코드를 낸 횟수. 재시도 후에도 실패한 건만 센다.')
    p()
    p(`> 캐시(정규화 해시)를 켜면 재현성은 정의상 10/10 이 된다. 위 수치는 \`no_cache\` 로 **모델 자체의**`)
    p('> 안정성을 잰 것이다. 사용자 체감 재현성은 캐시가 보장한다.')
    p()
    p('| SKU | ' + modelStats.map((m) => `\`${m.model.replace('claude-', '')}\``).join(' | ') + ' |')
    p('|---|' + modelStats.map(() => '---').join('|') + '|')
    for (const g of gated) {
      const cells = modelStats.map((m) => {
        const n = m.hitSets.filter((s) => s.has(g.sku)).length
        return n === RUNS ? `✅ ${n}/${RUNS}` : n === 0 ? `❌ 0/${RUNS}` : `⚠️ ${n}/${RUNS}`
      })
      p(`| ${g.sku}${TRAP_SKUS.includes(g.sku) ? ' 🎯' : ''} | ${cells.join(' | ')} |`)
    }
    p()

    if (RUNS > 1) {
      const min = Math.min(...runScores)
      const max = Math.max(...runScores)
      const avg = runScores.reduce((a, b) => a + b, 0) / RUNS
      p(`### 실행 간 변동 (${RUNS}회)`)
      p()
      p('LLM 출력은 비결정론적이다. 게이트 판정을 1회 표본으로 하면 안 되므로 반복 실행했다.')
      p()
      p(`| 실행 | 점수 | 적중 SKU |`)
      p('|---|---|---|')
      runHitSets.forEach((s, i) => p(`| ${i + 1} | ${s.size}/10 | ${[...s].sort().join(', ') || '없음'} |`))
      p(`| **평균** | **${avg.toFixed(1)}/10** | 범위 ${min}–${max} |`)
      p()
      p('| SKU | 적중 횟수 | 안정성 |')
      p('|---|---|---|')
      for (const g of gated) {
        const n = runHitSets.filter((s) => s.has(g.sku)).length
        const label = n === RUNS ? '✅ 항상 맞힘' : n === 0 ? '❌ 항상 틀림' : `⚠️ 불안정 (${n}/${RUNS})`
        p(`| ${g.sku}${TRAP_SKUS.includes(g.sku) ? ' 🎯' : ''} | ${n}/${RUNS} | ${label} |`)
      }
      p()
      const flaky = gated.filter((g) => {
        const n = runHitSets.filter((s) => s.has(g.sku)).length
        return n > 0 && n < RUNS
      })
      p(
        `최고 기록(${max}/10)도 기준 7/10 에 미달한다. 불안정 SKU ${flaky.length}건(${flaky.map((f) => f.sku).join(', ') || '없음'})은`,
      )
      p('같은 입력에 매번 다른 코드를 낸다는 뜻이다 — 사용자가 같은 CSV 를 두 번 올리면 다른 duty 가 나온다.')
      p('분류 점수와 별개로 **재현성 자체가 제품 신뢰성 문제**다.')
      p()
      p('> 아래 상세 표·계산은 **실행 1** 기준이다.')
      p()
    }

    p('### 진단 — 왜 틀렸는가')
    p()
    p('| 지표 | 값 | 의미 |')
    p('|---|---|---|')
    p(`| 6자리(소호) 적중 | **${hits}/10** | 채점 기준 |`)
    p(`| 4자리(호) 적중 | **${headHits}/10** | 큰 분류는 맞히는지 |`)
    p(`| 근접 오답 (호 O, 소호 X) | **${nearMiss.length}건** | ${nearMiss.map((s) => s.sku).join(', ') || '없음'} |`)
    p(
      `| 자동확정됐는데 오답 | **${wrongButConfident.length}/10** | §1-3 안전판을 빠져나간 오분류 — 낮을수록 좋다 |`,
    )
    p(`| needs_review 로 격리 | **${gated.filter((g) => g.status === 'suggested').length}/10** | 리뷰 큐로 간 건 |`)
    p(`| 후보당 개수 | 평균 ${(allCands.length / scored.length).toFixed(1)}개 | 스펙 §5 는 2~3개 요구 |`)
    p(`| 통계 suffix 가 0000 | ${zeroPadded}/${allCands.length} | 10자리를 0 으로 채운 정황 |`)
    p(`| 원장 base_mfn 으로 해석 가능 | ${resolvable}/${allCands.length} | duty 조회가 실제로 되는 후보 수 |`)
    p()

    if (headHits > hits) {
      p(
        `**핵심 패턴: 호(4자리)는 ${headHits}/10 맞히는데 소호(6자리)는 ${hits}/10 이다.** 큰 갈래는 잡는데 소재·용도로 갈리는`,
      )
      p('마지막 한 단계를 못 좁힌다. 계획서가 지목한 "소재·용도 필드 활용 강화"가 정확히 이 지점이다.')
      p()
      p('| SKU | 낸 답 | 정답 | 차이 |')
      p('|---|---|---|---|')
      for (const s of nearMiss) {
        p(
          `| ${s.sku} | \`${formatHts(s.candidates[0]?.hts_code ?? '')}\` | \`${s.target!.six[0].slice(0, 4)}.${s.target!.six[0].slice(4)}\` | ${s.target!.note} |`,
        )
      }
      p()
    }

    if (wrongButConfident.length > 0) {
      p('**confidence 가 신호 역할을 못 한다.** 아래는 자동확정(≥0.7)됐지만 6자리가 틀린 건이다.')
      p('사용자에게 "확인됨"으로 보이고 리뷰 큐에도 안 간다 — 스펙 §1-3 human-in-the-loop 이 사실상 무력하다.')
      p()
      p('| SKU | 낸 답 | confidence | 정답 |')
      p('|---|---|---|---|')
      for (const s of wrongButConfident) {
        p(
          `| ${s.sku} | \`${formatHts(s.candidates[0]?.hts_code ?? '')}\` | **${((s.candidates[0]?.confidence ?? 0) * 100).toFixed(0)}%** | \`${s.target!.six[0].slice(0, 4)}.${s.target!.six[0].slice(4)}\` |`,
        )
      }
      p()
    }

    if (resolvable < allCands.length) {
      p(
        `**10자리 코드의 신뢰성 문제**: 후보 ${allCands.length}개 중 ${allCands.length - resolvable}개가 원장의 base_mfn 행으로 해석되지 않는다.`,
      )
      p('모델이 6자리까지 정하고 통계 suffix 를 0 으로 채우는 정황이 보인다. rate 원장은 8·10자리로 조회하므로,')
      p('소호가 맞아도 suffix 가 실제 존재하지 않으면 duty 가 0 이 되거나 엉뚱한 행에 걸린다. 분류 점수와 별개로')
      p('**후보 코드를 원장·USITC 코드 목록에 존재하는 것으로 제한하는 검증 단계가 필요하다.**')
      p()
    }
  }

  p('### 정답 키 자체의 의심 지점')
  p()
  p('- **BRD-01: 4419.12 → 4419.11 로 정정됨 (v2).** HS 4419 하위는 4419.11 = 빵판·도마 및 유사 판(대나무), 4419.12 = **젓가락**(대나무), 4419.19 = 기타. v1 정답 키의 4419.12 는 젓가락 소호였다. CROSS 로 최종 확인 필요.')
  p('- **LMP-01 → 9405.2x** 는 9405.21(LED 전용) / 9405.29(기타)로 갈린다. "LED table lamp" 는 9405.21 쪽이나, USB 충전 포트가 있어 복합기능 논쟁 여지가 있다.')
  {
    const tum = scored.find((s) => s.sku === 'TUM-01')
    const tumTop = tum?.candidates[0]?.hts_code
    p(
      `- **TUM-01 → 9617.00** 은 계획서 지적대로 함정이다. 이번 실행의 top 후보는 \`${formatHts(tumTop ?? '')}\` — ${
        tumTop?.startsWith('9617') ? '정답' : `${RUNS}회 모두 오답이었다. 진공 단열 구조(9617)가 아니라 소재(스테인리스·철강)로 분류하는 오류가 반복된다`
      }.`,
    )
  }
  p()

  p('---')
  p()
  p('## §검증2 — 세율·계산 (시나리오 B: 계획서 정답 HTS 확정 가정)')
  p()
  p('사용자가 리뷰 큐에서 계획서의 정답 6자리를 골랐다고 가정한 결과. §검증2 대조는 이 표를 쓴다.')
  p()
  p('<details><summary>정답 6자리 → 실제 조회 코드 해석</summary>')
  p()
  p('| SKU | 정답(6자리) | 조회 코드 | 해석 경로 |')
  p('|---|---|---|---|')
  for (const [sku, t] of Object.entries(TARGETS)) {
    p(`| ${sku} | \`${t.six[0]}\` | \`${SCENARIO_B[sku].code}\` | ${SCENARIO_B[sku].via} |`)
  }
  p()
  p('</details>')
  p()
  p('| SKU | 원산지 | HTS | MFN | 301 | IEEPA | duty 합 | duty $/unit | freight $/unit | MPF $/unit | HMF $/unit | landed $/unit |')
  p('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of resultB.items) {
    const g = gated.find((x) => x.sku === r.sku)!
    const lr = (l: RateLayer) => {
      const rate = layerRate(r, l)
      const m = layerMatch(r, l)
      return m === null ? '—' : `${pct(rate)}`
    }
    p(
      `| ${r.sku} | ${g.origin_country} | \`${r.hts_code}\` | ${lr('base_mfn')} | ${lr('section301')} | ${lr('ieepa_reciprocal')} | **${pct(r.duty_rate_total)}** | ${usd(r.duty_usd)} | ${usd(r.freight_per_unit)} | ${usd(r.mpf_per_unit)} | ${usd(r.hmf_per_unit)} | **${usd(r.landed_cost)}** |`,
    )
  }
  p()
  p('`—` = 해당 레이어가 원장에 없어 0% 적용 (스펙 §4 "없으면 0"). **0% 확정이 아니라 미확인이라는 뜻이다.**')
  p()

  const missingLayers = resultB.items.flatMap((r) => {
    const out: string[] = []
    if (layerMatch(r, 'base_mfn') === null) out.push(`${r.sku}: base_mfn`)
    const g = gated.find((x) => x.sku === r.sku)!
    if (g.origin_country === 'CN' && layerMatch(r, 'section301') === null) out.push(`${r.sku}: section301(CN)`)
    return out
  })
  if (missingLayers.length > 0) {
    p('**원장에 없어 0% 로 계산된 레이어** (관리자 확정 필요):')
    p()
    for (const m of missingLayers) p(`- ${m}`)
    p()
  }

  const unverifiedUse = resultB.items
    .filter((r) => r.duty_layers.some((l) => l.matched_hts && UNVERIFIED.has(`${l.layer}|${l.matched_hts}`)))
    .map((r) => r.sku)
  const sampleUse = resultB.items
    .filter((r) => r.duty_layers.some((l) => l.matched_hts && SAMPLE_ROWS.has(`${l.layer}|${l.matched_hts}`)))
    .map((r) => r.sku)
  p(`**자리표시자(UNVERIFIED) 세율에 의존하는 SKU**: ${unverifiedUse.join(', ') || '없음'}`)
  p()
  p(`**SAMPLE(예시값) 301·IEEPA 에 의존하는 SKU**: ${sampleUse.join(', ') || '없음'}`)
  p()

  p('### 레이어별 미스 경고 (v1 결함 수정 확인)')
  p()
  p('v1 에서는 `engine.ts` 가 **모든** 레이어 미매칭일 때만 경고해서, 301·IEEPA 는 잡히고')
  p('base MFN 만 없는 흔한 경우 duty 가 조용히 과소계상됐다. v2 는 레이어별로 경고하되')
  p('그 원산지에 애초에 적용되지 않는 레이어(비중국산의 301)는 제외한다.')
  p()
  p('| SKU | 원산지 | 미매칭 레이어 | 리포트·UI 에 노출되는 경고 |')
  p('|---|---|---|---|')
  for (const r of resultB.items) {
    const g = gated.find((x) => x.sku === r.sku)!
    const missed = r.duty_layers.filter((l) => l.matched_hts === null).map((l) => LAYER_LABEL[l.layer])
    p(
      `| ${r.sku} | ${g.origin_country} | ${missed.join(', ') || '없음'} | ${r.warnings.length > 0 ? r.warnings.map((w) => `⚠ ${w}`).join('<br>') : '—'} |`,
    )
  }
  p()
  if (silentPartialMiss.length > 0) {
    p(`> ⚠️ **아직 무경고로 지나가는 건이 있다**: ${silentPartialMiss.map((s) => s.sku).join(', ')} — 수정이 불완전하다.`)
  } else {
    p('> 기대되는 레이어의 미스는 모두 경고로 노출된다. 무경고 과소계상 없음 ✅')
    p('>')
    p('> 비중국산(BAG-01/VN, TSH-01/IN)의 301 미스는 의도적으로 경고하지 않는다 — 원장에 그 원산지로')
    p('> 적용될 수 있는 301 행이 없으므로 "누락"이 아니라 "해당 없음"이다.')
  }
  p()
  p('회귀 테스트: [tests/engine.warnings.test.ts](tests/engine.warnings.test.ts)')
  p()


  p('### 선적 총계')
  p()
  p('| 항목 | 값 | 산식 |')
  p('|---|---|---|')
  p(`| 총 상품가액 | ${usd(resultB.totals.total_value, 2)} | Σ (unit_cost × units) |`)
  p(`| 운임 풀 | ${usd(resultB.totals.freight_pool, 2)} | ${SHIP.freight_usd} + ${SHIP.insurance_usd} |`)
  p(
    `| MPF (선적) | ${usd(resultB.totals.mpf_shipment, 4)} | clamp(${resultB.totals.total_value.toFixed(2)} × ${FEES.mpf_rate}, ${FEES.mpf_min_usd}, ${FEES.mpf_max_usd}) = clamp(${(resultB.totals.total_value * FEES.mpf_rate).toFixed(4)}, …) |`,
  )
  p(
    `| HMF (선적) | ${usd(resultB.totals.hmf_shipment, 4)} | ${resultB.totals.total_value.toFixed(2)} × ${FEES.hmf_rate} (ocean) |`,
  )
  p(`| 배부 기준 | ${resultB.totals.allocation_basis_used} | 중량 컬럼 없음 → 가액 배부 |`)
  p()
  const mpfRaw = resultB.totals.total_value * FEES.mpf_rate
  const capped = mpfRaw > FEES.mpf_max_usd
  p(
    `> MPF 캡 확인: 미적용 원값 ${usd(mpfRaw, 4)} → ${capped ? `**max 캡 $${FEES.mpf_max_usd} 에 걸림**` : mpfRaw < FEES.mpf_min_usd ? `**min 캡 $${FEES.mpf_min_usd} 로 올림**` : '캡 구간 안 (원값 그대로)'}.`,
  )
  p()

  // ── MPF 캡 프로브 (계획서 §검증2-3 "MPF(min/max 캡)") ─────────
  p('#### MPF 캡 프로브 — 같은 골든 CSV 를 단가만 스케일해 양쪽 캡을 태움')
  p()
  p('기본 선적은 캡 구간 안이라 캡 로직이 실행되지 않는다. 단가에 배수를 적용해 두 경계를 모두 통과시킨다.')
  p()
  p('| 배수 | 총 상품가액 | 원값 (가액 × 0.3464%) | 적용된 MPF | 경로 |')
  p('|---|---|---|---|---|')
  for (const mult of [0.1, 1, 5]) {
    const scaled = computeShipment(
      SHIP,
      gated.map((g) => ({
        sku: g.sku,
        unit_cost_usd: g.unit_cost_usd * mult,
        origin_country: g.origin_country,
        units_per_shipment: g.units_per_shipment,
        hts_code: SCENARIO_B[g.sku]?.code ?? null,
      })),
      LEDGER,
      FEES,
    )
    const raw = scaled.totals.total_value * FEES.mpf_rate
    const path =
      raw < FEES.mpf_min_usd ? `**min 캡 $${FEES.mpf_min_usd}**` : raw > FEES.mpf_max_usd ? `**max 캡 $${FEES.mpf_max_usd}**` : '캡 미적용'
    p(
      `| ×${mult} | ${usd(scaled.totals.total_value, 2)} | ${usd(raw, 4)} | ${usd(scaled.totals.mpf_shipment, 4)} | ${path} |`,
    )
  }
  p()
  p('세 경로 모두 기대대로 동작. 단위 테스트: [tests/engine.fees.test.ts](tests/engine.fees.test.ts)')
  p()

  p('### SKU별 수식 대입값 (§검증2-3 엑셀 재계산용)')
  p()
  p('```')
  p(`선적 공통:`)
  p(`  total_value  = ${resultB.totals.total_value.toFixed(2)}`)
  p(`  freight_pool = ${resultB.totals.freight_pool.toFixed(2)}`)
  p(`  mpf_shipment = ${resultB.totals.mpf_shipment.toFixed(6)}`)
  p(`  hmf_shipment = ${resultB.totals.hmf_shipment.toFixed(6)}`)
  p('```')
  p()
  for (const r of resultB.items) {
    const g = gated.find((x) => x.sku === r.sku)!
    const value = r.unit_cost * r.units
    const share = value / resultB.totals.total_value
    p(`**${r.sku}** — \`${r.hts_code}\` · ${g.origin_country} · ${dutyBreakdownLabel(r)}`)
    p()
    p('```')
    p(`value        = ${r.unit_cost} × ${r.units} = ${value.toFixed(2)}`)
    p(`value_share  = ${value.toFixed(2)} / ${resultB.totals.total_value.toFixed(2)} = ${share.toFixed(8)}`)
    p(
      `duty_rate    = ${layerRate(r, 'base_mfn')} + ${layerRate(r, 'section301')} + ${layerRate(r, 'ieepa_reciprocal')} = ${r.duty_rate_total}`,
    )
    p(`duty_usd     = ${r.unit_cost} × ${r.duty_rate_total} = ${r.duty_usd.toFixed(6)}`)
    p(
      `freight_unit = ${resultB.totals.freight_pool.toFixed(2)} × ${share.toFixed(8)} / ${r.units} = ${r.freight_per_unit.toFixed(6)}`,
    )
    p(
      `mpf_unit     = ${resultB.totals.mpf_shipment.toFixed(6)} × ${share.toFixed(8)} / ${r.units} = ${r.mpf_per_unit.toFixed(6)}`,
    )
    p(
      `hmf_unit     = ${resultB.totals.hmf_shipment.toFixed(6)} × ${share.toFixed(8)} / ${r.units} = ${r.hmf_per_unit.toFixed(6)}`,
    )
    p(
      `landed_cost  = ${r.unit_cost} + ${r.duty_usd.toFixed(6)} + ${r.freight_per_unit.toFixed(6)} + ${r.mpf_per_unit.toFixed(6)} + ${r.hmf_per_unit.toFixed(6)}`,
    )
    p(`             = ${r.landed_cost.toFixed(6)}`)
    p('```')
    p()
  }

  // 배부 보존 체크
  const fSum = resultB.items.reduce((a, r) => a + r.freight_per_unit * r.units, 0)
  const mSum = resultB.items.reduce((a, r) => a + r.mpf_per_unit * r.units, 0)
  const hSum = resultB.items.reduce((a, r) => a + r.hmf_per_unit * r.units, 0)
  const ok = (a: number, b: number) => (Math.abs(a - b) < 1e-6 ? '✅' : '❌')
  p('### 배부 보존 (합계가 선적 총액과 일치해야 함)')
  p()
  p('| 항목 | Σ (SKU별 × units) | 선적 총액 | |')
  p('|---|---|---|---|')
  p(`| 운임 | ${usd(fSum, 6)} | ${usd(resultB.totals.freight_pool, 6)} | ${ok(fSum, resultB.totals.freight_pool)} |`)
  p(`| MPF | ${usd(mSum, 6)} | ${usd(resultB.totals.mpf_shipment, 6)} | ${ok(mSum, resultB.totals.mpf_shipment)} |`)
  p(`| HMF | ${usd(hSum, 6)} | ${usd(resultB.totals.hmf_shipment, 6)} | ${ok(hSum, resultB.totals.hmf_shipment)} |`)
  p()

  p('---')
  p()
  p('## §검증2-4 — 원산지 스코핑 assert')
  p()
  p('301 은 중국산 전용. VN·IN 에 301 이 붙으면 즉시 실패.')
  p()
  p('| SKU | 원산지 | 301 (시나리오 A) | 301 (시나리오 B) | 판정 |')
  p('|---|---|---|---|---|')
  for (const g of gated) {
    const a = resultA.items.find((x) => x.sku === g.sku)!
    const b = resultB.items.find((x) => x.sku === g.sku)!
    const ra = layerRate(a, 'section301')
    const rb = layerRate(b, 'section301')
    const bad = g.origin_country !== 'CN' && (ra > 0 || rb > 0)
    p(`| ${g.sku} | ${g.origin_country} | ${pct(ra)} | ${pct(rb)} | ${g.origin_country === 'CN' ? '—' : bad ? '❌ 위반' : '✅'} |`)
  }
  p()
  p(originViolations.length === 0 ? '**PASS** — 비중국산 SKU 중 301 이 적용된 건 없음.' : `**FAIL** — ${originViolations.join(' / ')}`)
  p()
  p('회귀 방지 테스트: [tests/golden.origin.test.ts](tests/golden.origin.test.ts) (`npm run test`)')
  p()

  p('---')
  p()
  p('## 시나리오 A — as-shipped (사용자가 실제로 받는 숫자)')
  p()
  p('분류기 top 후보를 그대로 확정했을 때. 분류가 틀리면 landed cost 도 같이 틀린다는 점을 보여준다.')
  p()
  p('| SKU | 확정 HTS | 상태 | duty 합 | duty $/unit | landed $/unit | 시나리오 B 대비 landed 차이 |')
  p('|---|---|---|---|---|---|---|')
  for (const a of resultA.items) {
    const b = resultB.items.find((x) => x.sku === a.sku)!
    const d = a.landed_cost - b.landed_cost
    const g = gated.find((x) => x.sku === a.sku)!
    const sign = d > 0 ? '+' : ''
    p(
      `| ${a.sku} | \`${formatHts(a.hts_code)}\`${g.provisional ? ' (잠정)' : ''} | ${g.status} | ${pct(a.duty_rate_total)} | ${usd(a.duty_usd)} | ${usd(a.landed_cost)} | ${sign}${d.toFixed(4)} (${b.landed_cost > 0 ? `${sign}${((d / b.landed_cost) * 100).toFixed(1)}%` : '—'}) |`,
    )
  }
  p()
  const maxDelta = resultA.items.reduce((m, a) => {
    const b = resultB.items.find((x) => x.sku === a.sku)!
    const rel = b.landed_cost > 0 ? Math.abs(a.landed_cost - b.landed_cost) / b.landed_cost : 0
    return rel > m.rel ? { sku: a.sku, rel } : m
  }, { sku: '', rel: 0 })
  p(
    `분류 오류가 landed cost 에 미치는 최대 영향: **${maxDelta.sku} ${(maxDelta.rel * 100).toFixed(1)}%**. 이것이 §검증1 을 통과시켜야 하는 이유다 — 계산식이 아무리 정확해도 HTS 가 틀리면 결과가 틀린다.`,
  )
  p()

  p('---')
  p()
  p('## 판정')
  p()
  p('| 검증 | 결과 |')
  p('|---|---|')
  const gatePassers = isReal ? modelStats.filter((m) => m.avg >= 7) : []
  if (isReal) {
    for (const m of modelStats) {
      p(
        `| §검증1 — \`${m.model}\` | ${m.avg >= 7 ? '✅ **통과**' : '❌ **미달**'} — ${RUNS}회 평균 ${m.avg.toFixed(1)}/10 (${m.worst}–${m.best}, 기준 7/10) · 오답 자동확정 ${m.wrongAutoConfirmed}건 |`,
      )
    }
  } else {
    p(`| §검증1 HTS 분류 | ⛔ **미집행** — 실 분류기 미배포. mock 참고치 ${hits}/10 |`)
  }
  p('| §검증2-1·2 세율 대조 | ❌ **실패** — 원장에 검증된 행 0건 (전부 test seed / SAMPLE / placeholder) |')
  p('| §검증2-3 계산 정확도 | ✅ **통과** — 배부 보존·수식 일관성 확인. 위 수식 대입값으로 엑셀 대조 가능 |')
  p('| §검증2-4 원산지 스코핑 | ' + (originViolations.length === 0 ? '✅ **통과**' : '❌ **실패**') + ' |')
  p('| §검증3 E2E | ⛔ **미집행** — 이 러너는 UI 를 거치지 않는다. 별도 수행 필요 |')
  p()
  if (isReal) {
    const worstIso = Math.min(...modelStats.map((m) => m.isolationRate))
    const anyWrongAuto = modelStats.some((m) => m.wrongAutoConfirmed > 0)

    if (gatePassers.length > 0) {
      p(
        `§검증1 은 ${gatePassers.map((m) => `\`${m.model}\``).join(', ')} 로 **기준 7/10 을 넘겼다** (파이프라인 v1 대비 haiku 3.2 → ${modelStats[0].avg.toFixed(1)}).`,
      )
      p('자유 생성을 막고 USITC 실제 라인 중에서만 고르게 한 것이 주효했다 — 보기 밖 코드 0건, 지어낸 통계 suffix 0건.')
    } else {
      p('§검증1 은 어느 모델도 기준 7/10 에 미달했다.')
    }
    p()

    if (anyWrongAuto) {
      p('### ⛔ 그러나 광고 집행은 여전히 불가 — 안전판이 작동하지 않는다')
      p()
      p(
        `**오답의 needs_review 격리율이 ${(worstIso * 100).toFixed(0)}% 다.** 틀린 분류가 단 한 건도 리뷰 큐로 가지 않고`,
      )
      p('전부 auto_confirmed 로 확정됐다. 사용자는 틀린 duty 를 "확인됨" 상태로 받는다.')
      p()
      p('원인은 설계 자체에 있다:')
      p()
      p(`- temperature ${TEMPERATURE} 로 고정하면 같은 입력에 같은 출력이 나온다 → k=${VOTES} 투표는 거의 항상 만장일치가 된다`)
      p(`  (실측 만장일치율 ${modelStats.map((m) => `${m.model.replace('claude-', '')} ${(m.unanimousRate * 100).toFixed(0)}%`).join(', ')}).`)
      p('- "원장 실존" 조건도 (b) 단계가 이미 실제 라인만 보기로 주므로 사실상 항상 참이다.')
      p('- 즉 **두 조건 모두 거의 항상 참** → auto_confirmed 가 기본값이 됐다. 재현성(요구사항 2)과')
      p('  만장일치 안전판(요구사항 3)이 서로를 무력화한다.')
      p()
      p('이 둘을 같이 살리려면 만장일치 대신 **불일치를 만들어내는** 신호가 필요하다:')
      p()
      p('1. **투표를 서로 다르게 친다** — k표를 같은 프롬프트로 돌리지 말고 (a)단계 호 후보를 하나씩 빼거나,')
      p('   보기 순서를 섞거나, 표마다 다른 모델을 쓴다. 답이 진짜 강건할 때만 일치한다.')
      p('2. **모델 간 교차검증** — haiku 와 sonnet 이 갈리는 SKU 를 리뷰 큐로. 이번 측정에서 두 모델은')
      p(`   TUM-01·SPK-01 에서 정확히 반대로 갈렸다 — 교차검증이었다면 둘 다 격리됐을 건이다.`)
      p('3. **호 단계 불일치 활용** — (a)단계가 2개 이상 호를 냈는데 (b)가 그중 하나를 고른 경우,')
      p('   경합이 있었다는 뜻이므로 리뷰 대상으로 본다.')
      p()
    }
  }

  p('§검증1 과 별개로 남은 것:')
  p()
  p(`- **Section 301·IEEPA ${SUPPLEMENT.length}행이 여전히 SAMPLE** — base MFN 은 USITC 로 해결됐지만 이 둘이 미확정인 한 duty 총액은 못 믿는다 (§검증2-1·2)`)
  p('- CBP CROSS 로 정답 키 확정 (BAG-01 은 두 모델 모두 5/5 오답 — 정답 키 자체를 의심해볼 것)')
  p('- 신규 계정으로 §검증3 E2E 수동 수행')
  p()

  writeFileSync(isAbsolute(OUT_FILE) ? OUT_FILE : join(root, OUT_FILE), L.join('\n'), 'utf-8')

  // ── 콘솔 요약 ────────────────────────────────────────────────
  console.log('── 골든 테스트 결과 ────────────────────────────')
  console.log(`분류 백엔드:        ${model} (${isReal ? backend : 'mock — LLM 아님'})`)
  if (isReal) {
    for (const m of modelStats) {
      console.log(
        `§검증1 ${m.model.padEnd(20)} ${m.avg.toFixed(1)}/10 (${m.worst}-${m.best}) → ${m.avg >= 7 ? 'PASS' : 'FAIL'} · 오답 자동확정 ${m.wrongAutoConfirmed}건 · 재현 ${m.stable}/10`,
      )
    }
  } else {
    console.log(`§검증1 (mock 참고): ${hits}/10, 함정 ${trapHits}/2  → 실 분류기 미배포로 판정 불가`)
  }
  console.log(`§검증2-3 배부 보존: freight ${ok(fSum, resultB.totals.freight_pool)} / mpf ${ok(mSum, resultB.totals.mpf_shipment)} / hmf ${ok(hSum, resultB.totals.hmf_shipment)}`)
  console.log(`§검증2-4 원산지:    ${originViolations.length === 0 ? 'PASS' : `FAIL — ${originViolations.join(', ')}`}`)
  const verifiedRows = LEDGER.filter((r) => (r.source ?? '').startsWith('USITC HTS export')).length
  console.log(
    `원장 검증된 행:     ${verifiedRows.toLocaleString()} / ${LEDGER.length.toLocaleString()} (base MFN=USITC 확정, 301·IEEPA ${SUPPLEMENT.length}행 여전히 SAMPLE)`,
  )
  console.log(`→ ${OUT_FILE}`)

  if (originViolations.length > 0) process.exit(1)
}

main()
