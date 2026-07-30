/**
 * `sample-report.inputs.json` 이 DB 와 갈라졌는지 검사한다.
 *
 * inputs.json 은 **두 번째 출처가 아니다.** 수수료의 진실 출처는 DB(fee_settings)
 * 이고, 그 파일은 CI 가 오프라인으로 드리프트 가드를 돌리기 위해 남긴 fixture 다.
 * 이 명령이 그 구분을 지켜준다 — fixture 가 낡으면 여기서 걸린다.
 *
 * CI 에는 자격증명이 없으므로 여기서 돌지 않는다. DB 접속 가능한 환경에서
 * 실행한다 (SOP 분기 점검 · 요율 반영 절차).
 *
 * 실행: npm run sample:check-inputs
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadFees } from './lib/fees'
import type { FeeSettings } from '../src/lib/calc/types'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const INPUTS = join(root, 'sample-report.inputs.json')

if (!existsSync(INPUTS)) {
  console.error(`✗ ${INPUTS} 가 없다 — npm run sample:build 로 생성할 것`)
  process.exit(1)
}

const fixture = JSON.parse(readFileSync(INPUTS, 'utf-8')) as { as_of: string; fees: FeeSettings }
const live = await loadFees(fixture.as_of)

const KEYS = ['mpf_rate', 'mpf_min_usd', 'mpf_max_usd', 'hmf_rate', 'effective_from'] as const
const diffs = KEYS.filter((k) => String(fixture.fees[k]) !== String(live[k])).map(
  (k) => `  ${k}: fixture ${fixture.fees[k]} ≠ DB ${live[k]}`,
)

console.log(`기준일 ${fixture.as_of} 로 대조`)
if (diffs.length > 0) {
  console.error()
  console.error('── fixture 가 DB 와 다르다 ──────────────────────')
  for (const d of diffs) console.error(d)
  console.error()
  console.error('  진실 출처는 DB 다. npm run sample:build 로 fixture 를 갱신하고')
  console.error('  샘플 HTML·랜딩 표와 함께 커밋할 것.')
  process.exit(1)
}
console.log('fixture 가 DB 현재값과 일치한다')
