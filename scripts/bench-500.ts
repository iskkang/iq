/**
 * §6-2 벤치마크: CSV 500행 업로드 → 리포트까지 3분 이내 + **SKU당 API 비용**.
 *
 * v2 파이프라인은 배치당 LLM 호출이 1 → 최대 6회(2단계 × k=3)로 늘었다.
 * 시간뿐 아니라 비용도 재야 한다 — 2단계×k=3 이면 $29/50SKU 플랜의 마진이 깨질 수 있다.
 *
 * 두 축을 측정한다:
 *   A. 결정론 파이프라인 실측 (mock 분류) — 파싱·계산·리포트 생성 시간
 *   B. 실 LLM 비용 — 소표본(--sample=N)을 실제로 호출해 SKU당 토큰·USD 를 재고,
 *      500 SKU 로 외삽한다. 캐시 히트율 가정별로 함께 낸다.
 *
 * 실행:
 *   npm run bench                 # A 만 (LLM 호출 없음)
 *   npm run bench -- --sample=10  # A + B (10 SKU 실호출 후 외삽)
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Papa from 'papaparse'
import { computeShipment, dutyBreakdownLabel } from '../src/lib/calc/engine'
import { round2, round4 } from '../src/lib/calc/money'
import { formatHts } from '../src/lib/calc/rates'
import type { CalcItem, FeeSettings, RateLayer, RateRow } from '../src/lib/calc/types'
import { classifyItems } from '../src/lib/classify/client'
import { resolveStatus } from '../src/lib/classify/status'
import { parseItemsCsv } from '../src/lib/csv/parseItems'
import { coverageOfTopN, rankReviewQueue } from '../src/lib/classify/reviewQueue'
import {
  CROSS_CHECK_MODEL,
  PRIMARY_MODEL,
  addUsage,
  costOf,
  emptyUsage,
  planMargins,
  PRICING,
  type TokenUsage,
} from '../src/lib/classify/models'
import {
  MAX_LINES_PER_HEADING,
  STAGE_A_SYSTEM,
  STAGE_B_SYSTEM,
  TEMPERATURE,
  VOTES,
  extractJson,
  parseStageA,
  parseStageB,
  stageAUser,
  stageBPrompt,
} from '../supabase/functions/classify/pipeline'
import type { CatalogLine } from '../supabase/functions/classify/pipeline'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arg = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1]
const SAMPLE = Number(arg('sample') ?? 0)

function dotenv(name: string): string | undefined {
  if (process.env[name]) return process.env[name]
  const f = join(root, '.env')
  if (!existsSync(f)) return undefined
  const m = readFileSync(f, 'utf-8').match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)\\s*$`, 'm'))
  return m ? m[1].replace(/^["']|["']$/g, '') : undefined
}

// ── 시드 원장 ────────────────────────────────────────────────
const seedCsv = readFileSync(join(root, 'supabase/seed/hts_seed_50.csv'), 'utf-8')
const LEDGER: RateRow[] = Papa.parse<Record<string, string>>(seedCsv, {
  header: true,
  skipEmptyLines: true,
}).data.map((r) => ({
  hts_code: r.hts_code.trim(),
  origin_country: r.origin_country?.trim() ? r.origin_country.trim().toUpperCase() : null,
  layer: r.layer.trim() as RateLayer,
  ad_valorem_rate: Number(r.ad_valorem_rate),
  effective_from: r.effective_from.trim(),
  effective_to: r.effective_to?.trim() ? r.effective_to.trim() : null,
}))
const FEES: FeeSettings = {
  mpf_rate: 0.003464,
  mpf_min_usd: 32.71,
  mpf_max_usd: 634.62,
  hmf_rate: 0.00125,
  effective_from: '2024-10-01',
}

// ── 500행 CSV 생성 ──────────────────────────────────────────
const NAMES = [
  'Ceramic Mug', 'Cotton T-Shirt', 'Plastic Bottle', 'Backpack', 'Frying Pan',
  'USB Cable', 'Wooden Toy', 'Bath Towel', 'Headphones', 'Throw Pillow',
  'Desk Lamp Widget', 'Mystery Gadget', 'Glass Tumbler', 'Imitation Necklace', 'Bicycle Part',
]
const MATS = ['ceramic stoneware', 'cotton knit', 'plastic PP', 'polyester textile', 'stainless steel',
  'insulated cable', 'wood educational toy', 'cotton terry', 'wireless audio', 'polyester cushion',
  'unknown alloy', 'misc composite', 'glassware', 'base metal jewelry', 'aluminum']
const ORIGINS = ['CN', 'VN', 'IN', 'TH', 'MX']

const header = 'sku,product_name,description_or_material,unit_cost_usd,origin_country,units_per_shipment,current_price_usd'
const rows: string[] = [header]
for (let i = 0; i < 500; i++) {
  const n = i % NAMES.length
  const cost = (0.5 + (i % 40) * 0.37).toFixed(2)
  const units = 50 + (i % 20) * 25
  const price = (Number(cost) * (3 + (i % 5))).toFixed(2)
  rows.push(`SKU-${String(i + 1).padStart(4, '0')},${NAMES[n]} v${i},"${MATS[n]}",${cost},${ORIGINS[i % ORIGINS.length]},${units},${price}`)
}
const csv500 = rows.join('\n')

// ── B: 실 LLM 비용 측정 ─────────────────────────────────────
interface CallUsage { model: string; usage: TokenUsage }

async function callWithUsage(
  model: string,
  system: string,
  user: string,
  cached?: string,
): Promise<{ parsed: unknown; call: CallUsage }> {
  const content = cached
    ? [
        { type: 'text', text: cached, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: user },
      ]
    : [{ type: 'text', text: user }]
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': dotenv('ANTHROPIC_API_KEY')!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 4096, temperature: TEMPERATURE, system, messages: [{ role: 'user', content }] }),
  })
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  const text: string = (data.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('')
  return {
    parsed: extractJson(text),
    call: {
      model,
      usage: {
        input_tokens: data.usage?.input_tokens ?? 0,
        output_tokens: data.usage?.output_tokens ?? 0,
        cache_read_input_tokens: data.usage?.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: data.usage?.cache_creation_input_tokens ?? 0,
      },
    },
  }
}

/** 한 배치(≤10 SKU)를 v2 파이프라인 그대로 돌리고 호출별 usage 를 모은다 */
async function measureBatch(batch: Array<{ id: string; product_name: string; description_or_material: string; origin_country: string }>) {
  const catalogPath = join(root, 'data/hts_lines.json')
  if (!existsSync(catalogPath)) throw new Error('data/hts_lines.json 없음 — npm run hts:fetch')
  const lines: Array<{ code: string; heading: string; description: string }> = JSON.parse(readFileSync(catalogPath, 'utf-8'))
  const byHeading = new Map<string, CatalogLine[]>()
  for (const l of lines) {
    if (!byHeading.has(l.heading)) byHeading.set(l.heading, [])
    byHeading.get(l.heading)!.push(l)
  }

  const calls: CallUsage[] = []
  const a = await callWithUsage(PRIMARY_MODEL, STAGE_A_SYSTEM, stageAUser(batch))
  calls.push(a.call)
  const stageA = parseStageA(a.parsed)

  const linesByHeading = new Map<string, CatalogLine[]>()
  for (const h of new Set([...stageA.values()].flatMap((x) => x.headings))) {
    linesByHeading.set(h, (byHeading.get(h) ?? []).slice(0, MAX_LINES_PER_HEADING))
  }
  const { catalog, questions } = stageBPrompt(batch, stageA, linesByHeading)

  const votes = await Promise.all(
    Array.from({ length: VOTES }, async () => {
      const r = await callWithUsage(PRIMARY_MODEL, STAGE_B_SYSTEM, questions, catalog)
      calls.push(r.call)
      return parseStageB(r.parsed)
    }),
  )

  // 교차검증 (haiku) — 리뷰 큐 정렬용 1표
  const cross = await callWithUsage(CROSS_CHECK_MODEL, STAGE_B_SYSTEM, questions, catalog)
  calls.push(cross.call)
  const crossSel = parseStageB(cross.parsed)

  return { calls, stageA, votes, crossSel }
}

