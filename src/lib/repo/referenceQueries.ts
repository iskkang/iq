/**
 * 참조 데이터 조회 — 앱과 Edge Function 이 같은 코드를 부른다.
 */
import type { RateRow, FeeSettings } from '../calc/types.ts'
import type { DutyProgram, ProgramExclusion } from '../calc/programs.ts'
import { normalizeHts } from '../calc/rates.ts'

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

/** 앱의 배치 계산용 원장 전량 조회. */
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

/**
 * 공개 HTS 조회용 최소 원장 조회.
 *
 * 예전 /hts 는 한 번 검색할 때마다 27,000여 행을 전량 페이지네이션했다.
 * resolvePrograms 가 실제로 필요한 것은 조회된 HTS의 prefix 행과 '*' 전품목 행뿐이다.
 * 20개 검색 결과라도 후보 코드는 최대 약 160개라 응답 시간이 크게 줄어든다.
 */
export async function fetchRatesForHtsCodes(c: QueryClient, codes: string[]): Promise<RateRow[]> {
  const candidates = new Set<string>(['*'])
  for (const raw of codes) {
    const hts = normalizeHts(raw)
    if (!hts || hts === '*') continue
    // 원장은 4·6·8·10자리 중심이지만 재편된 중간 prefix도 안전하게 포함한다.
    for (let len = 4; len <= hts.length; len += 1) candidates.add(hts.slice(0, len))
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q: any = c.from('rate_ledger').select('*')
  const { data, error } = await q.in('hts_code', [...candidates])
  if (error) throw new Error(`Failed to load matching rate rows: ${error.message}`)
  return (data ?? []) as RateRow[]
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

/** 기준일을 덮는 수수료 행. `[effective_from, effective_to)` 반열림. */
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
