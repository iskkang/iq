/**
 * HTS 코드 페이지 렌더러 (docs/seo-indexing-policy.md §3).
 *
 * ── 왜 순수 함수인가 ────────────────────────────────────────────
 * 이 함수 하나가 수천 장을 찍는다. 템플릿 버그는 한 장이 아니라 발행 전량에
 * 복제되고, 색인된 뒤에 발견되면 되돌리는 데 발행보다 오래 걸린다. 그래서
 * I/O 를 빼고 테스트 가능한 형태로 둔다.
 *
 * ── 계산은 앱과 같은 엔진을 쓴다 ────────────────────────────────
 * 여기서 관세를 다시 계산하면 두 번째 구현이 생긴다. 이 저장소는 그걸로 두 번
 * 데였다 — 랜딩 표와 샘플 리포트가 각각 손으로 관리되다 원장과 갈라졌다.
 * computeShipment 를 그대로 부르므로, 페이지의 숫자와 제품의 숫자는 정의상 같다.
 */
import { computeShipment, type ProgramContext } from '../calc/engine'
import type { CalcItem, CalcShipment, FeeSettings, RateRow } from '../calc/types'
import type { DutyProgram } from '../calc/programs'
import { fmtUsd, fmtPct, round2 } from '../calc/money'
import { canonicalUrl, dotted, pagePath, pageDescription, pageTitle, type PageInput } from './pages'

/** 페이지 한 장을 그리는 데 필요한 전부. 웨이브 파일에 이 형태로 커밋된다. */
export interface CodePagePayload {
  code: string
  description: string
  /** 종가세 MFN. null 이면 게이트에서 이미 걸러졌어야 한다 */
  ad_valorem: number | null
  programs: Array<{ list: string; rate: number; provision: string; effective_from: string }>
  /** 같은 6 자리 안의 다른 8 자리 — 분류를 헷갈리는 사람에게 실제로 필요한 정보다 */
  siblings: string[]
}

export interface RenderContext {
  fees: FeeSettings
  asOf: string
  /** 계산 예시에 쓰는 선적 규모. 페이지에 그대로 표기한다 */
  exampleValueUsd: number
  exampleUnits: number
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c])

const PROGRAM_NAME: Record<string, string> = {
  list1: 'Section 301 — China List 1',
  list2: 'Section 301 — China List 2',
  list3: 'Section 301 — China List 3',
  list4a: 'Section 301 — China List 4A',
  list4b: 'Section 301 — China List 4B',
}
const programName = (list: string) => PROGRAM_NAME[list] ?? `Section 301 — ${list}`

/**
 * 중국산 기준 관세 예시를 **엔진으로** 계산한다.
 *
 * 원산지를 URL 로 쪼개지 않기로 했으므로(§1) 한 페이지가 중국과 그 외를 함께
 * 보여준다. 중국이 기준인 이유는 301 이 붙는 쪽이 실제 질문이기 때문이다.
 */
export function dutyExample(p: CodePagePayload, ctx: RenderContext) {
  const hts10 = `${p.code}00`
  const unitCost = ctx.exampleValueUsd / ctx.exampleUnits

  const programs: DutyProgram[] = [
    { code: 'mfn', name: 'Base MFN', authority: 'MFN', rate_type: 'additive', scope_type: 'hts_list', coverage: 'enumerated', effective_from: '1900-01-01', effective_to: null },
    ...p.programs.map((x) => ({
      code: `301-china-${x.list}`,
      name: programName(x.list),
      authority: 'Section 301',
      rate_type: 'additive' as const,
      scope_type: 'country_and_hts' as const,
      coverage: 'enumerated' as const,
      effective_from: x.effective_from,
      effective_to: null,
    })),
  ]
  const ledger: RateRow[] = [
    { program_code: 'mfn', hts_code: hts10, origin_country: null, layer: 'base_mfn', ad_valorem_rate: p.ad_valorem, effective_from: '1900-01-01', effective_to: null },
    ...p.programs.map((x) => ({
      program_code: `301-china-${x.list}`,
      hts_code: p.code,
      origin_country: 'CN',
      layer: 'section301' as const,
      ad_valorem_rate: x.rate,
      effective_from: x.effective_from,
      effective_to: null,
    })),
  ]
  const shipment: CalcShipment = {
    freight_usd: 0, insurance_usd: 0, mode: 'ocean', allocation_basis: 'value',
    target_margin: 0.3, channel_fee_pct: 0.15, rate_as_of: ctx.asOf,
  }
  const item = (origin: string): CalcItem => ({
    sku: origin, unit_cost_usd: unitCost, origin_country: origin,
    units_per_shipment: ctx.exampleUnits, hts_code: hts10,
  })

  const r = computeShipment(shipment, [item('CN'), item('VN')], ledger, ctx.fees, { programs, exclusions: [] } as ProgramContext)
  const byOrigin = (o: string) => r.items.find((x) => x.sku === o)!
  return { cn: byOrigin('CN'), other: byOrigin('VN'), unitCost }
}

