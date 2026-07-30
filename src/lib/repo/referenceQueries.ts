/**
 * 참조 데이터 조회 — **앱과 Edge Function 이 같은 코드를 부른다.**
 *
 * /hts Edge Function 이 자체 쿼리를 짰다가 정확히 그 때문에 틀렸다:
 * 원장 필터에 `hts_code = '*'`(전 품목 행) 이 빠져 강제노동 301 이 통째로
 * 누락됐고, 백팩 CN 이 55.1% 대신 42.6% 로 나왔다 — **관세를 과소계상하는
 * 방향**이라 비대칭 원칙상 가장 나쁜 오류다.
 *
 * 쿼리가 두 벌이면 한쪽만 고쳐진다. 그래서 필터 모양을 여기 한 곳에 둔다.
 *
 * 클라이언트를 인자로 받는 이유: 앱은 anon+JWT, Edge 는 service_role 로 만든
 * 클라이언트를 쓴다. 권한은 호출부가 정하고 쿼리 모양만 공유한다.
 */
import type { RateRow } from '../calc/types.ts'
import type { DutyProgram, ProgramExclusion } from '../calc/programs.ts'
import type { FeeSettings } from '../calc/types.ts'

/** supabase-js 의 최소 형태만 요구한다 (Deno·브라우저 양쪽에서 동작) */
export interface QueryClient {
  from(table: string): {
    select: (
      cols: string,
      opts?: { count?: 'exact'; head?: boolean },
    ) => Record<string, unknown> & PromiseLike<{ data: unknown; error: { message: string } | null; count?: number | null }>
  }
}

const PAGE = 1000

/**
 * 원장 전량. 페이지네이션은 PostgREST 기본 상한(1000행) 때문에 필수다 —
 * 빼먹으면 27,000행 중 앞 1,000행만 보게 되고 그 사고는 조용하다.
 */
export async function fetchRates(c: QueryClient): Promise<RateRow[]> {
  const all: RateRow[] = []
  for (let from = 0; ; from += PAGE) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = c.from('rate_ledger').select('*')
    const { data, error } = await q.range(from, from + PAGE - 1)
    if (error) throw new Error(`Failed to load rate ledger: ${error.message}`)
    const rows = (data ?? []) as RateRow[]
    all.push(...rows)
    if (rows.length < PAGE) break
  }
  return all
}

export async function fetchPrograms(c: QueryClient): Promise<DutyProgram[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (c.from('duty_programs').select('*') as any)
  if (error) throw new Error(`Failed to load duty programs: ${error.message}`)
  return (data ?? []) as DutyProgram[]
}

export async function fetchExclusions(c: QueryClient): Promise<ProgramExclusion[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (c.from('program_exclusions').select('*') as any)
  if (error) throw new Error(`Failed to load program exclusions: ${error.message}`)
  return (data ?? []) as ProgramExclusion[]
}

/**
 * 기준일을 덮는 수수료 행. `[effective_from, effective_to)` 반열림 —
 * 원장·프로그램·면제와 같은 규칙이다.
 *
 * 0행일 때의 두 갈래 판정(config / coverage)은 호출부가 한다. 여기서는
 * 쿼리 모양만 공유한다.
 */
export async function fetchFeeRow(c: QueryClient, asOf: string): Promise<FeeSettings | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q: any = c.from('fee_settings').select('*')
  const { data, error } = await q
    .lte('effective_from', asOf)
    .or(`effective_to.is.null,effective_to.gt.${asOf}`)
    .order('effective_from', { ascending: false })
    .limit(1)
  if (error) throw new Error(`Failed to load fee settings: ${error.message}`)
  const rows = (data ?? []) as Array<Record<string, string | number>>
  if (rows.length === 0) return null
  const r = rows[0]
  return {
    mpf_rate: Number(r.mpf_rate),
    mpf_min_usd: Number(r.mpf_min_usd),
    mpf_max_usd: Number(r.mpf_max_usd),
    hmf_rate: Number(r.hmf_rate),
    effective_from: String(r.effective_from),
  }
}
