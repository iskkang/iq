/**
 * 공개 HTS 조회 (/hts) 데이터 접근.
 *
 * ── 왜 Edge Function 인가 ────────────────────────────────────────
 * 원장을 PostgREST 로 열면 경쟁자가 페이지네이션으로 9,929행을 그대로 받아간다.
 * 파는 것은 원문이 아니라 큐레이션된 판정(8자리 301 리스트, 4B 정지 처리,
 * 발효일 기반 무효 조항 제외)이다. 그래서 **판정 결과만** 돌려주고 원장 원본
 * 행은 응답에 담지 않는다.
 *
 * ── 계산은 재구현하지 않는다 ─────────────────────────────────────
 * resolvePrograms 를 앱과 **같은 파일에서** import 한다. 여기서 다시 구현하면
 * 두 벌이 되고, 골든 테스트가 재는 것은 앱 경로뿐이라 이쪽 오류를 못 잡는다 —
 * 재시도 프롬프트가 정확히 그렇게 배포본에서만 죽어 있었다.
 *
 * 배포: supabase functions deploy hts-lookup
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { resolvePrograms, exclusionStatus, unresolvedWarning } from '../../../src/lib/calc/programs.ts'
import type { DutyProgram, ProgramExclusion } from '../../../src/lib/calc/programs.ts'
import type { RateRow } from '../../../src/lib/calc/types.ts'
import { normalizeHts } from '../../../src/lib/calc/rates.ts'
import { fetchRates, fetchPrograms, fetchExclusions, fetchFeeRow } from '../../../src/lib/repo/referenceQueries.ts'

const MAX_RESULTS = 20
const RATE_LIMIT_PER_MIN = 30

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'content-type': 'application/json' } })

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
  try {
    const db = admin()

    // ── 레이트리밋 ────────────────────────────────────────────────
    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      req.headers.get('cf-connecting-ip') ??
      'unknown'
    const { data: allowed, error: rlErr } = await db.rpc('hts_lookup_allow', {
      p_ip: ip,
      p_limit: RATE_LIMIT_PER_MIN,
    })
    if (rlErr) throw new Error(`rate limit check failed: ${rlErr.message}`)
    if (allowed === false) {
      return json({ error: 'Too many requests — try again in a minute.' }, 429)
    }

    const body = (await req.json().catch(() => ({}))) as {
      q?: string
      origin?: string
      asOf?: string
    }
    const q = (body.q ?? '').trim()
    if (q.length < 2) return json({ error: 'q must be at least 2 characters' }, 400)
    const origin = (body.origin ?? '').trim().toUpperCase()
    const asOf = (body.asOf ?? new Date().toISOString().slice(0, 10)).trim()

    // ── 검색: 코드인가 키워드인가 ─────────────────────────────────
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
    if (lines.length === 0) return json({ as_of: asOf, query: q, results: [], truncated: false })

    // ── 참조 데이터: **앱과 같은 쿼리 함수**를 부른다 ────────────
    // 자체 필터를 짰다가 hts_code=* (전 품목 행) 이 빠져 강제노동 301 이
    // 통째로 누락됐다. 쿼리가 두 벌이면 한쪽만 고쳐진다.
    const [ledger, programs, exclusions, fee] = await Promise.all([
      fetchRates(db as never),
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
        : json(
            { error: `No fee data covers ${asOf}. Pick a date within the period we have rates for.`, kind: 'coverage' },
            400,
          )
    }

    // ── 판정 (앱과 같은 함수) ─────────────────────────────────────
    const byCode = new Map(programs.map((p) => [p.code, p]))
    const results = lines.map((l) => {
      const hts = normalizeHts(l.code)
      const { applied, total, unresolved } = resolvePrograms(ledger, programs, exclusions, hts, origin || 'XX', asOf)
      const mfn = applied.find((a) => a.program_code === 'mfn')

      const warnings: string[] = []
      // 미해결은 숫자를 만들지 않는다 — 0 으로 내려보내면 화면이 "관세 없음" 으로
      // 그린다. 앱 엔진과 같은 규칙이다 (SkuResult.duty_rate_total 이 null 인 것).
      // 문구는 앱과 **같은 함수**에서 나온다 (engine.unresolvedWarning).
      // 두 벌이면 한쪽만 고쳐지고 그 차이는 사용자에게만 보인다.
      for (const u of unresolved) warnings.push(unresolvedWarning(u))
      for (const a of applied) {
        if (a.exclusion === 'unverified') {
          warnings.push(
            `${a.authority} (${a.program_code}): an exclusion may apply but is unconfirmed — duty charged in full, confirm with your broker`,
          )
        }
      }
      if (!origin) warnings.push('Pick an origin country to see country-specific duties (Section 301 etc.).')

      return {
        code: l.code,
        description: l.description,
        leaf: l.leaf ?? null,
        base_mfn: mfn ? mfn.applied_rate : null,
        // **원장 원본 행은 담지 않는다.** 프로그램 단위 판정 결과만.
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
        // null = 미해결. 0 과 구분돼야 한다.
        duty_rate_total: unresolved.length > 0 ? null : total,
        unresolved: unresolved.map((u) => ({ program: u.program_code, rate_candidates: u.rate_candidates })),
        exclusion_status: origin
          ? applied.reduce<string>(
              (acc, a) => (a.exclusion !== 'none' ? a.exclusion : acc),
              exclusionStatus(exclusions, 'mfn', hts, asOf),
            )
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
      disclaimer:
        'Estimates only — not customs, legal, or tax advice. Final HTS classification and duty liability are the responsibility of the importer of record.',
    })
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})
