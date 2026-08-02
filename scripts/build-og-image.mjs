/**
 * 소셜 공유 카드(og:image)를 생성한다 → public/og.png (1200×630)
 *
 * ── 왜 필요한가 ─────────────────────────────────────────────────
 * og:image 가 없으면 Slack·LinkedIn·카카오톡에 링크를 붙였을 때 이미지 없는
 * 맨 텍스트 카드가 뜬다. 실재하는 회사 사이트에서 이런 경우는 없고, 보는
 * 사람은 그걸 "실체 없음" 신호로 읽는다.
 *
 * ── 왜 숫자를 넣지 않는가 ────────────────────────────────────────
 * 이 저장소는 손으로 넣은 세율 때문에 두 번 다쳤다 — 존재하지 않는 라인의
 * MFN 9.8%, 그리고 3-SKU 기준으로 잘못 계산한 landed $3.29. check.yml 에
 * 그걸 막는 드리프트 가드가 있다. 이미지에 세율을 박으면 같은 함정에 다시
 * 빠지고, 이번에는 CI 가 못 잡는다 (PNG 는 diff 가 안 된다). 그래서 카드는
 * **층의 구조만** 보여주고 수치는 비운다. 구조는 원장이 바뀌어도 안 틀린다.
 *
 * ── 왜 빌드에 넣지 않는가 ────────────────────────────────────────
 * 렌더링에 Chromium 이 필요하다. 매 빌드마다 브라우저를 요구하면 빌드가
 * 무거워지고, 브라우저 설치 실패가 배포 실패로 번진다. 생성물을 커밋하고
 * 카드를 바꿀 때만 이 스크립트를 돌린다.
 *
 * 실행: npm run og:build
 *   컨테이너에 다른 빌드가 깔려 있으면 PLAYWRIGHT_CHROMIUM 으로 지정한다.
 */
import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const OUT = resolve(process.cwd(), 'public/og.png')

/** 팔레트는 사이트와 같은 값을 쓴다 — 카드만 따로 놀면 가짜처럼 보인다. */
const C = {
  bg: '#020617',
  panel: '#0f172a',
  line: '#1e293b',
  accent: '#2d6099',
  accentLight: '#93b4d4',
  text: '#e2e8f0',
  muted: '#94a3b8',
  white: '#ffffff',
}

const html = `<!doctype html><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:1200px;height:630px;background:${C.bg};color:${C.text};
  font:400 16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  background-image:radial-gradient(circle at 22% 0,rgba(45,96,153,.30),transparent 55%);
  padding:74px 78px;display:flex;flex-direction:column;justify-content:space-between}
.brand{display:flex;align-items:center;gap:14px;font-weight:700;font-size:25px;color:${C.white}}
.mark{background:${C.accent};padding:9px 15px;border-radius:11px;letter-spacing:.02em}
h1{font-size:63px;line-height:1.06;color:${C.white};font-weight:800;letter-spacing:-.022em;max-width:16ch}
.sub{margin-top:20px;font-size:24px;color:${C.muted};max-width:34ch;line-height:1.42}
.right{position:absolute;right:78px;top:186px;width:395px}
/* 층 구조만 보여준다 — 수치는 넣지 않는다 (파일 상단 주석 참고). */
.layer{display:flex;align-items:center;gap:15px;margin-bottom:13px}
.bar{height:31px;border-radius:8px;border:1px solid ${C.line}}
/* 합계는 구성요소의 합과 같아야 한다 (96+172+52=320). 어긋나면 관세를 아는
   사람이 첫눈에 알아채고, 그 순간 이 카드가 말하려던 신뢰가 사라진다. */
.b1{width:96px;background:#cbd5e1}
.b2{width:172px;background:#fcd34d}
.b3{width:52px;background:#dbeafe}
.b4{width:320px;background:${C.accent};border-color:${C.accent}}
.lbl{font-size:15.5px;color:${C.muted};white-space:nowrap}
.lbl.tot{color:${C.white};font-weight:750}
.foot{display:flex;gap:32px;font-size:17.5px;color:${C.accentLight};font-weight:650}
.foot span:before{content:'✓';margin-right:9px;color:#6ee7b7}
.rule{height:1px;background:${C.line};margin:26px 0 22px}
</style>
<div class="brand"><span class="mark">LIQ</span><span>LandedIQ</span></div>
<div>
  <h1>U.S. duty, layer by layer.</h1>
  <p class="sub">Base rate, additional tariff programs and fees — separated, dated and auditable.</p>
</div>
<div class="right">
  <div class="layer"><div class="bar b1"></div><span class="lbl">Base MFN</span></div>
  <div class="layer"><div class="bar b2"></div><span class="lbl">Section 301</span></div>
  <div class="layer"><div class="bar b3"></div><span class="lbl">Fees</span></div>
  <div class="rule"></div>
  <div class="layer"><div class="bar b4"></div><span class="lbl tot">Landed duty</span></div>
</div>
<div class="foot"><span>Official USITC source</span><span>Effective-date aware</span><span>No silent zeroes</span></div>`

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
)
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
await page.setContent(html, { waitUntil: 'load' })
const buf = await page.screenshot({ type: 'png' })
await browser.close()

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, buf)
console.log(`og:image 생성 — public/og.png (${(buf.length / 1024).toFixed(1)} KB, 1200×630)`)
