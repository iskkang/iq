/**
 * 공개 HTS 조회 (/hts) 데이터 접근.
 * 배포: supabase functions deploy hts-lookup
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { resolvePrograms, exclusionStatus, unresolvedWarning } from '../../../src/lib/calc/programs.ts'
import { normalizeHts } from '../../../src/lib/calc/rates.ts'
import { fetchRatesForHtsCodes, fetchPrograms, fetchExclusions, fetchFeeRow } from '../../../src/lib/repo/referenceQueries.ts'

const MAX_RESULTS = 20
const RATE_LIMIT_PER_MIN = 30

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
/**
 * 캐시는 **성공 응답만** 받는다. 기본값이 `public, max-age=300` 이었을 때는
 * 429·500·503 과 "결과 없음"까지 5분간 굳었다 — 레이트리밋에 걸린 사용자는
 * 창이 풀린 뒤에도 계속 429 를 받고, 시딩 중이라 잠깐 비었던 응답이 데이터가
 * 들어온 뒤에도 5분간 "결과 없음"으로 남는다. 실패를 캐시하면 복구가 안 보인다.
 */
const CACHE_OK = 'public, max-age=300'
const json = (b: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders },
  })

const admin = () =>
  createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  })

interface Line {
  code: string
  description: string
  leaf?: string | null
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const startedAt = performance.now()
  try {
    const db = admin()
    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      req.headers.get('cf-connecting-ip') ??
      'unknown'
    const { data: allowed, error: rlErr } = await db.rpc('hts_lookup_allow', {
      p_ip: ip,
      p_limit: RATE_LIMIT_PER_MIN,
    })
    if (rlErr) throw new Error(`rate limit check failed: ${rlErr.message}`)
    if (allowed === false) return json({ error: 'Too many requests — try again in a minute.' }, 429)

    const body = (await req.json().catch(() => ({}))) as { q?: string; origin?: string; asOf?: string }
    const q = (body.q ?? '').trim()
    if (q.length < 2) return json({ error: 'q must be at least 2 characters' }, 400)
    const origin = (body.origin ?? '').trim().toUpperCase()
    const asOf = (body.asOf ?? new Date().toISOString().slice(0, 10)).trim()
    const digits = q.replace(/\D/g, '')
    const isCode = digits.length >= 4 && /^[\d.\s]+$/.test(q)

    let lines: Line[] = []
    if (isCode) {
      const { data, error } = await db
        .from('hts_lines')
        .select('code, description, leaf')
        .like('code', `${digits}%`)
        .order('code')
        .limit(MAX_RESULTS)
      if (error) throw new Error(`hts_lines lookup failed: ${error.message}`)
      lines = (data ?? []) as Line[]
    } else {
      const { data, error } = await db
        .from('hts_lines')
        .select('code, description, leaf')
        .ilike('description', `%${q}%`)
        .order('code')
        .limit(MAX_RESULTS)
      if (error) throw new Error(`hts_lines search failed: ${error.message}`)
      lines = (data ?? []) as Line[]
    }

    if (lines.length === 0) {
      return json({ as_of: asOf, query: q, results: [], truncated: false, response_time_ms: Math.round(performance.now() - startedAt) })
    }

    // 핵심 성능 수정: 원장 27,000여 행 전량 대신 검색된 코드의 prefix와 '*' 행만 조회한다.
    const [ledger, programs, exclusions, fee] = await Promise.all([
      fetchRatesForHtsCodes(db as never, lines.map((line) => line.code)),
      fetchPrograms(db as never),
      fetchExclusions(db as never),
      fetchFeeRow(db as never, asOf),
    ])
    if (programs.length === 0 || ledger.length === 0) {
      return json({ error: 'Rate data is not available right now — please contact support@landediq.app.', kind: 'config' }, 503)
    }
    if (fee === null) {
      const { count } = await db.from('fee_settings').select('*', { count: 'exact', head: true })
      return (count ?? 0) === 0
        ? json({ error: 'Fee data is not available right now — please contact support@landediq.app.', kind: 'config' }, 503)
        : json({ error: `No fee data covers ${asOf}. Pick a date within the period we have rates for.`, kind: 'coverage' }, 400)
    }

    const byCode = new Map(programs.map((p) => [p.code, p]))
    const results = lines.map((l) => {
      const hts = normalizeHts(l.code)
      const { applied, total, unresolved } = resolvePrograms(ledger, programs, exclusions, hts, origin || 'XX', asOf)
      const mfn = applied.find((a) => a.program_code === 'mfn')
      const warnings: string[] = []
      for (const u of unresolved) warnings.push(unresolvedWarning(u))
      for (const a of applied) {
        if (a.exclusion === 'unverified') {
          warnings.push(`${a.authority} (${a.program_code}): an exclusion may apply but is unconfirmed — duty charged in full, confirm with your broker`)
        }
      }
      if (!origin) warnings.push('Pick an origin country to see country-specific duties (Section 301 etc.).')
      return {
        code: l.code,
        description: l.description,
        leaf: l.leaf ?? null,
        base_mfn: mfn ? mfn.applied_rate : null,
        programs: applied
          .filter((a) => a.applied_rate > 0 || a.exclusion !== 'none')
          .map((a) => ({
            code: a.program_code,
            name: byCode.get(a.program_code)?.name ?? a.program_code,
            authority: a.authority,
            rate: a.applied_rate,
            rate_type: a.rate_type,
            exclusion: a.exclusion,
          })),
        duty_rate_total: unresolved.length > 0 ? null : total,
        unresolved: unresolved.map((u) => ({ program: u.program_code, rate_candidates: u.rate_candidates })),
        exclusion_status: origin
          ? applied.reduce<string>((acc, a) => (a.exclusion !== 'none' ? a.exclusion : acc), exclusionStatus(exclusions, 'mfn', hts, asOf))
          : 'none',
        warnings,
      }
    })

    return json({
      as_of: asOf,
      origin: origin || null,
      query: q,
      results,
      truncated: results.length >= MAX_RESULTS,
      response_time_ms: Math.round(performance.now() - startedAt),
      disclaimer: 'Estimates only — not customs, legal, or tax advice. Final HTS classification and duty liability are the responsibility of the importer of record.',
    }, 200, { 'cache-control': CACHE_OK })
  } catch (e) {
    return json({ error: String(e), response_time_ms: Math.round(performance.now() - startedAt) }, 500)
  }
})
