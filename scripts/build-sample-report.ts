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
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { loadFees } from './lib/fees'
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
 * 확인된 프로그램만 (MFN + 중국 리스트 301 + 2026-07-24 시행 강제노동 301).
 *
 * **중국산으로 돌아왔다.** 레거시 301 리스트(HTSUS note 20 8자리 열거)를 적재했으므로
 * 이제 중국 관세를 완결로 표시할 수 있다. 리스트별로 결과가 갈리는 것이 핵심이다:
 *   4202.92.31 백팩   List 3  +25%   → MFN 17.6% + 25% + 12.5% = 55.1% (3층)
 *   6109.10.00 티셔츠 List 4A +7.5%  → MFN 16.5% + 7.5% + 12.5% = 36.5%
 *   6912.00.44 머그   List 4B 정지   → MFN 10% + 12.5% = 22.5% (301 리스트 없음)
 * 같은 중국산인데 8자리에 따라 22.5%~55.1% 로 갈린다 — 이 제품이 파는 지점이다.
 */
const PROGRAMS: DutyProgram[] = [
  { code: 'mfn', name: 'Base MFN', authority: 'MFN', rate_type: 'additive', scope_type: 'hts_list', coverage: 'enumerated', effective_from: '1900-01-01', effective_to: null },
  { code: '301-china-list3', name: 'Section 301 — China List 3', authority: 'Section 301', rate_type: 'additive', scope_type: 'country_and_hts', coverage: 'enumerated', effective_from: '2019-05-10', effective_to: null },
  { code: '301-china-list4a', name: 'Section 301 — China List 4A', authority: 'Section 301', rate_type: 'additive', scope_type: 'country_and_hts', coverage: 'enumerated', effective_from: '2020-02-14', effective_to: null },
  { code: '301-fl', name: 'Section 301 (forced labor)', authority: 'Section 301', rate_type: 'additive', scope_type: 'country', effective_from: '2026-07-24', effective_to: null },
]
const CTX: ProgramContext = { programs: PROGRAMS, exclusions: [] }

const LEDGER: RateRow[] = [
  { program_code: 'mfn', hts_code: '6912004400', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.10, effective_from: '2025-01-01', effective_to: null },
  { program_code: 'mfn', hts_code: '4202923120', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.176, effective_from: '2025-01-01', effective_to: null },
  { program_code: 'mfn', hts_code: '7323930060', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.02, effective_from: '2025-01-01', effective_to: null },
  { program_code: 'mfn', hts_code: '6109100012', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.165, effective_from: '2025-01-01', effective_to: null },
  { program_code: 'mfn', hts_code: '9617001000', origin_country: null, layer: 'base_mfn', ad_valorem_rate: 0.072, effective_from: '2025-01-01', effective_to: null },
  { program_code: '301-fl', hts_code: '*', origin_country: 'CN', layer: 'section301', ad_valorem_rate: 0.125, effective_from: '2026-07-24', effective_to: null },
  { program_code: '301-fl', hts_code: '*', origin_country: 'VN', layer: 'section301', ad_valorem_rate: 0.125, effective_from: '2026-07-24', effective_to: null },
  // 중국 리스트 301 — HTSUS note 20 열거. 4B(정지) 라인은 넣지 않는다: 부재가 곧 확인된 0%
  { program_code: '301-china-list3', hts_code: '42029231', origin_country: 'CN', layer: 'section301', ad_valorem_rate: 0.25, effective_from: '2019-05-10', effective_to: null },
  { program_code: '301-china-list4a', hts_code: '61091000', origin_country: 'CN', layer: 'section301', ad_valorem_rate: 0.075, effective_from: '2020-02-14', effective_to: null },
  { program_code: '301-fl', hts_code: '*', origin_country: 'IN', layer: 'section301', ad_valorem_rate: 0.10, effective_from: '2026-07-24', effective_to: null },
]

/**
 * 두 모드로 나눈다.
 *
 *   refresh (기본, 로컬)  DB 에서 수수료를 읽어 HTML 을 만들고, 그때 쓴 입력을
 *                        sample-report.inputs.json 에 남긴다
 *   verify  (CI)         커밋된 inputs.json 으로 같은 HTML 을 재생성한다.
 *                        DB 접속이 필요 없고, 손편집은 git diff 로 그대로 잡힌다
 *
 * **inputs.json 은 두 번째 출처가 아니다.** 수수료의 진실 출처는 여전히 DB 이고,
 * 이 파일은 그 시점 값을 적어둔 fixture 다. 둘이 갈라지는 것은
 * `npm run sample:check-inputs` 가 감시한다 (DB 접속 가능한 환경에서 실행).
 *
 * 이 분리가 필요해진 이유: 수수료를 DB 로 옮기자 CI 의 드리프트 가드가 자격증명을
 * 요구하게 되어 깨졌다. 가드는 "손으로 고쳤는가" 를 보는 것이지 "DB 값이 맞는가" 를
 * 보는 게 아니므로, 오프라인으로 돌 수 있어야 한다.
 */
