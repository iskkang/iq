/**
 * 에디토리얼 발행 (docs/seo-indexing-policy.md §8).
 *
 *   npm run blog:build    content/blog/*.md → blog.html + blog/{slug}.html
 *   npm run blog:verify   재생성 결과가 커밋본과 같은지 (CI 가 이걸 돌린다)
 *
 * ── 이 파이프라인의 핵심 결정: 사실을 손으로 쓰지 않는다 ─────────
 * front matter 에 세율을 적게 하면 그 순간 원장과 갈라진다. 이 저장소는 그
 * 실패를 이미 두 번 겪었다 — 랜딩 표와 샘플 리포트가 각각 손으로 관리되다
 * 어긋났고, 리포트는 자기 자신과도 모순됐다.
 *
 * 그래서 글쓴이는 **코드만 고른다.** 301 리스트 소속과 세율은 커밋된 공식
 * 데이터(data/section301_lists.json)에서 유도한다. 사실 층에 사람이 타이핑할
 * 자리가 없으면 그 층은 틀릴 수 없다.
 *
 * 의견은 `take` 필드에만 들어가고 화면에도 의견으로 표시된다. 정책 §8 의
 * "사실 층과 의견 층을 분리한다" 를 문서가 아니라 형식으로 강제한다.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { renderMarkdown, esc } from './lib/markdown'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'content/blog')
const OUT_DIR = join(root, 'blog')
const LISTS = join(root, 'data/section301_lists.json')
const MODE = process.argv.includes('--mode=verify') ? 'verify' : 'refresh'
const ORIGIN = 'https://www.landediq.app'

/** 정책 §8: 발행할 때마다 코드 페이지로 내부 링크 5~15 개 */
const MIN_CODES = 5
const MAX_CODES = 15

/**
 * ── 빈도를 올릴 때 무너지는 지점 ────────────────────────────────
 * 빈도 자체는 문제가 아니다. 문제는 **빈도 × 템플릿 획일성 × 얇은 본문**이다.
 * 150 편/년이 같은 틀에 같은 길이로 나가면, 에디토리얼은 프로그래매틱 코퍼스의
 * 균형추(사람이 쓴 글)이기를 그만두고 그 코퍼스에 섞여 대량 생성 신호가 된다.
 * 그러면 백링크도 안 오고 도메인 평가만 깎인다 — 두 배로 지는 길이다.
 *
 * 그 실패는 조용하다. 얇은 글도 발행되고 배포되고 아무도 막지 않는다. 그래서
 * 아래 셋을 빌드에서 본다. 속도를 올리는 대신 바닥을 만든다.
 */
const MIN_BODY_WORDS = 300
/** 최근 몇 편 안에서 같은 코드를 다시 쓰지 않는가 */
const RECENT_WINDOW = 10
const MAX_CODE_REUSE = 2
/** 스캐폴드가 남긴 자리표시자. 채우지 않으면 발행되지 않는다 */
const PLACEHOLDER = /\bTODO\b/

interface Post {
  title: string
  slug: string
  date: string
  dek: string
  codes: string[]
  take: string
  question: string
  sources: Array<{ label: string; url: string }>
  body: string
  /** 원본 파일에서 본문이 시작하는 줄 — 렌더 오류를 파일 기준으로 말하려면 필요하다 */
  bodyOffset: number
  file: string
}

interface ListFile {
  fetched_at: string
  source: string
  lists: Array<{ list: string; provision: string; rate: number; active: boolean; codes: string[] }>
}

function fail(file: string, msg: string): never {
  throw new Error(`${file}: ${msg}`)
}

/**
 * front matter 는 JSON 이다.
 *
 * YAML 을 직접 파싱하면 애매한 입력을 조용히 다르게 읽는다(따옴표 없는 값,
 * 들여쓰기, yes/no 리터럴). 발행물에서 그건 실패 모드다. JSON 은 애매할 수 없고
 * 오류 위치도 정확하다 — 쓰기 조금 불편한 대신 틀릴 수 없다.
 */
