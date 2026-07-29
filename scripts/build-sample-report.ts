/**
 * 랜딩의 "See a sample report" 가 내려주는 샘플 리포트를 만든다.
 *
 * **실제 엔진으로 계산한다.** 손으로 쓴 목업이면 랜딩이 제품과 어긋나고,
 * 이번에 MFN 9.8% 로 겪은 문제가 반복된다. 세율이 바뀌면 이 스크립트를
 * 다시 돌리기만 하면 샘플도 따라간다.
 *
 * 산출물: public/sample-report.html — 자체완결 HTML.
 * 브라우저 인쇄로 PDF 가 되므로 PDF 라이브러리를 들이지 않는다.
 *
 * 실행: npm run sample:build
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { computeShipment } from '../src/lib/calc/engine'
import type { ProgramContext } from '../src/lib/calc/engine'
import type { DutyProgram } from '../src/lib/calc/programs'
import { programBreakdownLabel } from '../src/lib/calc/programs'
import { fmtPct, fmtUsd, round2 } from '../src/lib/calc/money'
import { formatHts } from '../src/lib/calc/rates'
import { DISCLAIMER_EN } from '../src/lib/disclaimer'
import type { CalcItem, CalcShipment, FeeSettings, RateRow } from '../src/lib/calc/types'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const AS_OF = '2026-07-29'

/**
 * 확인된 프로그램만 (MFN + 2026-07-24 시행 강제노동 301).
 *
 * **샘플에 중국산을 쓰지 않는다.** 중국은 레거시 301(List 1~4, 최대 25%)이 추가로 붙는데
 * 그 8자리 목록이 아직 원장에 없다. 중국산으로 샘플을 만들면 지배적인 레이어가 통째로
 * 빠져 실제 관세를 절반 이하로 표시하게 된다 — "확인된 것만 보여준다"가 아니라 오답이다.
 * 베트남·인도는 강제노동 301 만으로 오늘 기준 완결이라 샘플로 안전하고,
 * China+1 로 소싱을 옮긴 셀러가 타깃이라 오히려 더 적합하다.
 */
const PROGRAMS: DutyProgram[] = [
  { code: 'mfn', name: 'Base MFN', authority: 'MFN', rate_type: 'additive', scope_type: 'hts_list', effective_from: '1900-01-01', effective_to: null },
  { code: '301-fl', name: 'Section 301 (forced labor)', authority: 'Section 301', rate_type: 'additive', scope_type: 'country', effective_from: '2026-07-24', effective_to: null },
]
const CTX: ProgramContext = { programs: PROGRAMS, exclusions: [] }

const LEDGER: RateRow[] = [
  { program_code: 'mfn', hts_code: '6912004400', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.10, effective_from: '2025-01-01', effective_to: null },
  { program_code: 'mfn', hts_code: '4202923120', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.176, effective_from: '2025-01-01', effective_to: null },
  { program_code: 'mfn', hts_code: '7323930060', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.02, effective_from: '2025-01-01', effective_to: null },
  { program_code: 'mfn', hts_code: '6109100012', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.165, effective_from: '2025-01-01', effective_to: null },
  { program_code: 'mfn', hts_code: '9617001000', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.072, effective_from: '2025-01-01', effective_to: null },
  { program_code: '301-fl', hts_code: '*', origin_country: 'VN', layer: 'section301', ad_valorem_rate: 0.125, effective_from: '2026-07-24', effective_to: null },
  { program_code: '301-fl', hts_code: '*', origin_country: 'IN', layer: 'section301', ad_valorem_rate: 0.10, effective_from: '2026-07-24', effective_to: null },
]

const FEES: FeeSettings = { mpf_rate: 0.003464, mpf_min_usd: 32.71, mpf_max_usd: 634.62, hmf_rate: 0.00125, effective_from: '2024-10-01' }
const SHIP: CalcShipment = {
  freight_usd: 2000, insurance_usd: 100, mode: 'ocean', allocation_basis: 'value',
  target_margin: 0.3, channel_fee_pct: 0.15, rate_as_of: AS_OF,
}

