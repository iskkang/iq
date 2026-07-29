/**
 * §6-2 벤치마크: CSV 500행 업로드 → 리포트까지 3분 이내.
 *
 * 측정 대상 (결정론적 파이프라인 전체):
 *   CSV 500행 생성 → 파싱/검증 → 분류(mock, 배치10×동시4 동일 경로)
 *   → §4 계산(원장 62행 조회 포함) → 리포트 CSV 생성
 *
 * LLM 실호출 시간은 별도 모델링: 500 SKU = 50콜(배치10) ÷ 동시4 = 13웨이브.
 * 웨이브당 8초(보수적)로 잡아도 ~104초. 파이프라인 실측치 + 104초 < 180초면 통과.
 *
 * 실행: npm run bench
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Papa from 'papaparse'
import { computeShipment, dutyBreakdownLabel } from '../src/lib/calc/engine'
import { round2, round4 } from '../src/lib/calc/money'
import { formatHts } from '../src/lib/calc/rates'
import type { CalcItem, FeeSettings, RateLayer, RateRow } from '../src/lib/calc/types'
import { classifyItems } from '../src/lib/classify/client'
import { CONFIDENCE_THRESHOLD } from '../src/lib/classify/types'
import { parseItemsCsv } from '../src/lib/csv/parseItems'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── 시드 원장 로드 (seedRates.ts는 vite ?raw 의존이라 node에서 직접 파싱) ──
const seedCsv = readFileSync(join(__dirname, '../supabase/seed/hts_seed_50.csv'), 'utf-8')
const parsedSeed = Papa.parse<Record<string, string>>(seedCsv, { header: true, skipEmptyLines: true })
const LEDGER: RateRow[] = parsedSeed.data.map((r) => ({
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

// ── 1) 500행 CSV 생성 ──────────────────────────────────────────
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

async function main() {
  const t0 = performance.now()

  // 2) 파싱/검증
  const { items: parsed, errors } = parseItemsCsv(csv500)
  const t1 = performance.now()
  if (errors.length > 0 || parsed.length !== 500) {
    console.error(`파싱 실패: ${parsed.length}행, 오류 ${errors.length}건`, errors.slice(0, 3))
    process.exit(1)
  }

  // 3) 분류 (mock — 실서비스와 동일한 배치/동시성 경로)
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

  // 4) 상태 전이 + §4 계산
  const htsById = new Map<string, { hts: string; provisional: boolean }>()
  let needsReview = 0
  for (const b of batches)
    for (const r of b.results) {
      const top = r.candidates[0]
      if (!top) continue
      const provisional = top.confidence < CONFIDENCE_THRESHOLD
      if (provisional) needsReview++
      htsById.set(r.item_id, { hts: top.hts_code, provisional })
    }

  const calcItems: CalcItem[] = withIds.map((p) => ({
    sku: p.sku,
    unit_cost_usd: p.unit_cost_usd,
    origin_country: p.origin_country,
    units_per_shipment: p.units_per_shipment,
    current_price_usd: p.current_price_usd,
    hts_code: htsById.get(p.id)?.hts ?? null,
    provisional: htsById.get(p.id)?.provisional ?? false,
  }))

  const result = computeShipment(
    {
      freight_usd: 8000, insurance_usd: 300, mode: 'ocean', allocation_basis: 'value',
      target_margin: 0.3, channel_fee_pct: 0.15, rate_as_of: '2026-07-01',
    },
    calcItems, LEDGER, FEES,
  )
  const t3 = performance.now()

  // 5) 리포트 CSV 생성 (exportReport와 동일 로직, DOM 없이)
  const reportRows = result.items.map((r) => ({
    SKU: r.sku,
    HTS: formatHts(r.hts_code),
    Duty: dutyBreakdownLabel(r),
    DutyUsd: round4(r.duty_usd),
    Landed: round4(r.landed_cost),
    Margin: r.true_margin !== null ? round4(r.true_margin) : '',
    Rec: r.recommended_price !== null ? round2(r.recommended_price) : '',
  }))
  const reportCsv = Papa.unparse(reportRows)
  const t4 = performance.now()

  const pipelineMs = t4 - t0
  const llmModeledSec = Math.ceil(500 / 10 / 4) * 8 // 13웨이브 × 8초 (보수적)
  const totalModeledSec = pipelineMs / 1000 + llmModeledSec

  console.log('── §6-2 벤치마크 (500 SKU) ──────────────────────')
  console.log(`파싱/검증:        ${(t1 - t0).toFixed(1)} ms`)
  console.log(`분류(mock 경로):  ${(t2 - t1).toFixed(1)} ms  (needs_review ${needsReview}건)`)
  console.log(`§4 계산(원장 ${LEDGER.length}행): ${(t3 - t2).toFixed(1)} ms`)
  console.log(`리포트 CSV 생성:  ${(t4 - t3).toFixed(1)} ms  (${reportCsv.length.toLocaleString()} bytes)`)
  console.log(`파이프라인 합계:  ${pipelineMs.toFixed(1)} ms`)
  console.log(`LLM 실호출 모델링: 50콜 ÷ 동시4 = 13웨이브 × 8s = ${llmModeledSec}s`)
  console.log(`추정 총 소요:     ${totalModeledSec.toFixed(1)}s  (기준 180s) → ${totalModeledSec < 180 ? 'PASS' : 'FAIL'}`)

  // 무결성 스팟체크: 배부 보존
  const freightSum = result.items.reduce((a, it) => a + it.freight_per_unit * it.units, 0)
  const ok = Math.abs(freightSum - 8300) < 0.001
  console.log(`운임 배부 보존:   Σ = ${freightSum.toFixed(4)} (기대 8300) → ${ok ? 'OK' : 'MISMATCH'}`)
  if (!ok || totalModeledSec >= 180) process.exit(1)
}

main()