function parsePost(file: string): Post {
  const raw = readFileSync(join(SRC, file), 'utf-8').replace(/\r\n/g, '\n')
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) fail(file, 'front matter 가 없다 — 파일은 --- 로 감싼 JSON 으로 시작해야 한다')

  let meta: Partial<Post>
  try {
    meta = JSON.parse(m[1]) as Partial<Post>
  } catch (e) {
    fail(file, `front matter JSON 파싱 실패: ${(e as Error).message}`)
  }

  const bodyOffset = m[1].split('\n').length + 1
  const need = (k: keyof Post) => {
    const v = meta[k]
    if (typeof v !== 'string' || v.trim() === '') fail(file, `front matter 에 ${k} 가 없다`)
    return v
  }

  const slug = need('slug')
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) fail(file, `slug 는 소문자-하이픈이어야 한다: ${slug}`)
  if (`${slug}.md` !== file) fail(file, `파일명과 slug 가 다르다 (${slug}.md 여야 한다) — URL 과 파일이 어긋나면 추적이 안 된다`)

  const date = need('date')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(file, `date 는 YYYY-MM-DD 여야 한다: ${date}`)

  const codes = meta.codes
  if (!Array.isArray(codes)) fail(file, 'codes 배열이 없다')
  if (codes.length < MIN_CODES || codes.length > MAX_CODES) {
    fail(file, `codes 는 ${MIN_CODES}~${MAX_CODES} 개여야 한다 (지금 ${codes.length}) — 에디토리얼의 역할은 코퍼스로 링크를 흘리는 것이다 (정책 §8)`)
  }
  for (const c of codes) {
    if (typeof c !== 'string' || !/^\d{8}$/.test(c)) fail(file, `codes 는 8 자리 숫자여야 한다: ${JSON.stringify(c)}`)
  }
  if (new Set(codes).size !== codes.length) fail(file, 'codes 에 중복이 있다')

  const sources = meta.sources
  if (!Array.isArray(sources) || sources.length === 0) {
    fail(file, 'sources 가 비어 있다 — 출처 없는 사실은 싣지 않는다 (정책 §8)')
  }
  for (const s of sources) {
    if (!s || typeof s.label !== 'string' || typeof s.url !== 'string' || !/^https:\/\//.test(s.url)) {
      fail(file, `sources 항목은 { label, url(https) } 여야 한다: ${JSON.stringify(s)}`)
    }
  }

  const body = m[2].trim()
  if (body === '') fail(file, '본문이 비어 있다')

  // 얇은 글은 빈도를 올릴 때 가장 먼저 나타나는 실패다. 발행은 되고 아무도 안 막는다
  const words = body.split(/\s+/).filter(Boolean).length
  if (words < MIN_BODY_WORDS) {
    fail(file, `본문이 ${words}단어다 — 최소 ${MIN_BODY_WORDS}단어. 짧게 쓸 거면 그 주에 안 내는 게 낫다 (정책 §8)`)
  }

  // 스캐폴드가 채워두고 간 자리를 그대로 발행하면 자동 생성물이 그대로 나간다.
  // 사실 층은 유도값이라 사람이 손댈 곳이 없으므로, **의견은 사람이 썼다는 것**이
  // 이 파이프라인에서 유일하게 남은 사람의 흔적이다. 비어 있으면 막는다.
  for (const k of ['title', 'dek', 'take', 'question'] as const) {
    if (PLACEHOLDER.test(String(meta[k] ?? ''))) fail(file, `${k} 에 TODO 가 남아 있다 — 스캐폴드를 채우지 않았다`)
  }
  if (PLACEHOLDER.test(body)) fail(file, '본문에 TODO 가 남아 있다')

  return {
    title: need('title'),
    slug,
    date,
    dek: need('dek'),
    codes,
    take: need('take'),
    question: need('question'),
    sources,
    body,
    bodyOffset,
    file,
  }
}

