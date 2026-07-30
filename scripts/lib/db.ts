/**
 * 적재 스크립트 공용 — 환경변수 접근과 **쓰기 검증**.
 *
 * ── 왜 생겼는가 ──────────────────────────────────────────────────
 * seed:rates 가 몇 세션 동안 조용히 실패하고 있었다. 이유가 둘이고 둘 다
 * 조용했다:
 *   1. 스크립트는 SUPABASE_URL 을 읽는데 .env 는 VITE_SUPABASE_URL 이었다
 *   2. 이름을 맞춰도 supabase-js 가 Node 20 에서 죽었다 (WebSocket 부재)
 * 그 결과 강제노동 301 이 원장에 한 번도 안 들어갔고, 프로덕션이 관세를
 * 과소계상하는 상태로 몇 세션을 갔다. "실행했다" 와 "들어갔다" 는 다르다.
 *
 * 그래서 두 가지를 강제한다:
 *   env()    필요한 변수가 없으면 **즉시** 실패한다 (이름 후보를 전부 시도)
 *   verify() 쓰기 전후 행수를 DB 에서 다시 읽어 델타를 확인한다.
 *            0건 삽입은 언제나 실패다
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

function dotenv(): Record<string, string> {
  const f = join(root, '.env')
  if (!existsSync(f)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(f, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
  return out
}

/**
 * 환경변수 하나를 읽는다. **이름 후보를 전부 시도하고, 없으면 즉시 실패한다.**
 *
 * 이름 불일치가 조용히 넘어가지 않게 하는 것이 목적이다 — SUPABASE_URL 과
 * VITE_SUPABASE_URL 을 오간 것이 이 저장소의 실제 사고 원인이었다.
 */
export function env(...names: string[]): string {
  const file = dotenv()
  for (const n of names) {
    const v = process.env[n] ?? file[n]
    if (v && v.trim()) return v.trim()
  }
  throw new Error(
    `환경변수가 없다: ${names.join(' 또는 ')}. ` +
      '.env 또는 셸에 설정할 것. 이름이 다르면 조용히 실패하지 않도록 여기서 멈춘다.',
  )
}

export const dbUrl = () => env('SUPABASE_URL', 'VITE_SUPABASE_URL')
export const serviceKey = () => env('SUPABASE_SERVICE_ROLE_KEY')

const headers = () => ({
  'Content-Type': 'application/json',
  apikey: serviceKey(),
  Authorization: `Bearer ${serviceKey()}`,
})

