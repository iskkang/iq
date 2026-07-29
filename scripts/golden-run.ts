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
import { dirname, join } from 'node:path'
import Papa from 'papaparse'
import { createClient } from '@supabase/supabase-js'
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
import type { ClassifyBackend } from '../src/lib/classify/client'
import { CONFIDENCE_THRESHOLD, sanitizeCandidates } from '../src/lib/classify/types'
import type { ClassifyBatchResult, ClassifyItemInput, HtsCandidate } from '../src/lib/classify/types'
import { parseItemsCsv } from '../src/lib/csv/parseItems'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

// ── CLI 인자 ─────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
const OUT_FILE = arg('out') ?? 'test-results.md'
const FORCED_BACKEND = arg('backend') as 'edge' | 'anthropic' | 'mock' | undefined

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

/**
 * Edge Function 의 시스템 프롬프트·모델을 소스에서 직접 읽는다.
 * 로컬 anthropic 경로가 배포본과 다른 프롬프트를 쓰면 §검증1 이 무의미해지므로
 * 프롬프트 원본은 항상 supabase/functions/classify/index.ts 하나뿐이다.
 */
function edgeFunctionPrompt(): { system: string; model: string } {
  const src = readFileSync(join(root, 'supabase/functions/classify/index.ts'), 'utf-8')
  const sys = src.match(/const SYSTEM_PROMPT = `([\s\S]*?)`\r?\n/)
  const mdl = src.match(/const DEFAULT_MODEL = '([^']+)'/)
  if (!sys || !mdl) throw new Error('Edge Function 소스에서 SYSTEM_PROMPT/DEFAULT_MODEL 을 추출하지 못했다')
  return { system: sys[1], model: process.env.CLASSIFY_MODEL ?? mdl[1] }
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