const MODE = process.argv.includes('--mode=verify') ? 'verify' : 'refresh'
const INPUTS = join(root, 'sample-report.inputs.json')

interface SampleInputs {
  as_of: string
  fees: FeeSettings
  note: string
}

/**
 * 미해결 숫자 칸. 0 을 찍으면 "관세 없음" 으로 읽히고, 이 파일은 그대로
 * 랜딩에 붙는 마케팅 산출물이라 그 오해가 광고까지 간다.
 */
const un = (v: number | null, fmt: (n: number) => string) =>
  v === null ? '<span class="warn">unresolved</span>' : fmt(v)

async function resolveFees(): Promise<FeeSettings> {
  if (MODE === 'refresh') return loadFees(AS_OF)
  // verify: 없으면 **명시적 실패**. 스킵하면 가드가 조용히 사라진다.
  if (!existsSync(INPUTS)) {
    throw new Error(
      `verify 모드인데 ${INPUTS} 가 없다. 먼저 로컬에서 npm run sample:build 로 생성해 커밋할 것. ` +
        '없다고 건너뛰면 드리프트 가드가 조용히 사라진다.',
    )
  }
  return (JSON.parse(readFileSync(INPUTS, 'utf-8')) as SampleInputs).fees
}

const FEES: FeeSettings = await resolveFees()
const SHIP: CalcShipment = {
  freight_usd: 2000, insurance_usd: 100, mode: 'ocean', allocation_basis: 'value',
  target_margin: 0.3, channel_fee_pct: 0.15, rate_as_of: AS_OF,
}

const ITEMS: CalcItem[] = [
  { sku: 'MUG-01',      hts_code: '6912004400', unit_cost_usd: 2.5,  origin_country: 'CN', units_per_shipment: 1000, current_price_usd: 12.99 },
  { sku: 'BACKPACK-01', hts_code: '4202923120', unit_cost_usd: 8.5,  origin_country: 'CN', units_per_shipment: 400,  current_price_usd: 39.99 },
  { sku: 'PAN-01',      hts_code: '7323930060', unit_cost_usd: 6.4,  origin_country: 'CN', units_per_shipment: 300,  current_price_usd: 24.99 },
  { sku: 'TSHIRT-01',   hts_code: '6109100012', unit_cost_usd: 3.2,  origin_country: 'CN', units_per_shipment: 800,  current_price_usd: 19.99 },
  { sku: 'TUMBLER-01',  hts_code: '9617001000', unit_cost_usd: 3.1,  origin_country: 'CN', units_per_shipment: 600,  current_price_usd: 24.99 },
]

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)


/**
 * duty 분해를 색 배지로 렌더한다.
 *
 * "MFN 17.6% + Section 301 12.5% + Section 301 25%" 는 회색 텍스트로 죽는다.
 * 이 제품의 유일한 시각적 차별점이 레이어 스택이므로 레이어별로 색을 준다.
 * 라벨은 짧게 줄이되 어느 프로그램인지 알 수 있게 남긴다.
 */
function chipParts(applied: ReturnType<typeof computeShipment>['items'][number]['applied_programs']) {
  return applied
    .filter((a) => a.applied_rate > 0)
    .map((a) => {
      const pct = fmtPct(a.applied_rate)
      if (a.program_code === 'mfn') return { label: `MFN ${pct}`, tone: 'mfn' as const }
      if (a.program_code.startsWith('301-china-list')) {
        const n = a.program_code.replace('301-china-list', '').toUpperCase()
        return { label: `301 List ${n} +${pct}`, tone: 'china' as const }
      }
      if (a.authority === 'Section 301') return { label: `301 forced labor +${pct}`, tone: 'fl' as const }
      return { label: `${a.authority} ${pct}`, tone: 'other' as const }
    })
}

