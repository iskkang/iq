/**
 * 참조 데이터 테이블 스키마 규칙 검사 (1층 — 정적 파싱).
 *
 * ── 왜 있는가 ────────────────────────────────────────────────────
 * duty_programs 에는 발효일 체계를 넣었는데 fee_settings 에는 안 넣었다.
 * 그래서 FY2025 값이 만료 표시 없이 현행처럼 남아 있었고, 어느 회계연도
 * 값인지도 기록되지 않았다. 다음에 또 다른 요율 테이블이 생기면 같은 일이
 * 반복된다 — 개별 수정이 아니라 규칙으로 막아야 하는 지점이다.
 *
 * **참조 데이터 테이블은 effective_from · effective_to · source 를 반드시 갖는다.**
 *   effective_from/to  언제부터/까지 유효한가. 만료를 데이터로 표현하지 못하면
 *                      무효가 된 값이 계속 계산에 들어간다 (IEEPA 로 이미 겪었다)
 *   source             어느 고시·문서에서 왔는가. 없으면 수기 대조가 불가능하고,
 *                      "기억에서 넣은 값"과 "고시로 확인한 값"이 구분되지 않는다
 *
 * ── 이 검사의 한계 (중요) ────────────────────────────────────────
 * 정적 파싱은 **선언**을 본다. 실제 DB 는 보지 않는다. SQL Editor 로 직접 바꾼
 * 변경은 마이그레이션에 없으므로 여기서 통과하고도 DB 는 다를 수 있다.
 * 실제 대조는 SOP 분기 점검의 information_schema 실조회가 담당한다 (2층).
 *
 * 실행: npm run check:schema (npm run check 에 포함)
 */
import { readFileSync, existsSync } from 'node:fs'
// 마이그레이션 파서는 check-docs 와 **한 벌만** 쓴다 (scripts/lib/migrations.ts).
// 사본을 두면 한쪽만 고쳐져 두 검사가 서로 다른 답을 낸다.
import { collectTables } from './lib/migrations'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXCEPTIONS = join(root, 'supabase/reference-tables.exceptions.json')

const REQUIRED = ['effective_from', 'effective_to', 'source'] as const


/**
 * 참조 데이터 테이블인가 — **화이트리스트가 아니라 규칙으로 판별한다.**
 * 목록을 손으로 유지하면 다음에 생기는 테이블이 또 빠진다.
 *
 *   요율/프로그램 성격의 컬럼을 갖고        (rate 계열, 또는 program_code)
 *   워크스페이스에 속하지 않는다            (workspace_id 없음 = 고객 데이터 아님)
 *
 * items 는 unit_cost_usd 를 갖지만 workspace_id 가 있어 제외된다.
 */
function isReferenceTable(name: string, cols: Set<string>): boolean {
  if (cols.has('workspace_id')) return false
  const rateLike = [...cols].some((c) => /(^|_)rate$/.test(c) || c === 'ad_valorem_rate')
  const programLike = cols.has('program_code') || /program/.test(name)
  return rateLike || programLike
}

function loadExceptions(): Map<string, string> {
  if (!existsSync(EXCEPTIONS)) return new Map()
  const raw = JSON.parse(readFileSync(EXCEPTIONS, 'utf-8')) as Array<{ table: string; reason: string }>
  return new Map(raw.map((e) => [e.table.toLowerCase(), e.reason]))
}

const tables = collectTables()
const exceptions = loadExceptions()
const fail: string[] = []
const checked: string[] = []

for (const [name, cols] of [...tables].sort()) {
  if (!isReferenceTable(name, cols)) continue
  if (exceptions.has(name)) {
    console.log(`  − ${name} (예외: ${exceptions.get(name)})`)
    continue
  }
  const missing = REQUIRED.filter((r) => !cols.has(r))
  if (missing.length > 0) fail.push(`${name}: ${missing.join(', ')} 누락`)
  else checked.push(name)
}

console.log(`참조 데이터 테이블 ${checked.length}개 확인: ${checked.join(', ') || '(없음)'}`)

if (fail.length > 0) {
  console.error()
  console.error('── 스키마 규칙 위반 ────────────────────────────')
  for (const f of fail) console.error('  ✗ ' + f)
  console.error()
  console.error('  참조 데이터 테이블은 effective_from · effective_to · source 를 가져야 한다.')
  console.error('  만료를 데이터로 표현하지 못하면 무효가 된 값이 계속 계산에 들어가고,')
  console.error('  source 가 없으면 "고시로 확인한 값"과 "기억에서 넣은 값"이 구분되지 않는다.')
  console.error()
  console.error(`  의도적 예외라면 ${EXCEPTIONS.replace(root, '.')} 에 사유와 함께 등록할 것.`)
  process.exit(1)
}
console.log('스키마 규칙 통과')
