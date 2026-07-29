/**
 * HTS 분류 Edge Function — 2단계 선택형 (스펙 §5, 파이프라인 v2).
 *
 * v1 대비 변경 (골든 v2 측정에서 드러난 문제에 대응):
 *   - 자유 생성 금지. 호 후보 → USITC 실제 라인 보기 중 선택. 보기 밖이면 재시도 1회
 *   - temperature 0
 *   - 정규화 해시로 분류 캐시 (동일 입력 재호출 금지)
 *   - 자동확정 없음 — 사람 확인 전에는 전부 suggested. 투표 결과는 리뷰 큐 정렬 신호
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
  assessSuggestion,
  extractJson,
  parseStageA,
  parseStageB,
  stageAUser,
  stageBPrompt,
  stageBRetryPrompt,
  tallyVotes,
  STAGE_A_SYSTEM,
  STAGE_B_SYSTEM,
  type CatalogLine,
  type ClassifyInput,
  type Selection,
  type StageAResult,
} from './pipeline.ts'

// sonnet 고정 — haiku 는 이 제품에서 못 쓴다(파이프라인 v1 측정 5.2/10). 비용은 캐시로 방어한다
const DEFAULT_MODEL = 'claude-sonnet-4-6'
const MAX_ITEMS = 10
const ALLOWED_MODELS = new Set(['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-5'])

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const admin = () =>
  createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  })

type UserBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }

/**
 * `cached` 로 넘긴 앞부분에 cache_control 을 건다 (프롬프트 캐시 프리픽스).
 * stage-B 의 보기 카탈로그가 여기 들어가면, 같은 호를 쓰는 다음 배치는
 * 그 구간을 캐시에서 읽는다 (입력가 0.1배).
 */