async function main() {
  const t0 = performance.now()

  // ── A: 결정론 파이프라인 ───────────────────────────────────
  const { items: parsed, errors } = parseItemsCsv(csv500)
  const t1 = performance.now()
  if (errors.length > 0 || parsed.length !== 500) {
    console.error(`파싱 실패: ${parsed.length}행, 오류 ${errors.length}건`, errors.slice(0, 3))
    process.exit(1)
  }

  const withIds = parsed.map((p, i) => ({ ...p, id: `it-${i}` }))
  const batches = await classifyItems(
    { kind: 'mock' },
    withIds.map((p) => ({
      id: p.id,
      product_name: p.product_name,
      description_or_material: p.description_or_material,
      origin_country: p.origin_country,
    })),
  )
  const t2 = performance.now()

  const htsById = new Map<string, { hts: string; provisional: boolean }>()
  let unreviewed = 0
  for (const b of batches)
    for (const r of b.results) {
      const top = r.candidates[0]
      if (!top) continue
      const status = resolveStatus(r)
      if (status !== 'user_confirmed') unreviewed++
      htsById.set(r.item_id, { hts: r.consensus?.code ?? top.hts_code, provisional: status !== 'user_confirmed' })
    }

  const calcItems: CalcItem[] = withIds.map((p) => ({
    sku: p.sku,
    unit_cost_usd: p.unit_cost_usd,
    origin_country: p.origin_country,
    units_per_shipment: p.units_per_shipment,
    current_price_usd: p.current_price_usd,
    hts_code: htsById.get(p.id)?.hts ?? null,
    provisional: htsById.get(p.id)?.provisional ?? true,
  }))

  const result = computeShipment(
    { freight_usd: 8000, insurance_usd: 300, mode: 'ocean', allocation_basis: 'value', target_margin: 0.3, channel_fee_pct: 0.15, rate_as_of: '2026-07-29' },
    calcItems, LEDGER, FEES,
  )
  const t3 = performance.now()

  const reportCsv = Papa.unparse(result.items.map((r) => ({
    SKU: r.sku, HTS: formatHts(r.hts_code), Duty: dutyBreakdownLabel(r),
    DutyUsd: round4(r.duty_usd), Landed: round4(r.landed_cost),
    Margin: r.true_margin !== null ? round4(r.true_margin) : '',
    Rec: r.recommended_price !== null ? round2(r.recommended_price) : '',
  })))
  const t4 = performance.now()
  const pipelineMs = t4 - t0

  console.log('── A. 결정론 파이프라인 (500 SKU) ──────────────')
  console.log(`파싱/검증:        ${(t1 - t0).toFixed(1)} ms`)
  console.log(`분류(mock 경로):  ${(t2 - t1).toFixed(1)} ms  (unreviewed ${unreviewed}건)`)
  console.log(`§4 계산(원장 ${LEDGER.length}행): ${(t3 - t2).toFixed(1)} ms`)
  console.log(`리포트 CSV:       ${(t4 - t3).toFixed(1)} ms  (${reportCsv.length.toLocaleString()} bytes)`)
  console.log(`합계:             ${pipelineMs.toFixed(1)} ms`)

  const freightSum = result.items.reduce((a, it) => a + it.freight_per_unit * it.units, 0)
  const allocOk = Math.abs(freightSum - 8300) < 0.001
  console.log(`운임 배부 보존:   Σ = ${freightSum.toFixed(4)} (기대 8300) → ${allocOk ? 'OK' : 'MISMATCH'}`)

  // ── 리뷰 큐 커버리지 ──────────────────────────────────────
  const ranked = rankReviewQueue(result.items.map((r) => ({
    sku: r.sku,
    hts_code: r.hts_code,
    duty_per_unit: r.duty_usd,
    units: r.units,
  })))
  console.log('')
  console.log('── 리뷰 큐 커버리지 (상위 N건이 duty 노출의 몇 %) ──')
  for (const n of [10, 20, 50]) {
    const c = coverageOfTopN(ranked, n)
    console.log(`  상위 ${String(n).padStart(3)}건: $${c.covered_usd.toFixed(0).padStart(8)} / $${c.total_usd.toFixed(0)} = ${(c.pct * 100).toFixed(1)}%`)
  }

  if (!SAMPLE) {
    console.log('')
    console.log('B(실 LLM 비용)는 --sample=N 으로 실행 (예: npm run bench -- --sample=10)')
    if (!allocOk) process.exit(1)
    return
  }

  // ── B: 실 LLM 비용 ────────────────────────────────────────
  console.log('')
  console.log(`── B. 실 LLM 비용 측정 (${SAMPLE} SKU 실호출) ──────`)
  const sample = withIds.slice(0, SAMPLE).map((p) => ({
    id: p.id,
    product_name: p.product_name,
    description_or_material: p.description_or_material,
    origin_country: p.origin_country,
  }))

  const tB = performance.now()
  const measured = await measureBatch(sample)
  const wallMs = performance.now() - tB

  const byModel = new Map<string, TokenUsage>()
  for (const c of measured.calls) byModel.set(c.model, addUsage(byModel.get(c.model) ?? emptyUsage(), c.usage))

  let total = 0
  console.log('')
  console.log('| 모델 | 호출 | in | 캐시 write | 캐시 read | out | USD |')
  console.log('|---|---|---|---|---|---|---|')
  for (const [model, u] of byModel) {
    const n = measured.calls.filter((c) => c.model === model).length
    const usd = costOf(model, u)
    total += usd
    console.log(
      `| ${model} | ${n} | ${u.input_tokens.toLocaleString()} | ${(u.cache_creation_input_tokens ?? 0).toLocaleString()} | ${(u.cache_read_input_tokens ?? 0).toLocaleString()} | ${u.output_tokens.toLocaleString()} | $${usd.toFixed(4)} |`,
    )
  }
  const writes = [...byModel.values()].reduce((a, u) => a + (u.cache_creation_input_tokens ?? 0), 0)
  const reads = [...byModel.values()].reduce((a, u) => a + (u.cache_read_input_tokens ?? 0), 0)
  if (writes > 0 && reads === 0) {
    console.log('')
    console.log('⚠ 이 표본은 배치 1개라 캐시를 **쓰기만 하고 읽지 못했다** (write 1.25배 프리미엄만 지불).')
    console.log('  실제 500 SKU 실행에서는 같은 호를 쓰는 뒤 배치가 read(0.1배)로 회수하므로')
    console.log('  아래 SKU당 비용은 **상한**이다. 회수 폭은 카탈로그의 호 중복도에 달렸다.')
  }

  const perSku = total / SAMPLE
  console.log('')
  console.log(`배치 wall-time:   ${(wallMs / 1000).toFixed(1)}s (${SAMPLE} SKU, 호출 ${measured.calls.length}회)`)
  console.log(`SKU당 비용:       $${perSku.toFixed(5)}  (주 ${PRIMARY_MODEL} + 교차 ${CROSS_CHECK_MODEL})`)
  console.log(`500 SKU 외삽:     $${(perSku * 500).toFixed(2)}`)

  // §6-2 시간 외삽: 배치10 × 동시8, 배치당 wall = stage A + stage B(3표 동시)
  const CONCURRENCY = 8
  const waves = Math.ceil(500 / 10 / CONCURRENCY)
  const estSec = (waves * wallMs) / 1000
  console.log('')
  console.log(`§6-2 시간 외삽:   50배치 ÷ 동시${CONCURRENCY} = ${waves}웨이브 × ${(wallMs / 1000).toFixed(1)}s = ${estSec.toFixed(0)}s (기준 180s) → ${estSec < 180 ? 'PASS' : 'FAIL'}`)

  // ── 플랜 마진 ─────────────────────────────────────────────
  console.log('')
  console.log('── 플랜 마진 (캐시 0% 가정, 최악) ──────────────')
  console.log('| 플랜 | 가격 | SKU 한도 | API 비용 | 총마진 |')
  console.log('|---|---|---|---|---|')
  for (const m of planMargins(perSku)) {
    const flag = m.gross_margin_pct < 0.7 ? ' ⚠️' : ''
    console.log(`| ${m.plan} | $${m.price_usd} | ${m.sku_quota} | $${m.api_cost_total.toFixed(2)} | ${(m.gross_margin_pct * 100).toFixed(1)}%${flag} |`)
  }

  console.log('')
  console.log('── 캐시 히트율별 SKU당 비용 ────────────────────')
  console.log('| 히트율 | SKU당 | Starter 마진 | Growth 마진 |')
  console.log('|---|---|---|---|')
  for (const hit of [0, 0.3, 0.5, 0.7, 0.9]) {
    const c = perSku * (1 - hit) // 캐시 히트 = LLM 재호출 없음 → 비용 0
    const [starter, growth] = planMargins(c)
    console.log(`| ${(hit * 100).toFixed(0)}% | $${c.toFixed(5)} | ${(starter.gross_margin_pct * 100).toFixed(1)}% | ${(growth.gross_margin_pct * 100).toFixed(1)}% |`)
  }
  console.log('')
  console.log(`캐시 최소 프리픽스: ${PRIMARY_MODEL} ${PRICING[PRIMARY_MODEL].cache_min_tokens} tok · ${CROSS_CHECK_MODEL} ${PRICING[CROSS_CHECK_MODEL].cache_min_tokens} tok`)
  console.log('  (분류 캐시는 프롬프트 캐시가 아니라 결과 캐시라 최소 길이 제약을 받지 않는다 —')
  console.log('   동일 상품 재업로드 시 LLM 호출 자체가 없다.)')

  if (!allocOk || estSec >= 180) process.exit(1)
}

main()