const dotted = (c: string) => `${c.slice(0, 4)}.${c.slice(4, 6)}.${c.slice(6, 8)}`
const pct = (r: number) => `${(r * 100) % 1 === 0 ? (r * 100).toFixed(0) : (r * 100).toFixed(1)}%`

/**
 * 코드별 사실을 **커밋된 공식 데이터에서** 만든다. 글쓴이가 타이핑하지 않는다.
 * 만료된 리스트(active:false)는 "종료" 로 표시한다 — 빼버리면 그 코드가 한 번도
 * 대상이 아니었던 것처럼 읽힌다.
 */
function factsFor(codes: string[], lists: ListFile['lists']) {
  return codes.map((code) => {
    const hits = lists.filter((l) => l.codes.includes(code))
    return {
      code,
      active: hits.filter((l) => l.active).map((l) => ({ list: l.list, rate: l.rate, provision: l.provision })),
      ended: hits.filter((l) => !l.active).map((l) => ({ list: l.list, rate: l.rate, provision: l.provision })),
    }
  })
}

const CSS = `*{box-sizing:border-box}body{margin:0;font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e2e8f0;background:#020617}a{color:#93b4d4}.nav{border-bottom:1px solid #1e293b}.navin,.wrap,.foot-in{max-width:760px;margin:auto;padding:0 20px}.navin{min-height:68px;display:flex;justify-content:space-between;align-items:center}.brand{display:flex;align-items:center;gap:10px;text-decoration:none;font-weight:700;color:#fff}.mark{background:#2d6099;padding:5px 9px;border-radius:8px}.links{display:flex;gap:16px;font-size:14px}.links a{color:#cbd5e1;text-decoration:none}.wrap{padding-top:48px;padding-bottom:64px}.eyebrow{color:#93b4d4;text-transform:uppercase;letter-spacing:.12em;font-size:11px;font-weight:800;margin:0}h1{font-size:38px;line-height:1.15;margin:12px 0 10px;color:#fff}.dek{color:#94a3b8;font-size:18px;margin:0 0 8px}.meta{color:#64748b;font-size:13px}h2{font-size:24px;margin:38px 0 12px;color:#fff}h3{font-size:19px;margin:28px 0 10px;color:#fff}p{margin:0 0 16px}ul{padding-left:20px}li{margin:6px 0}blockquote{margin:20px 0;padding:12px 18px;border-left:3px solid #2d6099;background:#0f172a;border-radius:0 10px 10px 0}blockquote p{margin:0}code{background:#0f172a;border:1px solid #1e293b;border-radius:5px;padding:1px 5px;font-size:14px}hr{border:0;border-top:1px solid #1e293b;margin:32px 0}.card{border:1px solid #273449;background:#0f172a;border-radius:14px;padding:20px;margin:26px 0}.card h2{margin-top:0}.ledger{width:100%;border-collapse:collapse;font-size:14px}.ledger th{text-align:left;color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:.05em;padding:8px 10px;border-bottom:1px solid #1e293b}.ledger td{padding:9px 10px;border-top:1px solid #1e293b;vertical-align:top}.ledger a{font-weight:700;text-decoration:none}.chip{display:inline-block;margin:1px 4px 1px 0;border-radius:5px;padding:2px 7px;font-size:11px;font-weight:700;background:#422006;color:#fde68a}.chip.ended{background:#1e293b;color:#94a3b8}.badge{display:inline-block;border-radius:999px;padding:3px 10px;font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase}.badge.fact{background:rgba(45,96,153,.15);color:#c7d2fe}.badge.opinion{background:rgba(251,191,36,.14);color:#fcd34d}.take{border-color:#78350f;background:rgba(251,191,36,.05)}.ask{border-color:#312e81;background:rgba(45,96,153,.06)}.ask h2{margin-bottom:6px}form.c{display:grid;gap:10px;margin-top:14px}form.c input,form.c textarea{width:100%;padding:11px 12px;border:1px solid #334155;border-radius:10px;background:#020617;color:#e2e8f0;font:inherit}form.c textarea{min-height:110px;resize:vertical}form.c button{justify-self:start;border:0;border-radius:10px;background:#2d6099;color:#fff;font-weight:700;padding:11px 20px;cursor:pointer}form.c button:disabled{opacity:.6;cursor:wait}.hp{position:absolute;left:-9999px}.cmt{border-top:1px solid #1e293b;padding:14px 0}.cmt b{color:#fff}.cmt time{color:#64748b;font-size:12px;margin-left:8px}.cmt p{margin:6px 0 0;white-space:pre-wrap}.fig{margin:28px 0;padding:18px 18px 14px;border:1px solid #273449;border-radius:14px;background:#0f172a;overflow-x:auto}.fig svg{display:block;min-width:520px}.fig figcaption{margin-top:10px;line-height:1.55}.note{color:#64748b;font-size:12px}.err{color:#fecaca;font-size:13px}.srcs{font-size:13px;color:#94a3b8}.srcs li{margin:4px 0}.postlist{list-style:none;padding:0}.postlist li{border-top:1px solid #1e293b;padding:20px 0}.postlist h2{margin:0 0 6px;font-size:21px}.postlist a{text-decoration:none}.foot{border-top:1px solid #1e293b;color:#64748b;font-size:12px}.foot-in{padding-top:28px;padding-bottom:36px}`

