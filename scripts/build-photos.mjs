/**
 * 원본 사진 → 웹용 WebP 로 변환한다 → public/photo/*.webp
 *
 * ── 왜 스크립트인가 ────────────────────────────────────────────
 * 손으로 자른 이미지를 커밋하면 "왜 이 크기인지" 가 사라지고, 원본을 다시
 * 받았을 때 같은 처리를 재현할 수 없다. 이 저장소는 생성물을 생성기로
 * 관리한다 — 사진도 같게 둔다.
 *
 * ── 오른쪽을 자르는 이유 ────────────────────────────────────────
 * 원본 오른쪽 아래에 생성기 워터마크(반짝임 마크)가 있다. AI 가 만든 티를
 * 지우려는 작업에 생성 표식이 박혀 있으면 역효과라 크롭으로 제외한다.
 * 파일에 심긴 비가시 출처 정보(SynthID 등)는 건드리지 않는다 — 그건 지울
 * 대상도 아니고 지울 수도 없다.
 *
 * ── 왜 WebP 인가 ───────────────────────────────────────────────
 * 원본 PNG 3 장이 2.4 MB 다. 히어로 배경은 LCP 를 직접 물고 있어서 그대로
 * 쓰면 광고로 들어온 사람이 첫 화면을 기다린다. WebP 는 현행 브라우저가
 * 전부 지원하므로 폴백을 두지 않는다.
 *
 * sharp·ImageMagick 이 없는 환경이라 Chromium 캔버스로 인코딩한다.
 *
 * 실행: npm run photo:build -- <터미널.png> <사무실.png> <종이.png>
 *   PLAYWRIGHT_CHROMIUM 으로 브라우저 실행 파일을 지정할 수 있다.
 */
import { chromium } from 'playwright'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

/** 잘라낼 오른쪽 비율 — 워터마크를 확실히 벗어난다. 세로는 그대로 둔다. */
const CROP_RIGHT = 0.115

const PRESETS = {
  terminal: { maxW: 1440, quality: 0.82 },
  operations: { maxW: 1100, quality: 0.82 },
  layers: { maxW: 1100, quality: 0.82 },
  seal: { maxW: 1440, quality: 0.82 },
}

/**
 * 인자는 `이름=경로` 쌍이다. 준 것만 만든다.
 *
 * 처음에는 위치 인자로 세 장을 한꺼번에 받았는데, 네 번째를 추가하려면 앞의 세
 * 장을 다시 인코딩해야 했다. 재인코딩 결과가 1 바이트라도 다르면 관계없는
 * 파일이 diff 에 섞이고, 리뷰어는 "이 사진도 바뀌었나" 를 확인할 방법이 없다.
 */
const args = process.argv.slice(2)
const TARGETS = args.map((a) => {
  const i = a.indexOf('=')
  if (i < 0) {
    console.error(`인자는 이름=경로 형식이어야 한다: ${a}`)
    process.exit(1)
  }
  const name = a.slice(0, i)
  if (!PRESETS[name]) {
    console.error(`모르는 이름: ${name} (${Object.keys(PRESETS).join(', ')} 중 하나)`)
    process.exit(1)
  }
  return { name, src: a.slice(i + 1), ...PRESETS[name] }
})
if (TARGETS.length === 0) {
  console.error(`만들 대상이 없다. 예: npm run photo:build -- seal=/path/to.png`)
  process.exit(1)
}
const inputs = TARGETS.map((t) => t.src)

const OUT_DIR = resolve(process.cwd(), 'public/photo')
mkdirSync(OUT_DIR, { recursive: true })

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
)
const page = await browser.newPage()

for (const [i, t] of TARGETS.entries()) {
  const b64 = readFileSync(resolve(inputs[i])).toString('base64')
  const out = await page.evaluate(
    async ({ b64, cropRight, maxW, quality }) => {
      const img = new Image()
      img.src = 'data:image/png;base64,' + b64
      await img.decode()

      const sw = Math.round(img.naturalWidth * (1 - cropRight))
      const sh = img.naturalHeight
      const scale = Math.min(1, maxW / sw) // 확대하지 않는다 — 없는 디테일이 생기지 않는다
      const dw = Math.round(sw * scale)
      const dh = Math.round(sh * scale)

      const c = document.createElement('canvas')
      c.width = dw
      c.height = dh
      const ctx = c.getContext('2d')
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, sw, sh, 0, 0, dw, dh)

      const url = c.toDataURL('image/webp', quality)
      return { data: url.split(',')[1], w: dw, h: dh, srcW: img.naturalWidth, srcH: img.naturalHeight }
    },
    { b64, cropRight: CROP_RIGHT, maxW: t.maxW, quality: t.quality },
  )

  const buf = Buffer.from(out.data, 'base64')
  writeFileSync(resolve(OUT_DIR, `${t.name}.webp`), buf)
  console.log(
    `  ${t.name}.webp  ${out.srcW}×${out.srcH} → ${out.w}×${out.h}  ${(buf.length / 1024).toFixed(0)} KB`,
  )
}

await browser.close()
console.log('→ public/photo/ — 커밋할 것')