async function callAnthropic(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  cached?: string,
): Promise<unknown> {
  const content: UserBlock[] = cached
    ? [
        { type: 'text', text: cached, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: user },
      ]
    : [{ type: 'text', text: user }]
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature: TEMPERATURE,
      system,
      messages: [{ role: 'user', content }],
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

type Db = ReturnType<typeof admin>
type ClassifyCandidate = { hts_code: string; confidence: number; rationale: string }
type ClassifyResult = { item_id: string; candidates: ClassifyCandidate[]; consensus?: unknown }

/**
 * 분류 본체 — HTTP 모드와 워커(task) 모드가 **같은 코드**를 쓴다.
 *
 * 두 벌이 되면 배포본과 측정 대상이 갈라진다. 실제로 재시도 프롬프트에서 겪었다:
 * Edge 쪽만 정의되지 않은 변수를 참조해 재시도 경로가 죽어 있었는데, 골든 러너는
 * 자기 사본을 쓰느라 그 버그를 못 잡았다.
 */
async function classifyBatch(
  db: Db,
  apiKey: string,
  model: string,
  items: ClassifyInput[],
  noCache: boolean,
): Promise<{ ordered: ClassifyResult[]; cacheHits: number }> {

    // ── 캐시 조회 (요구사항 2) ─────────────────────────────────
    const keys = await Promise.all(items.map((i) => cacheKey(i, model)))
    const cached = new Map<string, unknown>()
    if (!noCache) {
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
      const { catalog, questions } = stageBPrompt(todo, stageAOut, linesByHeading)
      const rounds = await Promise.all(
        Array.from({ length: VOTES }, async () => {
          const sel = parseStageB(await callAnthropic(apiKey, model, STAGE_B_SYSTEM, questions, catalog))
          // 보기 밖 코드가 하나라도 있으면 1회 재시도 (요구사항 1)
          const strays = todo.filter((i) => {
            const s = sel.get(i.id)
            return !s || !allowed.get(i.id)?.has(s.hts_code)
          })
          if (strays.length > 0) {
            const retry = parseStageB(
              await callAnthropic(apiKey, model, STAGE_B_SYSTEM, stageBRetryPrompt(questions, strays.map((s) => s.id)), catalog),
            )
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
        const { reason } = assessSuggestion(o, o.consensus ? inLedger.has(o.consensus) : false)
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
      if (!noCache && rows.length > 0) {
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
    const ordered = items.map(
      (i) => (byId.get(i.id) as ClassifyResult | undefined) ?? { item_id: i.id, candidates: [], consensus: null },
    )
  return { ordered, cacheHits: cached.size }
}

const META = () => ({ prompt_version: PROMPT_VERSION, temperature: TEMPERATURE, votes: VOTES })

/**
 * 워커 모드 — pg_cron 이 디스패치한 태스크 1건을 처리한다.
 *
 * HTTP 모드와 달리 **응답을 기다리는 사람이 없다.** 결과를 DB 에 직접 쓰고
 * complete_classification_task 로 진행률을 보고해야 한다. 실패해도 반드시
 * 보고한다 — 안 하면 태스크가 running 으로 남아 5분 뒤 좀비 회수될 때까지
 * 슬롯을 잡아먹는다.
 */
async function runTask(db: Db, apiKey: string, taskId: string): Promise<Response> {
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, 'content-type': 'application/json' } })
  try {
    const { data: task, error: tErr } = await db
      .from('classification_tasks')
      .select('id, job_id, workspace_id, item_ids')
      .eq('id', taskId)
      .single()
    if (tErr || !task) throw new Error(`task not found: ${taskId} ${tErr?.message ?? ''}`)

    const { data: rows, error: iErr } = await db
      .from('items')
      .select('id, product_name, description_or_material, origin_country, unit_cost_usd')
      .in('id', task.item_ids)
    if (iErr) throw new Error(`items lookup failed: ${iErr.message}`)

    const { data: job } = await db.from('classification_jobs').select('model').eq('id', task.job_id).single()
    const model = (job?.model as string | null) ?? Deno.env.get('CLASSIFY_MODEL') ?? DEFAULT_MODEL

    const items: ClassifyInput[] = (rows ?? []).map((r) => ({
      id: r.id,
      product_name: r.product_name,
      description_or_material: r.description_or_material,
      origin_country: r.origin_country,
      unit_cost_usd: r.unit_cost_usd,
    }))
    if (items.length === 0) {
      await db.rpc('complete_classification_task', { p_task_id: taskId, p_ok: true, p_error: null })
      return json({ ok: true, items: 0 })
    }

    // 워커는 캐시를 반드시 쓴다 — 같은 상품 설명이 재분류로 돈을 두 번 쓰지 않도록
    const { ordered } = await classifyBatch(db, apiKey, model, items, false)

    for (const r of ordered) {
      if (r.candidates.length === 0) continue
      await db.from('classification_runs').insert({
        item_id: r.item_id,
        workspace_id: task.workspace_id,
        model,
        prompt_version: PROMPT_VERSION,
        input: { item_id: r.item_id },
        raw_output: r,
      })
      await db.from('hts_candidates').delete().eq('item_id', r.item_id)
      await db.from('hts_candidates').insert(
        r.candidates.map((c, rank) => ({
          item_id: r.item_id,
          workspace_id: task.workspace_id,
          rank,
          hts_code: c.hts_code,
          confidence: c.confidence,
          rationale: c.rationale,
        })),
      )
      // 자동확정은 없다 (§1-3) — 사람이 확인하기 전까지 전부 suggested
      const consensus = r.consensus as { code?: string | null } | null
      await db
        .from('items')
        .update({
          hts_final: consensus?.code ?? r.candidates[0].hts_code,
          hts_source: 'llm',
          classification_status: 'suggested',
          classification_consensus: r.consensus ?? null,
        })
        .eq('id', r.item_id)
    }

    await db.rpc('complete_classification_task', { p_task_id: taskId, p_ok: true, p_error: null })
    return json({ ok: true, items: ordered.length, model })
  } catch (e) {
    // 실패도 반드시 보고한다. 재시도 한도(3회)는 DB 함수가 판단한다.
    await db.rpc('complete_classification_task', {
      p_task_id: taskId,
      p_ok: false,
      p_error: String(e).slice(0, 500),
    })
    return json({ ok: false, error: String(e) }, 200)
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, 'content-type': 'application/json' } })
  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set (supabase secrets set)')
    const body = (await req.json()) as {
      items?: ClassifyInput[]
      no_cache?: boolean
      model?: string
      task_id?: string
    }
    const db = admin()

    // ── 워커 모드 (pg_cron → net.http_post) ────────────────────
    if (body.task_id) return await runTask(db, apiKey, body.task_id)

    // ── HTTP 모드 (앱이 직접 호출, 결과를 응답으로 받음) ────────
    // 요청이 모델을 지정할 수 있게 하되 허용 목록으로 제한한다 (임의 모델 = 비용 통제 상실).
    const model =
      body.model && ALLOWED_MODELS.has(body.model)
        ? body.model
        : (Deno.env.get('CLASSIFY_MODEL') ?? DEFAULT_MODEL)
    const items = body.items
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
      return json({ error: `items must be 1~${MAX_ITEMS}` }, 400)
    }

    const { ordered, cacheHits } = await classifyBatch(db, apiKey, model, items, body.no_cache === true)
    return json({ results: ordered, meta: { model, ...META(), cache_hits: cacheHits } })
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})