const CSS = `*{box-sizing:border-box}body{margin:0;font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e2e8f0;background:#020617}a{color:#93b4d4}.nav{border-bottom:1px solid #1e293b}.navin,.wrap,.foot-in{max-width:860px;margin:auto;padding:0 20px}.navin{min-height:66px;display:flex;justify-content:space-between;align-items:center}.brand{display:flex;align-items:center;gap:10px;text-decoration:none;font-weight:700;color:#fff}.mark{background:#2d6099;padding:5px 9px;border-radius:8px}.links{display:flex;gap:16px;font-size:14px}.links a{color:#cbd5e1;text-decoration:none}.wrap{padding-top:36px;padding-bottom:60px}.crumb{color:#64748b;font-size:12px}.crumb a{color:#94a3b8;text-decoration:none}h1{font-size:32px;line-height:1.2;margin:10px 0 6px;color:#fff}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.desc{color:#94a3b8;margin:0 0 6px}.asof{color:#64748b;font-size:12px}h2{font-size:20px;margin:34px 0 12px;color:#fff}.card{border:1px solid #273449;background:#0f172a;border-radius:14px;padding:18px;margin:18px 0}table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:.05em;padding:8px 10px;border-bottom:1px solid #1e293b}td{padding:9px 10px;border-top:1px solid #1e293b}td.r,th.r{text-align:right}.tot td{border-top:2px solid #334155;font-weight:700;color:#fff}.sib{display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0;list-style:none}.sib a{display:inline-block;border:1px solid #273449;border-radius:8px;padding:6px 10px;text-decoration:none;font-size:13px}details{border-top:1px solid #1e293b;padding:12px 0}summary{cursor:pointer;font-weight:600;color:#fff}details p{margin:8px 0 0;color:#94a3b8}form.w{display:grid;gap:10px;margin-top:12px}form.w input,form.w select{width:100%;padding:11px 12px;border:1px solid #334155;border-radius:10px;background:#020617;color:#e2e8f0;font:inherit}form.w button{justify-self:start;border:0;border-radius:10px;background:#2d6099;color:#fff;font-weight:700;padding:11px 20px;cursor:pointer}.note{color:#64748b;font-size:12px}.err{color:#fecaca;font-size:13px}.disc{border:1px solid #422006;border-radius:11px;background:rgba(251,191,36,.06);padding:13px 15px;color:#fcd34d;font-size:12px;line-height:1.6;margin-top:26px}.foot{border-top:1px solid #1e293b;color:#64748b;font-size:12px}.foot-in{padding-top:26px;padding-bottom:34px}`