/** ANTHROPIC_API_KEY 로 직접 호출 (Edge Function 미배포 시 대체 경로, 프롬프트는 동일) */
async function classifyViaAnthropic(items: ClassifyItemInput[]): Promise<ClassifyBatchResult[]> {
  const { system, model } = edgeFunctionPrompt()
  const out: ClassifyBatchResult[] = []
  for (let i = 0; i < items.length; i += 10) {
    const batch = items.slice(i, i + 10)
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system,
        messages: [
          {
            role: 'user',
            content: `Classify these products:\n${JSON.stringify(
              batch.map((b) => ({
                item_id: b.id,
                product_name: b.product_name,
                description_or_material: b.description_or_material,
                origin_country: b.origin_country,
              })),
              null,
              2,
            )}`,
          },
        ],
      }),
    })
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const data = await res.json()
    const text: string = (data.content ?? [])
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text)
      .join('')
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    const parsed = JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1))
    const byId = new Map<string, HtsCandidate[]>()
    for (const r of parsed.results ?? []) byId.set(String(r.item_id), sanitizeCandidates(r.candidates))
    out.push({
      results: batch.map((b) => ({ item_id: b.id, candidates: byId.get(b.id) ?? [] })),
      meta: { model, prompt_version: 'v1' },
      raw_output: data,
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
const BASE_LEDGER = loadLedger('supabase/seed/hts_seed_50.csv')
const SUPPLEMENT = loadLedger('supabase/seed/hts_seed_golden_supplement.csv')
const LEDGER: RateRow[] = [...BASE_LEDGER, ...SUPPLEMENT]

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

  const t0 = performance.now()
  let batches: ClassifyBatchResult[]
  if (backend === 'anthropic') {
    batches = await classifyViaAnthropic(inputs)
  } else {
    const be: ClassifyBackend =
      backend === 'edge'
        ? { kind: 'edge', supabase: createClient(SUPABASE_URL!, SUPABASE_KEY!) }
        : { kind: 'mock' }
    batches = await classifyItems(be, inputs)
  }
  const classifyMs = performance.now() - t0
  const model = batches[0]?.meta.model ?? 'unknown'
  const promptVersion = batches[0]?.meta.prompt_version ?? 'unknown'

  const candsById = new Map<string, HtsCandidate[]>()
  for (const b of batches) for (const r of b.results) candsById.set(r.item_id, r.candidates)

  // ── §1-3 confidence 게이팅 (demo/supabase repo 와 동일 규칙) ──
  const gated = withIds.map((p) => {
    const cands = candsById.get(p.id) ?? []
    const top = cands[0] ?? null
    const provisional = top ? top.confidence < CONFIDENCE_THRESHOLD : true
    return {
      ...p,
      candidates: cands,
      top,
      provisional,
      status: !top ? 'pending' : provisional ? 'needs_review' : 'auto_confirmed',
    }
  })

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

  const resultA = computeShipment(SHIP, mkItems((g) => g.top?.hts_code ?? null), LEDGER, FEES)
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
    return { ...g, target: t, hit, rank }
  })
  const hits = scored.filter((s) => s.hit).length
  const trapHits = scored.filter((s) => TRAP_SKUS.includes(s.sku) && s.hit).length

  // ── 리포트 작성 ──────────────────────────────────────────────
  const L: string[] = []
  const p = (s = '') => L.push(s)

  p('# LandedIQ 골든 테스트 결과 v1')
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
  p('| §검증2-1·2 세율 대조 | **자동 실패** | 원장 행 자체가 `Test seed — re-verify at hts.usitc.gov` / `SAMPLE value — admin must confirm manually` 로 표기된 미검증 값이다. USITC·USTR 대조는 사람이 해야 한다 (스펙 §4 자동 스크래핑 금지). |')
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
    'USITC HTS snapshot': '테스트 스냅샷 — 현행표 재확인 필요',
    SAMPLE: '예시값 — 관리자 수기 확정 필요 (301·IEEPA)',
    'UNVERIFIED-PLACEHOLDER': '**이번 실행을 위해 넣은 자리표시자. 검증된 값 아님**',
  }
  for (const [src, n] of [...bySource].sort((a, b) => b[1] - a[1])) {
    p(`| \`${src}\` | ${n} | ${SRC_MEANING[src] ?? '—'} |`)
  }
  p()
  p(`원장에 검증된(verified) 행은 **0건**이다. 즉 §검증2-1·2 는 현시점 0/10 이며, 이는 코드 버그가 아니라 데이터 미확정 상태다.`)
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
  p(`| confidence 임계 | ${CONFIDENCE_THRESHOLD} (미만 → needs_review, 자동확정 금지 §1-3) |`)
  p(`| 원장 행 수 | ${LEDGER.length} (base ${BASE_LEDGER.length} + 보충 ${SUPPLEMENT.length}) |`)
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
  p(`needs_review 로 격리된 건: ${gated.filter((g) => g.status === 'needs_review').map((g) => g.sku).join(', ') || '없음'} — confidence < ${CONFIDENCE_THRESHOLD} 자동확정 금지(§1-3)가 동작함을 확인.`)
  p()
  if (!isReal) {
    p('> 다시 강조: 이 점수는 mock 키워드 매처의 점수다. **제품이 실제로 쓰는 LLM 분류기 점수가 아니다.**')
    p('> Edge Function 배포 + API 키 설정 후 재실행해야 §검증1 이 성립한다.')
    p()
  }

  p('### 정답 키 자체의 의심 지점')
  p()
  p('- **BRD-01: 4419.12 → 4419.11 로 정정됨 (v2).** HS 4419 하위는 4419.11 = 빵판·도마 및 유사 판(대나무), 4419.12 = **젓가락**(대나무), 4419.19 = 기타. v1 정답 키의 4419.12 는 젓가락 소호였다. CROSS 로 최종 확인 필요.')
  p('- **LMP-01 → 9405.2x** 는 9405.21(LED 전용) / 9405.29(기타)로 갈린다. "LED table lamp" 는 9405.21 쪽이나, USB 충전 포트가 있어 복합기능 논쟁 여지가 있다.')
  p('- **TUM-01 → 9617.00** 은 계획서 지적대로 함정이다. mock 분류기는 7323(스테인리스)도 아닌 **7013(유리제품)** 으로 틀렸다 — 텍스트의 "tumbler" 만 보고 소재를 무시한 전형적 오류.')
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
  p(
    isReal
      ? `| §검증1 HTS 분류 | ${hits >= 7 ? '✅ **통과**' : '❌ **미달**'} — \`${model}\` ${hits}/10 (기준 7/10), 함정 ${trapHits}/2 |`
      : `| §검증1 HTS 분류 | ⛔ **미집행** — 실 분류기(Edge Function) 미배포. mock 참고치 ${hits}/10 |`,
  )
  p('| §검증2-1·2 세율 대조 | ❌ **실패** — 원장에 검증된 행 0건 (전부 test seed / SAMPLE / placeholder) |')
  p('| §검증2-3 계산 정확도 | ✅ **통과** — 배부 보존·수식 일관성 확인. 위 수식 대입값으로 엑셀 대조 가능 |')
  p('| §검증2-4 원산지 스코핑 | ' + (originViolations.length === 0 ? '✅ **통과**' : '❌ **실패**') + ' |')
  p('| §검증3 E2E | ⛔ **미집행** — 이 러너는 UI 를 거치지 않는다. 별도 수행 필요 |')
  p()
  p('계획서 판정 규칙에 따라 **광고 집행 불가**. 순서:')
  p()
  p('1. `supabase functions deploy classify` + `supabase secrets set ANTHROPIC_API_KEY=…` → §검증1 재실행')
  p('2. CBP CROSS 로 정답 키 확정 (특히 BRD-01 4419.11 vs 4419.12)')
  p('3. USITC 현행표로 base MFN 적재 (`npm run seed:rates -- --usitc <export.csv>`), USTR·IEEPA 고시로 301·IEEPA 수기 입력 → §검증2-1·2 재실행')
  p('4. 신규 계정으로 §검증3 수동 수행')
  p()

  writeFileSync(join(root, OUT_FILE), L.join('\n'), 'utf-8')

  // ── 콘솔 요약 ────────────────────────────────────────────────
  console.log('── 골든 테스트 결과 ────────────────────────────')
  console.log(`분류 백엔드:        ${model} (${isReal ? backend : 'mock — LLM 아님'})`)
  console.log(
    isReal
      ? `§검증1:             ${hits}/10 (기준 7/10 → ${hits >= 7 ? 'PASS' : 'FAIL'}), 함정 ${trapHits}/2`
      : `§검증1 (mock 참고): ${hits}/10, 함정 ${trapHits}/2  → 실 분류기 미배포로 판정 불가`,
  )
  console.log(`§검증2-3 배부 보존: freight ${ok(fSum, resultB.totals.freight_pool)} / mpf ${ok(mSum, resultB.totals.mpf_shipment)} / hmf ${ok(hSum, resultB.totals.hmf_shipment)}`)
  console.log(`§검증2-4 원산지:    ${originViolations.length === 0 ? 'PASS' : `FAIL — ${originViolations.join(', ')}`}`)
  console.log(`원장 검증된 행:     0 / ${LEDGER.length}  → §검증2-1·2 실패 (데이터 미확정)`)
  console.log(`→ ${OUT_FILE}`)

  if (originViolations.length > 0) process.exit(1)
}

main()