const HEAD = (title: string, desc: string, canonical: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${canonical}" />
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="LandedIQ" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:image" content="${ORIGIN}/og.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="${ORIGIN}/og.png" />
  <script async src="https://www.googletagmanager.com/gtag/js?id=AW-18359222502"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','AW-18359222502')</script>
  <script src="/ads.js?v=3"></script>
  <script src="/analytics.js?v=1"></script>
  <script defer data-domain="landediq.app" src="https://plausible.io/js/script.js"></script>
  <script>var CONFIG={SUPABASE_URL:'%VITE_SUPABASE_URL%',SUPABASE_ANON_KEY:'%VITE_SUPABASE_ANON_KEY%'}</script>
  <style>${CSS}</style>
</head>
<body>
  <header class="nav"><div class="navin"><a href="/" class="brand"><span class="mark">LIQ</span><span>LandedIQ</span></a><nav class="links"><a href="/blog">Blog</a><a href="/hts">HTS Lookup</a><a href="/section-301">Section 301</a><a href="/app">Sign in</a></nav></div></header>`

const FOOT = `  <footer class="foot"><div class="foot-in">LandedIQ is operated by MTL Co., Ltd. · support@landediq.app<br />Estimates are not customs, legal or tax advice. Final classification and duty liability remain with the importer of record. · © 2026 LandedIQ</div></footer>
</body></html>
`

/**
 * 글 중간에 들어가는 그림 — 인라인 SVG 막대.
 *
 * ── 왜 스톡 사진이 아닌가 ────────────────────────────────────────
 * 컨테이너·항구 사진은 이 글에 아무것도 더하지 않는다. 글마다 같은 것을 쓰게
 * 되고, 라이선스와 용량만 따라온다. 무엇보다 **읽는 사람이 이미 아는 것**을
 * 보여준다.
 *
 * 대신 같은 데이터에서 유도한 그림을 넣는다. 손으로 못 쓰는 값이고, 글마다
 * 다르고, 표에서는 훑어야 보이는 것(코드마다 세율이 갈린다)이 한눈에 보인다.
 * 외부 파일이 없어 CSP·캐시·깨진 이미지 문제도 없다.
 *
 * ── 색 ──────────────────────────────────────────────────────────
 * 길이가 크기를, 색이 소속(어느 리스트 층)을 나타낸다. 두 칸을 고정 순서로
 * 쓰고 절대 돌려쓰지 않는다. 어두운 카드면(#0f172a)에 대해 검증기를 돌려
 * 여섯 검사를 통과한 조합이다 (CVD ΔE 32.2 · 정상시야 35.1 · 대비 3:1↑).
 * 글자는 언제나 텍스트 색을 입는다 — 계열 색을 글자에 쓰지 않는다.
 */
const TIER_HI = '#d97706' // 25% 층 (List 1·2·3)
const TIER_LO = '#2d6099' // 7.5% 층 (List 4A)

function rateChart(facts: ReturnType<typeof factsFor>): string {
  const rows = facts
    .map((f) => ({
      code: f.code,
      rate: f.active.reduce((s, a) => s + a.rate, 0),
      label: f.active.map((a) => a.list.toUpperCase()).join(' + ') || 'no active list',
    }))
    // 세율 내림차순, 동률이면 코드순 — 같은 입력이면 같은 그림이어야 한다
    .sort((a, b) => (b.rate !== a.rate ? b.rate - a.rate : a.code.localeCompare(b.code)))

  const max = Math.max(...rows.map((r) => r.rate), 0.075)
  const W = 700
  const ROW = 30
  const BAR = 13
  const X0 = 118
  const X1 = W - 78
  const H = rows.length * ROW + 54

  const bar = (x0: number, y: number, w: number, fill: string) => {
    const r = Math.min(4, w)
    if (w < 1) return ''
    return `<path d="M${x0} ${y}H${x0 + w - r}a${r} ${r} 0 0 1 ${r} ${r}V${y + BAR - r}a${r} ${r} 0 0 1 ${-r} ${r}H${x0}Z" fill="${fill}" />`
  }

  const body = rows
    .map((r, i) => {
      const y = 44 + i * ROW
      const w = Math.round(((X1 - X0) * r.rate) / (max * 1.08))
      const fill = r.rate >= 0.2 ? TIER_HI : TIER_LO
      const val = r.rate === 0 ? '—' : `+${pct(r.rate)}`
      return `<g><title>${esc(dotted(r.code))} · ${esc(r.label)} · ${esc(val)}</title>
      <text x="${X0 - 12}" y="${y + BAR - 2}" text-anchor="end" class="c">${esc(dotted(r.code))}</text>
      ${bar(X0, y, w, fill)}
      <text x="${X0 + w + 9}" y="${y + BAR - 2}" class="v">${esc(val)}</text></g>`
    })
    .join('')

  const legend = `<g class="lg">
    <rect x="${X0}" y="14" width="9" height="9" rx="2" fill="${TIER_HI}" /><text x="${X0 + 15}" y="22">Lists 1–3 · +25%</text>
    <rect x="${X0 + 132}" y="14" width="9" height="9" rx="2" fill="${TIER_LO}" /><text x="${X0 + 147}" y="22">List 4A · +7.5%</text></g>`

  return `<figure class="fig">
    <svg viewBox="0 0 ${W} ${H}" role="img" width="100%" aria-labelledby="cht-t cht-d">
      <title id="cht-t">Section 301 rate by HTS code</title>
      <desc id="cht-d">Horizontal bars, one per code in this post, sorted by Section 301 rate. Every value is also printed beside its bar, and the same numbers appear in the table above.</desc>
      <style>text{font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#94a3b8}.c{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;fill:#cbd5e1}.v{font-variant-numeric:tabular-nums;font-weight:700;fill:#e2e8f0}.lg text{font-size:11.5px;fill:#94a3b8}</style>
      ${legend}${body}
    </svg>
    <figcaption class="note">Section 301 layer only, by code — the same figures as the table above, drawn from the official HTSUS Chapter 99 snapshot. Base MFN is not included here; open any code for its full stack.</figcaption>
  </figure>`
}

function ledgerTable(facts: ReturnType<typeof factsFor>, fetchedAt: string): string {
  const rows = facts
    .map((f) => {
      const chips = [
        ...f.active.map((a) => `<span class="chip">${a.list.toUpperCase()} +${pct(a.rate)}</span>`),
        ...f.ended.map((a) => `<span class="chip ended">${a.list.toUpperCase()} ended</span>`),
      ].join('')
      return `<tr><td><a href="/hts/${f.code}">${dotted(f.code)}</a></td><td>${chips || '<span class="note">no Section 301 list</span>'}</td></tr>`
    })
    .join('')
  return `<div class="card"><span class="badge fact">Facts · from the ledger</span>
      <h2>Section 301 coverage for the codes in this post</h2>
      <table class="ledger"><thead><tr><th>HTS (8-digit)</th><th>Active Section 301 lists</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="note">Derived from the official HTSUS Chapter 99 list snapshot (fetched ${esc(fetchedAt)}). Nobody types these by hand. Rates shown are the Section 301 layer only — open any code for the full stack including base MFN.</p></div>`
}

const COMMENT_JS = `<script>
  /* data-slug 는 <main> 에 있다. body 에서 읽으면 undefined 가 되고, post_slug 가
     NOT NULL 이라 모든 댓글이 400 으로 죽는다 — 스모크가 잡은 실제 버그다. */
  var slug=document.querySelector('[data-slug]').dataset.slug,box=document.getElementById('cmts'),form=document.getElementById('cform');
  function ok(){return CONFIG.SUPABASE_URL&&CONFIG.SUPABASE_URL.indexOf('%VITE_')!==0}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]})}
  function show(rows){box.innerHTML=rows.length?rows.map(function(r){
    return '<div class="cmt"><b>'+esc(r.author)+'</b><time>'+esc(String(r.created_at).slice(0,10))+'</time><p>'+esc(r.body)+'</p></div>'}).join(''):'<p class="note">No replies yet. Yours would be the first.</p>'}
  function load(){if(!ok())return;fetch(CONFIG.SUPABASE_URL+'/rest/v1/blog_comments?select=author,body,created_at&post_slug=eq.'+encodeURIComponent(slug)+'&order=created_at.asc',{headers:{apikey:CONFIG.SUPABASE_ANON_KEY,Authorization:'Bearer '+CONFIG.SUPABASE_ANON_KEY}}).then(function(r){return r.json()}).then(show).catch(function(){})}
  form.addEventListener('submit',function(e){e.preventDefault();
    var d=new FormData(form),b=form.querySelector('button'),err=document.getElementById('cerr');
    if(d.get('website'))return; /* honeypot — 봇이 채우면 조용히 버린다 */
    err.textContent='';b.disabled=true;b.textContent='Posting…';
    window.track&&window.track('comment_submitted',{slug:slug});
    fetch(CONFIG.SUPABASE_URL+'/rest/v1/blog_comments',{method:'POST',headers:{'Content-Type':'application/json',apikey:CONFIG.SUPABASE_ANON_KEY,Authorization:'Bearer '+CONFIG.SUPABASE_ANON_KEY,Prefer:'return=minimal'},body:JSON.stringify({post_slug:slug,author:d.get('author'),body:d.get('body')})})
      .then(function(r){if(!r.ok)throw new Error('save '+r.status);
        window.track&&window.track('comment_posted',{slug:slug});form.reset();load()})
      .catch(function(x){window.track&&window.track('comment_failed',{slug:slug,reason:String(x.message).slice(0,80)});
        err.textContent='Could not post that. Please try again, or email support@landediq.app.'})
      .then(function(){b.disabled=false;b.textContent='Post your take'})});
  load();