const ITEMS: CalcItem[] = [
  { sku: 'MUG-01',      hts_code: '6912004400', unit_cost_usd: 2.5,  origin_country: 'VN', units_per_shipment: 1000, current_price_usd: 12.99 },
  { sku: 'BACKPACK-01', hts_code: '4202923120', unit_cost_usd: 8.5,  origin_country: 'VN', units_per_shipment: 400,  current_price_usd: 39.99 },
  { sku: 'PAN-01',      hts_code: '7323930060', unit_cost_usd: 6.4,  origin_country: 'VN', units_per_shipment: 300,  current_price_usd: 24.99 },
  { sku: 'TSHIRT-01',   hts_code: '6109100012', unit_cost_usd: 3.2,  origin_country: 'IN', units_per_shipment: 800,  current_price_usd: 19.99 },
  { sku: 'TUMBLER-01',  hts_code: '9617001000', unit_cost_usd: 3.1,  origin_country: 'VN', units_per_shipment: 600,  current_price_usd: 24.99 },
]

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** 랜딩 "What you get" 표에 넣을 행 수 */
const LANDING_ROWS = 3

/**
 * 랜딩(index.html)의 샘플 표를 같은 엔진 결과로 덮어쓴다.
 *
 * 손으로 쓴 표는 반드시 드리프트한다 — 실제로 MFN 9.8%(존재하지 않는 라인)와
 * landed $3.29(3-SKU 기준 운임 배부)로 두 번 어긋났다. 랜딩과 리포트가 한 스크립트에서
 * 나오면 세율이 바뀌어도 재실행 한 번으로 둘 다 따라간다.
 */
function syncLandingTable(items: ReturnType<typeof computeShipment>['items']) {
  const path = join(root, 'index.html')
  const src = readFileSync(path, 'utf-8')
  const START = '<!-- SAMPLE_ROWS:START -->'
  const END = '<!-- SAMPLE_ROWS:END -->'
  const a = src.indexOf(START)
  const b = src.indexOf(END)
  if (a === -1 || b === -1) throw new Error('index.html 에 SAMPLE_ROWS 마커가 없다 — 랜딩 표를 동기화할 수 없다')

  const rows = items
    .map(
      (x) => `
            <tr>
              <td class="px-4 py-3 text-left font-medium">${esc(x.sku)}</td>
              <td class="px-4 py-3 text-left text-xs text-slate-600">${esc(programBreakdownLabel(x.applied_programs))}</td>
              <td class="px-4 py-3 font-semibold">${fmtUsd(round2(x.landed_cost))}</td>
              <td class="px-4 py-3 text-emerald-600">${fmtPct(x.true_margin)}</td>
              <td class="px-4 py-3">${x.recommended_price !== null ? fmtUsd(round2(x.recommended_price)) : '—'}</td>
            </tr>`,
    )
    .join('')

  let out = src.slice(0, a + START.length) + rows + '\n          ' + src.slice(b)

  // 기준일 캡션도 함께 맞춘다 (원산지 라벨은 손으로 관리)
  out = out.replace(/rates as of \d{4}-\d{2}-\d{2}/g, `rates as of ${AS_OF}`)

  writeFileSync(path, out, 'utf-8')
  console.log(`→ index.html 샘플 표 ${items.length}행 동기화`)
}