/** 랜딩용 (Tailwind) */
const TW: Record<string, string> = {
  mfn: 'bg-slate-100 text-slate-700',
  china: 'bg-amber-100 text-amber-800',
  fl: 'bg-rose-100 text-rose-800',
  other: 'bg-slate-100 text-slate-700',
}
function chipsTw(applied: Parameters<typeof chipParts>[0]) {
  return chipParts(applied)
    .map((c) => `<span class="mr-1 inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ${TW[c.tone]}">${esc(c.label)}</span>`)
    .join('')
}
/** 샘플 리포트용 (자체 CSS 클래스) */
function chipsCss(applied: Parameters<typeof chipParts>[0]) {
  return chipParts(applied)
    .map((c) => `<span class="chip chip-${c.tone}">${esc(c.label)}</span>`)
    .join('')
}

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
              <td class="px-4 py-3 text-left">${chipsTw(x.applied_programs)}</td>
              <td class="px-4 py-3 font-semibold">${un(x.landed_cost, (n) => fmtUsd(round2(n)))}</td>
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
        <td class="l">${chipsCss(x.applied_programs)}</td>
        <td>${fmtUsd(round2(x.unit_cost))}</td>
        <td>${un(x.duty_usd, (n) => fmtUsd(round2(n)))}</td>
        <td>${fmtUsd(round2(x.fees_per_unit))}</td>
        <td>${fmtUsd(round2(x.freight_per_unit))}</td>
        <td class="b">${un(x.landed_cost, (n) => fmtUsd(round2(n)))}</td>
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
<link rel="canonical" href="https://www.landediq.app/sample-report.html" />
<!-- Google tag (gtag.js) — Google Ads 전환 추적. 페이지당 한 번만. -->
<script async src="https://www.googletagmanager.com/gtag/js?id=AW-18359222502"></script>
<script>
  window.dataLayer = window.dataLayer || []; function gtag(){ dataLayer.push(arguments) }
  gtag('js', new Date()); gtag('config', 'AW-18359222502')
</script>
<!-- 진입 자체를 이벤트로 남긴다 — 리포트 열람 대비 가입 전환을 볼 수 있어야 한다 -->
<script defer data-domain="landediq.app" src="https://plausible.io/js/script.js"></script>
<script>
  // 랜딩과 **같은 출처**를 쓴다. Vite 가 빌드 시 VITE_ 접두 변수를 치환한다.
  var CONFIG = { SUPABASE_URL: '%VITE_SUPABASE_URL%', SUPABASE_ANON_KEY: '%VITE_SUPABASE_ANON_KEY%' }