</script>`

/**
 * 본문 중간에 그림을 끼운다.
 *
 * 위치를 글쓴이에게 맡기지 않는다 — 마크다운에 자리표시자를 두면 그것도 문법이
 * 되고, 빠뜨린 글은 그림 없이 나간다. 대신 중간에서 가장 가까운 소제목 앞에
 * 넣는다. 문단을 자르지 않고, 읽는 흐름이 한 번 끊기는 자리가 원래 거기다.
 * 소제목이 없으면 블록 수의 절반 지점에 넣는다.
 */
function insertFigure(bodyHtml: string, figure: string): string {
  const blocks = bodyHtml.split('\n')
  if (blocks.length < 3) return `${bodyHtml}\n${figure}`
  const mid = Math.floor(blocks.length / 2)
  let at = -1
  for (let d = 0; d < blocks.length; d++) {
    for (const i of [mid - d, mid + d]) {
      if (at === -1 && i > 0 && i < blocks.length && blocks[i].startsWith('<h2')) at = i
    }
    if (at !== -1) break
  }
  const pos = at === -1 ? mid : at
  return [...blocks.slice(0, pos), figure, ...blocks.slice(pos)].join('\n')
}

function renderPost(p: Post, lists: ListFile): string {
  const canonical = `${ORIGIN}/blog/${p.slug}`
  const facts = factsFor(p.codes, lists.lists)
  const body = insertFigure(renderMarkdown(p.body, p.bodyOffset), rateChart(facts))
  const sources = p.sources
    .map((s) => `<li><a href="${esc(s.url)}" rel="nofollow noopener" target="_blank">${esc(s.label)}</a></li>`)
    .join('')

  return `${HEAD(`${p.title} | LandedIQ`, p.dek, canonical)}
  <main class="wrap" data-slug="${esc(p.slug)}">
    <p class="eyebrow">Editorial</p>
    <h1>${esc(p.title)}</h1>
    <p class="dek">${esc(p.dek)}</p>
    <p class="meta">${esc(p.date)} · LandedIQ</p>

    ${ledgerTable(facts, lists.fetched_at)}

    ${body}

    <div class="card take"><span class="badge opinion">Opinion · not a finding</span>
      <h2>My take</h2>
      <p>${esc(p.take)}</p>
      <p class="note">This section is interpretation and prediction. The table above is data; this is a bet. Treat them differently.</p></div>

    <div class="card ask" id="replies"><span class="badge opinion">Over to you</span>
      <h2>What do you think?</h2>
      <p>${esc(p.question)}</p>
      <form class="c" id="cform">
        <input name="author" required maxlength="60" placeholder="Your name or company" />
        <textarea name="body" required minlength="4" maxlength="2000" placeholder="Tell us what you are seeing on your own shipments."></textarea>
        <input class="hp" name="website" tabindex="-1" autocomplete="off" />
        <button>Post your take</button>
      </form>
      <p class="err" id="cerr"></p>
      <p class="note">Replies are public. No account needed. Be specific — vague takes help nobody.</p>
      <div id="cmts"></div></div>

    <h2>Sources</h2>
    <ul class="srcs">${sources}</ul>

    <div class="card"><h2>Check your own codes</h2>
      <p>Look up any HTS code with the duty layers separated, or run a full landed-cost estimate on your SKUs.</p>
      <p><a href="/hts">Free HTS lookup →</a> &nbsp; <a href="/app">Open the beta workspace →</a></p></div>
  </main>