/** 페이지 한 장. 이 함수의 출력이 그대로 발행물이다. */
export function renderCodePage(p: CodePagePayload, ctx: RenderContext, disclaimer: string): string {
  const input: PageInput = {
    code: p.code, description: p.description, adValorem: p.ad_valorem,
    programs: p.programs.map((x) => x.list), demandRank: null,
  }
  const ex = dutyExample(p, ctx)
  const d = dotted(p.code)

  const stack = [
    `<tr><td>Base MFN (Column 1 General)</td><td class="r">${p.ad_valorem === null ? 'unresolved' : fmtPct(p.ad_valorem)}</td><td class="r note">—</td></tr>`,
    ...p.programs.map(
      (x) => `<tr><td>${esc(programName(x.list))}<div class="note">${esc(x.provision)} · in effect since ${esc(x.effective_from)}</div></td><td class="r">+${fmtPct(x.rate)}</td><td class="r note">China origin</td></tr>`,
    ),
    `<tr class="tot"><td>Total, China origin</td><td class="r">${fmtPct((p.ad_valorem ?? 0) + p.programs.reduce((s, x) => s + x.rate, 0))}</td><td class="r"></td></tr>`,
  ].join('')

  const siblings = p.siblings.length
    ? `<h2>Other codes in ${d.slice(0, 7)}</h2>
    <p class="note">If your product is not exactly this line, it is probably one of these. The duty can differ inside the same subheading.</p>
    <ul class="sib">${p.siblings.map((s) => `<li><a href="${pagePath(s)}">${dotted(s)}</a></li>`).join('')}</ul>`
    : ''

  const faq = [
    [`Is ${d} subject to Section 301?`,
     p.programs.length
       ? `Yes for China origin — ${p.programs.map((x) => `${programName(x.list)} at +${fmtPct(x.rate)} (${x.provision}, since ${x.effective_from})`).join('; ')}.`
       : 'It does not appear on an active Section 301 list in the current HTSUS Chapter 99 snapshot. Absence from the list is a confirmed 0% for that layer, not an unknown.'],
    [`What is the total duty on ${d} from China?`,
     p.ad_valorem === null
       ? 'The base rate on this line is not a simple ad valorem rate, so a single percentage cannot be quoted.'
       : `${fmtPct((p.ad_valorem ?? 0) + p.programs.reduce((s, x) => s + x.rate, 0))} before fees — base MFN plus the Section 301 layers above. Merchandise Processing and Harbor Maintenance fees are on top.`],
    [`Does the duty change by country of origin?`,
     'Yes. The Section 301 layers above apply to China origin. The base MFN rate applies regardless of origin, subject to any trade-agreement treatment for that country.'],
  ]
    .map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`)
    .join('')

  const row = (label: string, r: typeof ex.cn) =>
    `<tr><td>${esc(label)}</td><td class="r">${fmtUsd(round2(r.unit_cost))}</td><td class="r">${r.duty_usd === null ? 'unresolved' : fmtUsd(round2(r.duty_usd))}</td><td class="r">${fmtUsd(round2(r.fees_per_unit))}</td><td class="r">${r.landed_cost === null ? 'unresolved' : fmtUsd(round2(r.landed_cost))}</td></tr>`

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${esc(pageTitle(input))}</title>
  <meta name="description" content="${esc(pageDescription(input))}" />
  <link rel="canonical" href="${canonicalUrl(p.code)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="LandedIQ" />
  <meta property="og:url" content="${canonicalUrl(p.code)}" />
  <meta property="og:title" content="${esc(pageTitle(input))}" />
  <meta property="og:description" content="${esc(pageDescription(input))}" />
  <meta property="og:image" content="https://www.landediq.app/og.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(pageTitle(input))}" />
  <meta name="twitter:description" content="${esc(pageDescription(input))}" />
  <meta name="twitter:image" content="https://www.landediq.app/og.png" />
  <script async src="https://www.googletagmanager.com/gtag/js?id=AW-18359222502"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','AW-18359222502')</script>
  <script src="/ads.js?v=3"></script>
  <script src="/analytics.js?v=1"></script>
  <script defer data-domain="landediq.app" src="https://plausible.io/js/script.js"></script>
  <script>var CONFIG={SUPABASE_URL:'%VITE_SUPABASE_URL%',SUPABASE_ANON_KEY:'%VITE_SUPABASE_ANON_KEY%'}</script>
  <style>${CSS}</style>
</head>
<body>
  <header class="nav"><div class="navin"><a href="/" class="brand"><span class="mark">LIQ</span><span>LandedIQ</span></a><nav class="links"><a href="/hts">HTS Lookup</a><a href="/blog">Blog</a><a href="/section-301">Section 301</a><a href="/app">Sign in</a></nav></div></header>
  <main class="wrap" data-code="${p.code}">
    <p class="crumb"><a href="/hts">HTS lookup</a> › Chapter ${p.code.slice(0, 2)} › Heading ${p.code.slice(0, 4)}</p>
    <h1><span class="mono">${d}</span></h1>
    <p class="desc">${esc(p.description)}</p>
    <p class="asof">Duty layers as of ${esc(ctx.asOf)} · official USITC and HTSUS Chapter 99 sources</p>

    <h2>Duty stack</h2>
    <div class="card"><table><thead><tr><th>Layer</th><th class="r">Rate</th><th class="r">Applies to</th></tr></thead><tbody>${stack}</tbody></table></div>

    <h2>What that costs on a ${fmtUsd(ctx.exampleValueUsd)} shipment</h2>
    <div class="card"><table><thead><tr><th>Origin</th><th class="r">Unit cost</th><th class="r">Duty</th><th class="r">MPF + HMF</th><th class="r">Landed</th></tr></thead><tbody>
      ${row('China', ex.cn)}
      ${row('Non-301 origin', ex.other)}
    </tbody></table>
    <p class="note">${ctx.exampleUnits.toLocaleString('en-US')} units at ${fmtUsd(round2(ex.unitCost))}, freight excluded. Computed by the same engine the workspace uses, with MPF/HMF from the fee schedule effective ${esc(ctx.fees.effective_from)}.</p></div>

    ${siblings}

    <h2>Questions</h2>
    ${faq}

    <h2>Watch this code</h2>
    <div class="card"><p>Get an email when the duty treatment of <span class="mono">${d}</span> changes.</p>
      <form class="w" id="watch-form">
        <input type="email" name="email" required placeholder="you@company.com" />
        <select name="bucket" required><option value="">How many products do you import?</option><option>1–10</option><option>11–100</option><option>101–1,000</option><option>1,000+</option></select>
        <button>Watch this code</button>
      </form>
      <p class="err" id="werr"></p>
      <p class="note">Free alert. No account required. <a href="/app">Open the beta workspace</a> to run this across all your SKUs.</p></div>

    <p class="disc">${esc(disclaimer)}</p>
  </main>
  <script>
    var code=document.querySelector('[data-code]').dataset.code,f=document.getElementById('watch-form');
    function ev(n,p){window.track&&window.track(n,p||{})}
    ev('code_page_view',{code:code});
    f.addEventListener('submit',function(e){e.preventDefault();
      var b=f.querySelector('button'),d=new FormData(f),err=document.getElementById('werr');
      err.textContent='';b.disabled=true;b.textContent='Saving…';ev('watch_submitted',{code:code});
      fetch(CONFIG.SUPABASE_URL+'/rest/v1/leads',{method:'POST',headers:{'Content-Type':'application/json',apikey:CONFIG.SUPABASE_ANON_KEY,Authorization:'Bearer '+CONFIG.SUPABASE_ANON_KEY,Prefer:'return=minimal'},body:JSON.stringify({email:d.get('email'),intent:'hts_watch',variant:d.get('bucket'),page:location.pathname})})
        .then(function(r){if(r.status!==409&&!r.ok)throw new Error('save '+r.status);
          ev('watch_saved',{code:code});window.trackConversion&&window.trackConversion('watch');
          f.outerHTML='<p style="color:#6ee7b7;font-weight:700">You are watching '+code+'.</p>'})
        .catch(function(x){ev('watch_failed',{code:code,reason:String(x.message).slice(0,80)});
          b.disabled=false;b.textContent='Watch this code';
          err.textContent='Could not save that. Please try again, or email support@landediq.app.'})});
  </script>
  <footer class="foot"><div class="foot-in">LandedIQ is operated by MTL Co., Ltd. · support@landediq.app<br />Estimates are not customs, legal or tax advice. Final classification and duty liability remain with the importer of record. · © 2026 LandedIQ</div></footer>
</body></html>
`
}