function main() {
  const r = computeShipment(SHIP, ITEMS, LEDGER, FEES, CTX)

  const rows = r.items
    .map((x) => {
      const neg = x.true_margin !== null && x.true_margin < 0.25
      return `      <tr>
        <td class="l b">${esc(x.sku)}</td>
        <td class="l mono">${formatHts(x.hts_code)}</td>
        <td class="l small">${esc(programBreakdownLabel(x.applied_programs))}</td>
        <td>${fmtUsd(round2(x.unit_cost))}</td>
        <td>${fmtUsd(round2(x.duty_usd))}</td>
        <td>${fmtUsd(round2(x.fees_per_unit))}</td>
        <td>${fmtUsd(round2(x.freight_per_unit))}</td>
        <td class="b">${fmtUsd(round2(x.landed_cost))}</td>
        <td>${x.current_price !== null ? fmtUsd(round2(x.current_price)) : '—'}</td>
        <td class="${neg ? 'warn' : 'ok'}">${fmtPct(x.true_margin)}</td>
        <td>${x.recommended_price !== null ? fmtUsd(round2(x.recommended_price)) : '—'}</td>
      </tr>`
    })
    .join('\n')

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>LandedIQ — Sample landed cost report</title>
<style>
  *{box-sizing:border-box} body{margin:0;padding:32px 20px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#0f172a;background:#f8fafc}
  .wrap{max-width:1000px;margin:0 auto}
  h1{font-size:22px;margin:0 0 4px} .sub{color:#64748b;font-size:13px;margin:0 0 20px}
  .meta{display:flex;flex-wrap:wrap;gap:16px;background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:18px;font-size:13px}
  .meta div{color:#475569} .meta b{color:#0f172a}
  .scroll{overflow-x:auto;border:1px solid #e2e8f0;border-radius:10px;background:#fff}
  table{width:100%;min-width:900px;border-collapse:collapse;text-align:right;font-size:13px}
  th{background:#f8fafc;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:10px 12px;text-align:right;font-weight:600}
  th.l,td.l{text-align:left} td{padding:10px 12px;border-top:1px solid #f1f5f9}
  .b{font-weight:600} .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .small{font-size:12px;color:#475569} .ok{color:#059669} .warn{color:#d97706;font-weight:600}
  .note{margin-top:16px;padding:12px 14px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:12px;color:#92400e}
  footer{margin-top:22px;color:#94a3b8;font-size:11px;line-height:1.6}
  @media print{body{background:#fff;padding:0} .scroll{border:none}}
</style></head><body><div class="wrap">
  <h1>Sample landed cost report</h1>
  <p class="sub">This is the real report format — generated by the LandedIQ calculation engine, not a mock-up.</p>

  <div class="meta">
    <div>Rates as of <b>${AS_OF}</b></div>
    <div>Shipment value <b>${fmtUsd(round2(r.totals.total_value))}</b></div>
    <div>Freight + insurance <b>${fmtUsd(round2(r.totals.freight_pool))}</b></div>
    <div>MPF <b>${fmtUsd(round2(r.totals.mpf_shipment))}</b></div>
    <div>HMF <b>${fmtUsd(round2(r.totals.hmf_shipment))}</b></div>
    <div>Allocation <b>${r.totals.allocation_basis_used}</b></div>
    <div>Target margin <b>${fmtPct(SHIP.target_margin, 0)}</b> · channel fee <b>${fmtPct(SHIP.channel_fee_pct, 0)}</b></div>
  </div>

  <div class="scroll"><table>
    <thead><tr>
      <th class="l">SKU</th><th class="l">HTS</th><th class="l">Duty breakdown</th>
      <th>Unit cost</th><th>Duty</th><th>Fees</th><th>Freight</th>
      <th>Landed cost</th><th>Current price</th><th>True margin</th><th>Recommended</th>
    </tr></thead>
    <tbody>
${rows}
    </tbody>
  </table></div>

  <p class="note"><b>Duty programs shown:</b> base MFN (USITC official schedule) and the Section 301 forced-labor
  tariffs effective 2026-07-24. Programs that have ended — the IEEPA tariffs struck down in February 2026 and the
  Section 122 surcharge that expired 2026-07-24 — are excluded automatically by their effective dates.
  This sample uses Vietnam and India origin, where those two programs are the complete picture. China-origin goods
  can carry an additional legacy Section 301 duty (Lists 1&ndash;4) that depends on the 8-digit code; LandedIQ flags
  those lines as <b>unverified</b> rather than showing them as 0%.</p>

  <footer>
    ${esc(DISCLAIMER_EN)}<br />
    © 2026 LandedIQ · Tip: use your browser's Print → Save as PDF to keep a copy.
  </footer>
</div></body></html>
`

  mkdirSync(join(root, 'public'), { recursive: true })
  writeFileSync(join(root, 'public/sample-report.html'), html, 'utf-8')

  syncLandingTable(r.items.slice(0, LANDING_ROWS))

  console.log('── 샘플 리포트 생성 ────────────────────────────')
  for (const x of r.items) {
    console.log(
      `  ${x.sku.padEnd(12)} ${programBreakdownLabel(x.applied_programs).padEnd(30)} landed ${fmtUsd(round2(x.landed_cost))}`,
    )
  }
  console.log('→ public/sample-report.html')
}

main()