/** PostgREST 로 행수를 센다. supabase-js 는 Node 20 에서 죽으므로 쓰지 않는다. */
export async function countRows(table: string, filter = ''): Promise<number> {
  const q = `${dbUrl()}/rest/v1/${table}?select=*${filter ? `&${filter}` : ''}`
  const res = await fetch(q, { headers: { ...headers(), Prefer: 'count=exact', Range: '0-0' } })
  if (!res.ok) throw new Error(`count ${table} 실패: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const cr = res.headers.get('content-range') ?? ''
  const n = Number(cr.split('/')[1])
  if (!Number.isFinite(n)) throw new Error(`count ${table}: content-range 를 읽지 못했다 (${cr})`)
  return n
}

export interface WriteResult {
  before: number
  after: number
  inserted: number
}

/**
 * 쓰기를 감싸고 **DB 에서 다시 읽은 값**으로 결과를 보고한다.
 *
 * 요청 건수가 아니라 실측 델타를 쓴다 — 요청은 성공했는데 제약·정책으로 행이
 * 안 들어가는 경우가 있고, 그때 "N건 적재 완료" 라고 찍으면 거짓말이 된다.
 *
 * @param expectedDelta 기대 증가분. 넘기면 불일치 시 실패한다.
 *                      upsert 처럼 증가분이 유동적이면 생략하되, 0건은 항상 실패다.
 */
export async function verifiedWrite(
  label: string,
  table: string,
  write: () => Promise<void>,
  opts: { filter?: string; expectedDelta?: number; expectedDeltaAbsolute?: number } = {},
): Promise<WriteResult> {
  const before = await countRows(table, opts.filter)
  await write()
  const after = await countRows(table, opts.filter)
  const inserted = after - before

  if (inserted === 0 && opts.expectedDeltaAbsolute === undefined) {
    throw new Error(
      `${label}: 쓰기 후 행수가 그대로다 (${before}). 요청은 성공했는데 데이터가 안 들어갔다 — ` +
        '제약·정책·조용한 실패를 확인할 것.',
    )
  }
  // 지우고 다시 넣는 시드는 델타가 0 일 수 있다. 그때는 **최종 행수**를 본다.
  if (opts.expectedDeltaAbsolute !== undefined && after !== opts.expectedDeltaAbsolute) {
    throw new Error(
      `${label}: 최종 ${opts.expectedDeltaAbsolute}행이어야 하는데 실제 ${after}행 (${before} → ${after}).`,
    )
  }
  if (opts.expectedDelta !== undefined && inserted !== opts.expectedDelta) {
    throw new Error(
      `${label}: 기대 ${opts.expectedDelta}행이었는데 실제 ${inserted}행 증가 (${before} → ${after}).`,
    )
  }
  // 지우고 다시 넣는 시드는 델타가 0 일 수 있으므로 최종 행수를 보고한다
  const abs = opts.expectedDeltaAbsolute !== undefined
  console.log(
    `  ${label}: ${abs ? `${after}행 적재` : `${inserted}행 삽입`} (${before} → ${after}, DB 재조회 값)`,
  )
  return { before, after, inserted }
}

/**
 * ── 로더별 소유 범위 ─────────────────────────────────────────────
 *
 * 각 적재 스크립트가 **자기가 쓰고 지울 수 있는 program_code 집합**을 코드에
 * 고정한다. 데이터가 코드의 권한을 정하면 안 된다.
 *
 * 실제 사고: seed-rates 가 삭제 필터를 CSV 의 program_code 분포에서 만들었다.
 * CSV 에 mfn 표본 50행이 있었기 때문에 스크립트가 USITC 17,583행을 지울 권한을
 * 갖게 됐고, 실제로 지웠다. CSV 를 편집한 사람이 의도 없이 삭제 권한을 준 셈이다.
 */
export const OWNED: Record<string, readonly string[]> = {
  'seed:rates': ['301-forced-labor', '301-forced-labor-topup', '122', 'ieepa-trafficking'],
  'hts:seed': ['mfn'],
  'seed:301': ['301-china-list1', '301-china-list2', '301-china-list3', '301-china-list4a', '301-china-unverified'],
}

/** 쓰려는 행이 전부 소유 범위 안인가 — **쓰기 전에** 확인한다 */
export function assertOwned(loader: keyof typeof OWNED | string, rows: Array<{ program_code?: unknown }>): void {
  const owned = OWNED[loader]
  if (!owned) throw new Error(`알 수 없는 로더: ${loader}. scripts/lib/db.ts 의 OWNED 에 선언할 것.`)
  const seen = [...new Set(rows.map((r) => String(r.program_code ?? '')))]
  const stray = seen.filter((c) => !owned.includes(c))
  if (stray.length > 0) {
    throw new Error(
      `${loader}: 소유 범위 밖의 program_code 를 쓰려 한다 — ${stray.join(', ')}. ` +
        `허용: ${owned.join(', ')}. 데이터가 코드의 권한을 넓히지 못하게 여기서 멈춘다.`,
    )
  }
}

/**
 * 소유 범위 안의 행만 지운다. 삭제 예정 건수가 그 범위의 현재 행수를 넘으면 실패.
 *
 * 검증(verifiedWrite)은 사후 탐지였다 — 17,583행이 지워진 뒤에 알려줬다.
 * 이건 예방이다.
 */
export async function deleteOwned(loader: keyof typeof OWNED | string): Promise<number> {
  const owned = OWNED[loader]
  if (!owned) throw new Error(`알 수 없는 로더: ${loader}`)
  const filter = `program_code=in.(${owned.join(',')})`
  const before = await countRows('rate_ledger', filter)
  const total = await countRows('rate_ledger')
  if (before > total) throw new Error(`${loader}: 삭제 대상(${before})이 전체(${total})보다 많다 — 필터가 잘못됐다`)

  const res = await fetch(`${dbUrl()}/rest/v1/rate_ledger?${filter}`, {
    method: 'DELETE',
    headers: { apikey: serviceKey(), Authorization: `Bearer ${serviceKey()}` },
  })
  if (!res.ok) throw new Error(`${loader}: 삭제 실패 HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)

  const after = await countRows('rate_ledger')
  const removed = total - after
  if (removed > before) {
    throw new Error(`${loader}: 소유 범위(${before}행)보다 많은 ${removed}행이 지워졌다 — 즉시 확인할 것`)
  }
  return removed
}

/** 배치 insert (PostgREST). 500행씩 끊는다. */
export async function insertRows(table: string, rows: unknown[], prefer = 'return=minimal'): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const res = await fetch(`${dbUrl()}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...headers(), Prefer: prefer },
      body: JSON.stringify(rows.slice(i, i + 500)),
    })
    if (!res.ok) throw new Error(`insert ${table} @${i}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
  }
}