${COMMENT_JS}
${FOOT}`
}

function renderIndex(posts: Post[]): string {
  const items = posts
    .map(
      (p) => `<li><h2><a href="/blog/${p.slug}">${esc(p.title)}</a></h2><p class="dek">${esc(p.dek)}</p><p class="meta">${esc(p.date)}</p></li>`,
    )
    .join('')
  return `${HEAD(
    'Tariff editorial | LandedIQ',
    'Weekly notes on U.S. tariff changes — the ledger facts, then an argument you can disagree with.',
    `${ORIGIN}/blog`,
  )}
  <main class="wrap">
    <p class="eyebrow">Editorial</p>
    <h1>Tariff notes</h1>
    <p class="dek">One post a week. The facts come straight from the duty ledger; the argument is ours, and you are invited to take it apart.</p>
    <ul class="postlist">${items}</ul>
  </main>
${FOOT}`
}

/**
 * 편수가 늘 때만 나타나는 실패를 본다.
 *
 * 한 편만 놓고 보면 멀쩡한 글도, 스무 편을 늘어놓으면 같은 코드에 같은 문장으로
 * 같은 말을 하고 있는 게 보인다. 그게 대량 생성물의 모양이다. 주 1 편에서는
 * 사람이 알아서 피하지만 주 3 회에서는 못 피한다 — 그래서 기계가 본다.
 *
 * posts 는 최신순으로 정렬돼 들어온다.
 */
function assertNotRepetitive(posts: Post[]): void {
  const problems: string[] = []

  // 같은 코드를 최근 창 안에서 반복하면 주제가 아니라 코드를 돌려쓰는 것이다
  const recent = posts.slice(0, RECENT_WINDOW)
  const used = new Map<string, string[]>()
  for (const p of recent) for (const c of p.codes) used.set(c, [...(used.get(c) ?? []), p.slug])
  for (const [code, slugsFor] of used) {
    if (slugsFor.length > MAX_CODE_REUSE) {
      problems.push(`코드 ${code} 가 최근 ${recent.length}편 중 ${slugsFor.length}편에 나온다 (상한 ${MAX_CODE_REUSE}): ${slugsFor.join(', ')}`)
    }
  }

  // 문장을 그대로 재사용하면 템플릿이다. 사람이 매번 새로 생각했는지의 대리 지표다
  for (const field of ['title', 'dek', 'take', 'question'] as const) {
    const seenText = new Map<string, string>()
    for (const p of posts) {
      const key = p[field].trim().toLowerCase()
      const prev = seenText.get(key)
      if (prev) problems.push(`${field} 가 ${prev} 와 글자 그대로 같다: ${p.slug}`)
      else seenText.set(key, p.slug)
    }
  }

  if (problems.length > 0) {
    throw new Error(
      ['에디토리얼이 반복적이다 — 빈도를 올릴 때 가장 먼저 무너지는 지점이다 (정책 §8)', ...problems.map((p) => `  ✗ ${p}`)].join('\n'),
    )
  }
}

function main() {
  if (!existsSync(SRC)) throw new Error(`${SRC} 가 없다`)
  const lists = JSON.parse(readFileSync(LISTS, 'utf-8')) as ListFile

  const files = readdirSync(SRC).filter((f) => f.endsWith('.md')).sort()
  if (files.length === 0) throw new Error(`${SRC} 에 글이 없다 — 빈 블로그를 발행하지 않는다`)

  const posts = files.map(parsePost).sort((a, b) => (a.date < b.date ? 1 : -1))
  const slugs = new Set(posts.map((p) => p.slug))
  if (slugs.size !== posts.length) throw new Error('slug 가 중복이다')
  assertNotRepetitive(posts)

  mkdirSync(OUT_DIR, { recursive: true })
  const written: string[] = []
  for (const p of posts) {
    const path = join(OUT_DIR, `${p.slug}.html`)
    writeFileSync(path, renderPost(p, lists), 'utf-8')
    written.push(`blog/${p.slug}.html`)
  }
  writeFileSync(join(root, 'blog.html'), renderIndex(posts), 'utf-8')
  written.push('blog.html')

  console.log(`── 에디토리얼 ${MODE === 'verify' ? '대조' : '발행'} ──────────────────`)
  for (const p of posts) console.log(`  ${p.date}  ${p.slug.padEnd(38)} 코드 ${p.codes.length}개`)
  console.log(`→ ${written.length}개 파일. 커밋할 것 (vite.config.ts 가 blog/ 를 자동으로 입력에 넣는다).`)
}

main()
