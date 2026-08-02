/**
 * 코드 페이지 발행 — `npm run hts:pages` (npm run build 에 포함).
 *
 * ── 웨이브 파일이 발행 대상이다 ──────────────────────────────────
 * 입력은 `data/wave1.json` 하나다. USITC 카탈로그(8.6MB, gitignore)를 읽지
 * **않는다** — 읽으면 Vercel 빌드에서는 없는 파일이라 페이지가 조용히 사라진다.
 *
 * 대신 `npm run seo:wave1` 이 카탈로그를 읽어 렌더에 필요한 것만 웨이브 파일에
 * 담아 커밋한다. 그래서:
 *   - 무엇이 발행되는지가 git diff 로 보인다 (§4 단계 공개의 실체)
 *   - 사람이 눈으로 확인하고 낸다는 §5 규칙이 리뷰 절차로 실현된다
 *   - 빌드 환경에 카탈로그가 없어도 된다
 *
 * 웨이브 파일이 없으면 **아무것도 발행하지 않고 그렇다고 말한다.** 실패시키지는
 * 않는다 — "아직 웨이브를 안 냈다" 는 정상 상태이고, 그걸 빌드 실패로 만들면
 * 나머지 배포가 전부 막힌다. 대신 check-build 가 "웨이브 파일은 있는데 페이지가
 * 없는" 불일치를 잡는다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { renderCodePage, type CodePagePayload, type RenderContext } from '../src/lib/seo/codePage'
import { decidePage } from '../src/lib/seo/pages'
import { DISCLAIMER_EN } from '../src/lib/disclaimer'
import type { FeeSettings } from '../src/lib/calc/types'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const WAVE = join(root, 'data/wave1.json')
const INPUTS = join(root, 'sample-report.inputs.json')
const OUT = join(root, 'dist/hts')

/** 예시 선적 — 페이지에 그대로 표기하므로 숫자를 숨기지 않는다 */
const EXAMPLE_VALUE_USD = 10000
const EXAMPLE_UNITS = 1000

interface WaveFile {
  as_of?: string
  codes: CodePagePayload[]
}

function main() {
  if (!existsSync(WAVE)) {
    console.log('코드 페이지: data/wave1.json 이 없어 발행하지 않는다 (npm run seo:wave1 — USITC 카탈로그 필요)')
    return
  }
  if (!existsSync(join(root, 'dist'))) {
    throw new Error('dist/ 가 없다 — vite build 뒤에 실행해야 한다')
  }

  const wave = JSON.parse(readFileSync(WAVE, 'utf-8')) as WaveFile
  const fees = (JSON.parse(readFileSync(INPUTS, 'utf-8')) as { fees: FeeSettings; as_of: string })
  const ctx: RenderContext = {
    fees: fees.fees,
    asOf: wave.as_of ?? fees.as_of,
    exampleValueUsd: EXAMPLE_VALUE_USD,
    exampleUnits: EXAMPLE_UNITS,
  }

  mkdirSync(OUT, { recursive: true })
  let written = 0
  const rejected: string[] = []

  for (const p of wave.codes) {
    // 게이트를 여기서 다시 본다. 웨이브 파일은 손으로 고칠 수 있고, 그 손이
    // 색인 불가 코드를 끼워 넣으면 사이트맵까지 따라간다 (§2)
    const decision = decidePage({
      code: p.code, description: p.description, adValorem: p.ad_valorem,
      programs: p.programs.map((x) => x.list), demandRank: null,
    })
    if (!decision.indexable) {
      rejected.push(`${p.code} (${decision.blockers.join(', ')})`)
      continue
    }
    writeFileSync(join(OUT, `${p.code}.html`), renderCodePage(p, ctx, DISCLAIMER_EN), 'utf-8')
    written++
  }

  console.log(`── 코드 페이지 발행 ────────────────────────────`)
  console.log(`  발행 ${written}장 → dist/hts/`)
  if (rejected.length > 0) {
    console.log(`  게이트 탈락 ${rejected.length}건: ${rejected.slice(0, 5).join(', ')}${rejected.length > 5 ? ' …' : ''}`)
  }
  if (written === 0) throw new Error('웨이브 파일이 있는데 한 장도 발행되지 않았다 — 전부 게이트에 걸렸다')
}

main()