</script>
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
  .chip{display:inline-block;white-space:nowrap;margin:1px 3px 1px 0;padding:2px 6px;border-radius:5px;font-size:11px;font-weight:600}
  .chip-mfn{background:#f1f5f9;color:#334155} .chip-china{background:#fef3c7;color:#92400e}
  .chip-fl{background:#ffe4e6;color:#9f1239} .chip-other{background:#f1f5f9;color:#334155}
  .cta{margin-top:26px;padding:20px;background:#fff;border:1px solid #e2e8f0;border-radius:10px}
  .cta h2{font-size:17px;margin:0 0 4px} .cta p{margin:0 0 12px;font-size:13px;color:#475569}
  .cta form{display:flex;gap:8px;flex-wrap:wrap}
  .cta input[type=email]{flex:1 1 240px;padding:10px 12px;font-size:14px;border:1px solid #cbd5e1;border-radius:8px}
  .cta button{padding:10px 18px;font-size:14px;font-weight:600;color:#fff;background:#4f46e5;border:0;border-radius:8px;cursor:pointer}
  .cta button:disabled{opacity:.5;cursor:default}
  .note-sm{margin-top:8px !important;font-size:11px;color:#94a3b8}
  .done{margin-top:12px;padding:10px 12px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;color:#065f46;font-weight:600;font-size:13px}
  @media print{body{background:#fff;padding:0} .scroll{border:none} .cta{display:none}}
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
  All five SKUs are China origin. The Section 301 result differs by 8-digit line, which is the point:
  backpacks (4202.92.31) are on List 3 at +25%, t-shirts (6109.10.00) on List 4A at +7.5%, while mugs
  (6912.00.44), stainless kitchenware (7323.93.00) and vacuum flasks (9617.00.10) appear only on
  List&nbsp;4B &mdash; which the tariff schedule itself marks <b>suspended</b>, so no China 301 applies.
  Same country, same shipment: 22.5% to 55.1% depending on the 8-digit code.</p>

  <section class="cta">
    <h2>Want this for your own SKUs?</h2>
    <p>Upload one CSV and get the same report for every product you import. Free during early access.</p>
    <form id="cta-form" autocomplete="on">
      <input type="email" name="email" required placeholder="you@yourstore.com" aria-label="Email" />
      <!-- 봇 함정. 채워져 오면 제출을 버린다 -->
      <input type="text" name="company" tabindex="-1" autocomplete="off" aria-hidden="true"
        style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0" />
      <button type="submit">Get early access</button>
    </form>
    <p id="cta-note" class="note-sm">No credit card. We'll email you when your workspace is ready.</p>
  </section>

  <footer>
    ${esc(DISCLAIMER_EN)}<br />
    © 2026 LandedIQ · Tip: use your browser's Print → Save as PDF to keep a copy.
  </footer>
</div>
<script>
  // 진입 기록. 리포트를 본 사람 중 몇 %가 가입하는지가 이 페이지의 지표다.
  window.plausible && window.plausible('sample_report_view')
  document.addEventListener('DOMContentLoaded', function () {
    var f = document.getElementById('cta-form'), note = document.getElementById('cta-note')
    if (!f) return
    var p = new URLSearchParams(location.search)
    var UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']
    f.addEventListener('submit', async function (e) {
      e.preventDefault()
      var btn = f.querySelector('button'), trap = f.querySelector('input[name=company]')
      var done = function () {
        var d = document.createElement('p'); d.className = 'done'
        d.textContent = "You're in line — we're onboarding new stores this week"
        f.replaceWith(d); if (note) note.remove()
      }
      if (trap && trap.value) return done() // 봇: 성공한 척하고 버린다
      btn.disabled = true
      var body = { email: f.querySelector('input[type=email]').value, intent: 'sample_report_page', page: location.pathname }
      UTM.forEach(function (k) { body[k] = p.get(k) || null })
      try {
        if (!CONFIG.SUPABASE_URL || CONFIG.SUPABASE_URL.indexOf('%VITE_') === 0) throw new Error('env not injected')
        var res = await fetch(CONFIG.SUPABASE_URL + '/rest/v1/leads', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json', apikey: CONFIG.SUPABASE_ANON_KEY,
            Authorization: 'Bearer ' + CONFIG.SUPABASE_ANON_KEY, Prefer: 'return=minimal',
          },
          body: JSON.stringify(body),
        })
        if (res.status !== 409 && !res.ok) throw new Error('leads ' + res.status)
        window.plausible && window.plausible('email_signup', { props: { intent: 'sample_report_page', utm_source: p.get('utm_source') || '' } })
        // 라벨이 오면 send_to 를 AW-18359222502/<label> 로 바꾼다
        if (typeof window.gtag === 'function') window.gtag('event', 'conversion', { send_to: 'AW-18359222502' })
        done()
      } catch (err) {
        btn.disabled = false
        if (note) { note.textContent = 'Something went wrong — please try again.'; note.style.color = '#e11d48' }
      }
    })
  })
</script>
</body></html>
`

  // **public/ 이 아니라 루트에 쓴다.** public/ 은 Vite 가 그대로 복사만 하므로
  // %VITE_*% 가 치환되지 않는다 — 그러면 이 페이지의 폼이 쓸 anon 키를 여기에
  // 하드코딩해야 하고, 랜딩·앱과 자격증명이 또 두 벌이 된다. 빌드 입력으로 잡아
  // 출처를 하나로 유지한다 (vite.config.ts 의 rollupOptions.input 참조).
  writeFileSync(join(root, 'sample-report.html'), html, 'utf-8')

  syncLandingTable(r.items.slice(0, LANDING_ROWS))

  // refresh 에서만 fixture 를 갱신한다. verify 는 읽기만 한다 —
  // 그러지 않으면 CI 가 fixture 를 덮어써서 드리프트가 영원히 안 잡힌다. (SampleInputs 기록)
  if (MODE === 'refresh') {
    const inputs: SampleInputs = {
      as_of: AS_OF,
      fees: FEES,
      note: 'DB(fee_settings) 에서 읽은 그 시점 값. 진실 출처는 DB 이며 이 파일은 fixture 다. 갱신: npm run sample:build',
    }
    writeFileSync(INPUTS, JSON.stringify(inputs, null, 2) + String.fromCharCode(10))
  }

  console.log('── 샘플 리포트 생성 ────────────────────────────')
  for (const x of r.items) {
    console.log(
      `  ${x.sku.padEnd(12)} ${programBreakdownLabel(x.applied_programs).padEnd(30)} landed ${x.landed_cost === null ? 'UNRESOLVED' : fmtUsd(round2(x.landed_cost))}`,
    )
  }
  console.log('→ sample-report.html (Vite 입력)')
}

main()
