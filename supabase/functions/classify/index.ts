/**
 * HTS 분류 Edge Function — 2단계 선택형 (스펙 §5, 파이프라인 v2).
 *
 * v1 대비 변경 (골든 v2 측정에서 드러난 문제에 대응):
 *   - 자유 생성 금지. 호 후보 → USITC 실제 라인 보기 중 선택. 보기 밖이면 재시도 1회
 *   - temperature 0
 *   - 정규화 해시로 분류 캐시 (동일 입력 재호출 금지)
 *   - auto_confirmed = k=3 만장일치 AND 원장 실존. confidence 는 참고 표기로 강등
 *
 * 배포: supabase functions deploy classify
 * 시크릿: supabase secrets set ANTHROPIC_API_KEY=... [CLASSIFY_MODEL=...]
 * 선행: supabase/migrations/0002_hts_lines.sql + npm run hts:seed
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  PROMPT_VERSION,
  TEMPERATURE,
  VOTES,
  cacheKey,
  decideStatus,
  extractJson,
  parseStageA,
  parseStageB,
  stageAUser,
  stageBUser,
  tallyVotes,
  STAGE_A_SYSTEM,
  STAGE_B_SYSTEM,
  type CatalogLine,
  type ClassifyInput,
  type Selection,
  type StageAResult,
} from './pipeline.ts'

const DEFAULT_MODEL = 'claude-haiku-4-5'
const MAX_ITEMS = 10

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const admin = () =>
  createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  })

async function callAnthropic(apiKey: string, model: string, system: string, user: string): Promise<unknown> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature: TEMPERATURE,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  })
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  const text: string = (data.content ?? [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text)
    .join('')
  return extractJson(text)
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set (supabase secrets set)')
    const model = Deno.env.get('CLASSIFY_MODEL') ?? DEFAULT_MODEL

    const body = (await req.json()) as { items: ClassifyInput[]; no_cache?: boolean }
    const items = body.items
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
      return new Response(JSON.stringify({ error: `items must be 1~${MAX_ITEMS}` }), {
        status: 400,
        headers: { ...corsHeaders, 'content-type': 'application/json' },
      })
    }
    const db = admin()

    // ── 캐시 조회 (요구사항 2) ─────────────────────────────────
    const keys = await Promise.all(items.map((i) => cacheKey(i, model)))
    const cached = new Map<string, unknown>()
    if (!body.no_cache) {
      const { data } = await db.from('classification_cache').select('cache_key, result').in('cache_key', keys)
      for (const row of data ?? []) cached.set(row.cache_key, row.result)
    }
    const todo = items.filter((_, i) => !cached.has(keys[i]))

    let results: unknown[] = []
    let stageAOut = new Map<string, StageAResult>()

    if (todo.length > 0) {
      // ── (a) 속성 + 4자리 호 후보 ─────────────────────────────
      stageAOut = parseStageA(await callAnthropic(apiKey, model, STAGE_A_SYSTEM, stageAUser(todo)))

      // ── 호에 해당하는 USITC 실제 라인 조회 ───────────────────
      const headings = [...new Set([...stageAOut.values()].flatMap((a) => a.headings))]
      const linesByHeading = new Map<string, CatalogLine[]>()
      if (headings.length > 0) {
        const { data, error } = await db
          .from('hts_lines')
          .select('code, heading, description')
          .in('heading', headings)
          .order('code')
        if (error) throw new Error(`hts_lines lookup failed: ${error.message} (run npm run hts:seed?)`)
        for (const l of (data ?? []) as CatalogLine[]) {
          if (!linesByHeading.has(l.heading)) linesByHeading.set(l.heading, [])
          linesByHeading.get(l.heading)!.push(l)
        }
      }
      const allowed = new Map<string, Set<string>>()
      for (const item of todo) {
        const set = new Set<string>()
        for (const h of stageAOut.get(item.id)?.headings ?? [])
          for (const l of linesByHeading.get(h) ?? []) set.add(l.code)
        allowed.set(item.id, set)
      }

      // ── (b) 보기 중 선택 × k=3 투표 ──────────────────────────
      const userB = stageBUser(todo, stageAOut, linesByHeading)
      const rounds = await Promise.all(
        Array.from({ length: VOTES }, async () => {
          let sel = parseStageB(await callAnthropic(apiKey, model, STAGE_B_SYSTEM, userB))
          // 보기 밖 코드가 하나라도 있으면 1회 재시도 (요구사항 1)
          const strays = todo.filter((i) => {
            const s = sel.get(i.id)
            return !s || !allowed.get(i.id)?.has(s.hts_code)
          })
          if (strays.length > 0) {
            const retryMsg = `${userB}\n\nYour previous answer used codes that were NOT in the option list for: ${strays
              .map((s) => s.id)
              .join(', ')}. Return ONLY codes copied exactly from each product's OPTIONS block.`
            const retry = parseStageB(await callAnthropic(apiKey, model, STAGE_B_SYSTEM, retryMsg))
            for (const s of strays) {
              const r = retry.get(s.id)
              if (r && allowed.get(s.id)?.has(r.hts_code)) sel.set(s.id, r)
            }
          }
          return sel
        }),
      )

      // ── 집계 + 원장 실존 확인 (요구사항 3) ───────────────────
      const consensusCodes = new Set<string>()
      const outcomes = todo.map((item) => {
        const perVote = rounds.map((sel) => {
          const s = sel.get(item.id)
          return { selection: s, valid: !!s && !!allowed.get(item.id)?.has(s.hts_code) }
        })
        const o = tallyVotes(item, stageAOut.get(item.id), perVote)
        if (o.consensus) consensusCodes.add(o.consensus)
        return o
      })

      const inLedger = new Set<string>()
      if (consensusCodes.size > 0) {
        const { data } = await db
          .from('rate_ledger')
          .select('hts_code')
          .eq('layer', 'base_mfn')
          .in('hts_code', [...consensusCodes])
        for (const r of data ?? []) inLedger.add(r.hts_code)
      }

      const fresh = outcomes.map((o) => {
        const { status, reason } = decideStatus(o, o.consensus ? inLedger.has(o.consensus) : false)
        // 후보 목록: 투표에서 나온 선택들을 중복 제거해 UI 에 그대로 노출
        const byCode = new Map<string, Selection>()
        for (const s of o.selections) if (!byCode.has(s.hts_code)) byCode.set(s.hts_code, s)
        return {
          item_id: o.item_id,
          candidates: [...byCode.values()].map((s) => ({
            hts_code: s.hts_code,
            confidence: s.confidence,
            rationale: s.rationale,
          })),
          attributes: o.attributes,
          headings: o.headings,
          consensus: {
            code: o.consensus,
            unanimous: o.unanimous,
            votes: o.votes,
            in_ledger: o.consensus ? inLedger.has(o.consensus) : false,
            out_of_options: o.out_of_options,
            status,
            reason,
          },
        }
      })

      // 캐시 적재
      const rows = fresh.map((f) => ({
        cache_key: keys[items.findIndex((i) => i.id === f.item_id)],
        model,
        prompt_version: PROMPT_VERSION,
        result: f,
      }))
      if (!body.no_cache && rows.length > 0) {
        await db.from('classification_cache').upsert(rows, { onConflict: 'cache_key' })
      }
      results = fresh
    }

    // 캐시 히트분 합치기 — 입력 순서 유지
    const byId = new Map<string, unknown>()
    for (const r of results) byId.set((r as { item_id: string }).item_id, r)
    items.forEach((item, i) => {
      if (cached.has(keys[i])) byId.set(item.id, { ...(cached.get(keys[i]) as object), item_id: item.id, cached: true })
    })
    const ordered = items.map((i) => byId.get(i.id) ?? { item_id: i.id, candidates: [], consensus: null })

    return new Response(
      JSON.stringify({
        results: ordered,
        meta: {
          model,
          prompt_version: PROMPT_VERSION,
          temperature: TEMPERATURE,
          votes: VOTES,
          cache_hits: cached.size,
        },
      }),
      { headers: { ...corsHeaders, 'content-type': 'application/json' } },
    )
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    })
  }
})
