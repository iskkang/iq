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

/**
 * 랜딩용 (Tailwind).
 *
 * 랜딩이 다크 테마로 재설계되면서(dfa1be3) 밝은 배경용 톤은 대비가 깨졌다.
 * 카드가 쓰는 색(border-white/5 · text-emerald-300)에 맞춘 값이다.
 */
const TW: Record<string, string> = {
  mfn: 'bg-white/10 text-slate-300',
  china: 'bg-amber-400/10 text-amber-300',
  fl: 'bg-rose-400/10 text-rose-300',
  other: 'bg-white/10 text-slate-300',
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

/** 랜딩 샘플 카드에 넣을 행 수 */
const LANDING_ROWS = 3

type LandingItems = ReturnType<typeof computeShipment>['items']

/** 마커 사이를 갈아끼운다. 마커가 없으면 던진다 — 조용히 넘어가면 드리프트가 다시 시작된다. */
function replaceBetween(src: string, name: string, body: string, indent: string): string {
  const START = `<!-- ${name}:START -->`
  const END = `<!-- ${name}:END -->`
  const a = src.indexOf(START)
  const b = src.indexOf(END)
  if (a === -1 || b === -1) {
    throw new Error(`index.html 에 ${name} 마커가 없다 — 랜딩을 동기화할 수 없다`)
  }
  return src.slice(0, a + START.length) + body + '\n' + indent + src.slice(b)
}

/** null 을 건너뛴 평균. 전부 null 이면 null. */
function mean(values: Array<number | null>): number | null {
  const ok = values.filter((v): v is number => v !== null)
  return ok.length === 0 ? null : ok.reduce((s, v) => s + v, 0) / ok.length
}

/**
 * 랜딩(index.html)의 샘플 카드를 같은 엔진 결과로 덮어쓴다.
 *
 * 손으로 쓴 표는 반드시 드리프트한다 — 실제로 MFN 9.8%(존재하지 않는 라인)와
 * landed $3.29(3-SKU 기준 운임 배부)로 두 번 어긋났다. 랜딩과 리포트가 한 스크립트에서
 * 나오면 세율이 바뀌어도 재실행 한 번으로 둘 다 따라간다.
 *
 * **표와 요약 타일을 둘 다 생성한다.** 표만 묶어 뒀더니 위쪽 타일이 손으로 남아
 * 다시 어긋났다 — 표가 3 행일 때 타일은 평균 마진 31.7% 를 적고 있었고 실제
 * 행 평균은 그 값이 아니었다. 같은 숫자를 두 곳에서 관리하면 결과는 늘 같다.
 */
function syncLandingTable(items: LandingItems) {
  const path = join(root, 'index.html')
  let out = readFileSync(path, 'utf-8')

  const rows = items
    .map(
      (x) => `
            <tr class="border-t border-white/5">
              <td class="px-4 py-3 text-left font-medium">${esc(x.sku)}</td>
              <td class="px-4 py-3 text-left">${chipsTw(x.applied_programs)}</td>
              <td class="px-4 py-3 text-right font-semibold">${un(x.landed_cost, (n) => fmtUsd(round2(n)))}</td>
              <td class="px-4 py-3 text-right text-emerald-300">${fmtPct(x.true_margin)}</td>
              <td class="px-4 py-3 text-right">${x.recommended_price !== null ? fmtUsd(round2(x.recommended_price)) : '—'}</td>
            </tr>`,
    )
    .join('')
  out = replaceBetween(out, 'SAMPLE_ROWS', rows, '          ')

  const avgLanded = mean(items.map((x) => x.landed_cost))
  const avgMargin = mean(items.map((x) => x.true_margin))
  const avgPrice = mean(items.map((x) => x.recommended_price))
  const tiles = [
    { label: 'Avg. landed cost', tone: '', value: avgLanded === null ? '—' : fmtUsd(round2(avgLanded)) },
    { label: 'Avg. true margin', tone: ' text-amber-300', value: fmtPct(avgMargin) },
    { label: 'Avg. recommended price', tone: ' text-emerald-300', value: avgPrice === null ? '—' : fmtUsd(round2(avgPrice)) },
  ]
    .map(
      (t) => `
            <div class="rounded-xl bg-white/[.04] p-4"><p class="text-xs text-slate-500">${t.label}</p><p class="mt-3 text-xl font-bold${t.tone}">${t.value}</p></div>`,
    )
    .join('')
  out = replaceBetween(out, 'SAMPLE_TILES', tiles, '          ')

  // 기준일 캡션과 SKU 건수도 함께 맞춘다 (원산지 라벨은 손으로 관리)
  out = out.replace(/rates as of \d{4}-\d{2}-\d{2}/g, `rates as of ${AS_OF}`)
  out = out.replace(/China imports · \d+ SKUs/g, `China imports · ${items.length} SKUs`)

  writeFileSync(path, out, 'utf-8')
  console.log(`→ index.html 샘플 카드 ${items.length}행 + 요약 타일 동기화`)
}

/** 리포트 표기: 10% 를 "10.0%" 로 쓰지 않는다. 페이지가 쓰던 표기를 그대로 따른다. */
function pctTrim(rate: number | null): string {
  return fmtPct(rate).replace(/\.0%$/, '%')
}

/** 적용된 레이어의 종가세 합계. Layer 1 의 "Total duty" 칸. */
function totalDutyRate(applied: Parameters<typeof chipParts>[0]): number {
  return applied.reduce((s, a) => s + a.applied_rate, 0)
}

/**
 * 샘플 리포트(sample-report.html)의 숫자를 엔진 결과로 덮어쓴다.
 *
 * ── 왜 페이지 전체를 찍지 않는가 ────────────────────────────────
 * 예전에는 이 스크립트가 sample-report.html 을 통째로 생성했다. 그런데 페이지가
 * 네 커밋에 걸쳐 손으로 재설계되면서(ec90b57 → 4f250ef) 생성기만 뒤에 남았고,
 * 그때부터 재실행은 개선을 되돌리는 일이 됐다 — ads.js 전환 태그가 빠지고
 * 폐기한 CTA 문구가 되살아난다. 그래서 아무도 돌리지 않았고, 표는 손으로
 * 관리됐다.
 *
 * 그 사이 실제로 어긋났다: Layer 1 은 BACKPACK-01 관세를 42.6%, TSHIRT-01 을
 * 24% 로 적고 있었는데, **같은 페이지 Layer 2 의 금액**은 강제노동 301 12.5% 가
 * 포함된 값이었다. 한 페이지가 자기 자신과 모순된 상태로 공개돼 있었다.
 *
 * 그래서 소유권을 나눈다 — **디자인은 페이지가, 숫자는 엔진이.** 생성기는 마커
 * 안만 채우므로 재설계가 다시 와도 생성기가 뒤처지지 않는다.
 */
function syncSampleReport(items: LandingItems) {
  const path = join(root, 'sample-report.html')
  let out = readFileSync(path, 'utf-8')

  // 선적가액은 결과(SkuResult)가 아니라 입력에서 낸다 — 결과에는 수량이 없다
  const shipmentValue = ITEMS.reduce((s, i) => s + i.unit_cost_usd * i.units_per_shipment, 0)
  const meta = [
    `Illustrative rates as of <b>${AS_OF}</b>`,
    `Shipment value <b>${fmtUsd(round2(shipmentValue))}</b>`,
    `Freight + insurance <b>${fmtUsd(round2(SHIP.freight_usd + SHIP.insurance_usd))}</b>`,
    `Target margin <b>${pctTrim(SHIP.target_margin)}</b>`,
    `Channel fee <b>${pctTrim(SHIP.channel_fee_pct)}</b>`,
  ]
    .map((d) => `<div>${d}</div>`)
    .join('')
  out = replaceBetween(out, 'REPORT_META', meta, '')

  const l1 = items
    .map(
      (x) =>
        `<tr><td class="l strong">${esc(x.sku)}</td><td class="l">${formatHts(x.hts_code)}</td>` +
        `<td class="l">${chipsCss(x.applied_programs)}</td><td>${pctTrim(totalDutyRate(x.applied_programs))}</td></tr>`,
    )
    .join('')
  out = replaceBetween(out, 'REPORT_L1', l1, '')

  const l2 = items
    .map(
      (x) =>
        `<tr><td class="l strong">${esc(x.sku)}</td><td>${fmtUsd(round2(x.unit_cost))}</td>` +
        `<td>${un(x.duty_usd, (n) => fmtUsd(round2(n)))}</td><td>${fmtUsd(round2(x.fees_per_unit))}</td>` +
        `<td>${fmtUsd(round2(x.freight_per_unit))}</td>` +
        `<td class="strong">${un(x.landed_cost, (n) => fmtUsd(round2(n)))}</td></tr>`,
    )
    .join('')
  out = replaceBetween(out, 'REPORT_L2', l2, '')

  const l3 = items
    .map((x) => {
      const neg = x.true_margin !== null && x.true_margin < 0.25
      return (
        `<tr><td class="l strong">${esc(x.sku)}</td>` +
        `<td>${x.current_price !== null ? fmtUsd(round2(x.current_price)) : '—'}</td>` +
        `<td class="${neg ? 'warn' : 'ok'}">${fmtPct(x.true_margin)}</td>` +
        `<td>${x.recommended_price !== null ? fmtUsd(round2(x.recommended_price)) : '—'}</td></tr>`
      )
    })
    .join('')
  out = replaceBetween(out, 'REPORT_L3', l3, '')

  // §1-2 estimates-only 는 src/lib/disclaimer.ts 가 단일 소스다. 재설계 과정에서
  // 리포트 블록이 통째로 빠지고 푸터 축약본만 남아 있었다 — 여기서 다시 주입한다.
  out = replaceBetween(out, 'REPORT_DISCLAIMER', esc(DISCLAIMER_EN), '')

  writeFileSync(path, out, 'utf-8')
  console.log(`→ sample-report.html 3개 레이어 표 ${items.length}행 동기화`)
}

function main() {
  const r = computeShipment(SHIP, ITEMS, LEDGER, FEES, CTX)

  syncSampleReport(r.items)
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
