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

const CSS = `*{box-sizing:border-box}body{margin:0;font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e2e8f0;background:#020617}a{color:#a5b4fc}.nav{border-bottom:1px solid #1e293b}.navin,.wrap,.foot-in{max-width:760px;margin:auto;padding:0 20px}.navin{min-height:68px;display:flex;justify-content:space-between;align-items:center}.brand{display:flex;align-items:center;gap:10px;text-decoration:none;font-weight:700;color:#fff}.mark{background:#6366f1;padding:5px 9px;border-radius:8px}.links{display:flex;gap:16px;font-size:14px}.links a{color:#cbd5e1;text-decoration:none}.wrap{padding-top:48px;padding-bottom:64px}.eyebrow{color:#a5b4fc;text-transform:uppercase;letter-spacing:.12em;font-size:11px;font-weight:800;margin:0}h1{font-size:38px;line-height:1.15;margin:12px 0 10px;color:#fff}.dek{color:#94a3b8;font-size:18px;margin:0 0 8px}.meta{color:#64748b;font-size:13px}h2{font-size:24px;margin:38px 0 12px;color:#fff}h3{font-size:19px;margin:28px 0 10px;color:#fff}p{margin:0 0 16px}ul{padding-left:20px}li{margin:6px 0}blockquote{margin:20px 0;padding:12px 18px;border-left:3px solid #6366f1;background:#0f172a;border-radius:0 10px 10px 0}blockquote p{margin:0}code{background:#0f172a;border:1px solid #1e293b;border-radius:5px;padding:1px 5px;font-size:14px}hr{border:0;border-top:1px solid #1e293b;margin:32px 0}.card{border:1px solid #273449;background:#0f172a;border-radius:14px;padding:20px;margin:26px 0}.card h2{margin-top:0}.ledger{width:100%;border-collapse:collapse;font-size:14px}.ledger th{text-align:left;color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:.05em;padding:8px 10px;border-bottom:1px solid #1e293b}.ledger td{padding:9px 10px;border-top:1px solid #1e293b;vertical-align:top}.ledger a{font-weight:700;text-decoration:none}.chip{display:inline-block;margin:1px 4px 1px 0;border-radius:5px;padding:2px 7px;font-size:11px;font-weight:700;background:#422006;color:#fde68a}.chip.ended{background:#1e293b;color:#94a3b8}.badge{display:inline-block;border-radius:999px;padding:3px 10px;font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase}.badge.fact{background:rgba(99,102,241,.15);color:#c7d2fe}.badge.opinion{background:rgba(251,191,36,.14);color:#fcd34d}.take{border-color:#78350f;background:rgba(251,191,36,.05)}.ask{border-color:#312e81;background:rgba(99,102,241,.06)}.ask h2{margin-bottom:6px}form.c{display:grid;gap:10px;margin-top:14px}form.c input,form.c textarea{width:100%;padding:11px 12px;border:1px solid #334155;border-radius:10px;background:#020617;color:#e2e8f0;font:inherit}form.c textarea{min-height:110px;resize:vertical}form.c button{justify-self:start;border:0;border-radius:10px;background:#6366f1;color:#fff;font-weight:700;padding:11px 20px;cursor:pointer}form.c button:disabled{opacity:.6;cursor:wait}.hp{position:absolute;left:-9999px}.cmt{border-top:1px solid #1e293b;padding:14px 0}.cmt b{color:#fff}.cmt time{color:#64748b;font-size:12px;margin-left:8px}.cmt p{margin:6px 0 0;white-space:pre-wrap}.note{color:#64748b;font-size:12px}.err{color:#fecaca;font-size:13px}.srcs{font-size:13px;color:#94a3b8}.srcs li{margin:4px 0}.postlist{list-style:none;padding:0}.postlist li{border-top:1px solid #1e293b;padding:20px 0}.postlist h2{margin:0 0 6px;font-size:21px}.postlist a{text-decoration:none}.foot{border-top:1px solid #1e293b;color:#64748b;font-size:12px}.foot-in{padding-top:28px;padding-bottom:36px}`

const HEAD = (title: string, desc: string, canonical: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${canonical}" />
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

function renderPost(p: Post, lists: ListFile): string {
  const canonical = `${ORIGIN}/blog/${p.slug}`
  const facts = factsFor(p.codes, lists.lists)
  const body = renderMarkdown(p.body, p.bodyOffset)
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

function main() {
  if (!existsSync(SRC)) throw new Error(`${SRC} 가 없다`)
  const lists = JSON.parse(readFileSync(LISTS, 'utf-8')) as ListFile

  const files = readdirSync(SRC).filter((f) => f.endsWith('.md')).sort()
  if (files.length === 0) throw new Error(`${SRC} 에 글이 없다 — 빈 블로그를 발행하지 않는다`)

  const posts = files.map(parsePost).sort((a, b) => (a.date < b.date ? 1 : -1))
  const slugs = new Set(posts.map((p) => p.slug))
  if (slugs.size !== posts.length) throw new Error('slug 가 중복이다')

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
