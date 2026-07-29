/**
 * HTS 분류 Edge Function (스펙 §5).
 * 입력: { items: [{ id, product_name, description_or_material, origin_country }] } (≤10개)
 * 출력: { results: [{ item_id, candidates: [{hts_code(10자리), confidence, rationale}]×2~3 }],
 *         meta: { model, prompt_version }, raw_output }
 *
 * LLM은 후보 추정만 한다. 관세 계산은 전부 클라이언트의 결정론적 엔진 (§1-1).
 * 배포: supabase functions deploy classify
 * 시크릿: supabase secrets set ANTHROPIC_API_KEY=... [CLASSIFY_MODEL=...]
 */

const PROMPT_VERSION = 'v1'
const DEFAULT_MODEL = 'claude-haiku-4-5'
const MAX_ITEMS = 10

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SYSTEM_PROMPT = `You are a U.S. HTS (Harmonized Tariff Schedule) classification assistant for import cost estimation.
For each product, propose 2-3 candidate HTS codes at the 10-digit statistical level.

Rules:
- hts_code: exactly 10 digits, no dots.
- confidence: 0 to 1. Be honest — if the description is vague or could fall under multiple headings, use confidence below 0.7.
- rationale: ONE short sentence citing the material/use that drives the classification.
- These are estimates for cost planning only, not legal rulings.

Respond with ONLY valid JSON, no markdown fences, in this exact shape:
{"results":[{"item_id":"...","candidates":[{"hts_code":"1234567890","confidence":0.85,"rationale":"..."}]}]}`

interface InItem {
  id: string
  product_name: string
  description_or_material: string
  origin_country: string
}

function extractJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end < 0) throw new Error('no JSON object in model output')
  return JSON.parse(cleaned.slice(start, end + 1))
}

async function callAnthropic(apiKey: string, model: string, items: InItem[]): Promise<{ parsed: unknown; raw: unknown }> {
  const userMsg = `Classify these products:\n${JSON.stringify(
    items.map((i) => ({
      item_id: i.id,
      product_name: i.product_name,
      description_or_material: i.description_or_material,
      origin_country: i.origin_country,
    })),
    null,
    2,
  )}`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  const text: string = (data.content ?? [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text)
    .join('')
  return { parsed: extractJson(text), raw: data }
}

function sanitize(parsed: unknown, items: InItem[]) {
  const byId = new Map<string, { hts_code: string; confidence: number; rationale: string }[]>()
  const resultsRaw = (parsed as { results?: unknown[] })?.results ?? []
  for (const r of resultsRaw as Array<Record<string, unknown>>) {
    const id = String(r.item_id ?? '')
    const cands = Array.isArray(r.candidates) ? r.candidates : []
    const clean = cands
      .map((c) => {
        const rec = c as Record<string, unknown>
        return {
          hts_code: String(rec.hts_code ?? '').replace(/\D/g, ''),
          confidence: Math.min(Math.max(Number(rec.confidence) || 0, 0), 1),
          rationale: String(rec.rationale ?? '').slice(0, 300),
        }
      })
      .filter((c) => c.hts_code.length === 10)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3)
    if (id && clean.length > 0) byId.set(id, clean)
  }
  return items.map((i) => ({ item_id: i.id, candidates: byId.get(i.id) ?? [] }))
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set (supabase secrets set)')
    const model = Deno.env.get('CLASSIFY_MODEL') ?? DEFAULT_MODEL

    const { items } = (await req.json()) as { items: InItem[] }
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
      return new Response(JSON.stringify({ error: `items must be 1~${MAX_ITEMS}` }), {
        status: 400,
        headers: { ...corsHeaders, 'content-type': 'application/json' },
      })
    }

    // 파싱 실패 시 1회 재시도 (스펙 §5 JSON 출력 강제)
    let parsed: unknown
    let raw: unknown
    try {
      ;({ parsed, raw } = await callAnthropic(apiKey, model, items))
    } catch (e) {
      if (e instanceof SyntaxError || String(e).includes('no JSON')) {
        ;({ parsed, raw } = await callAnthropic(apiKey, model, items))
      } else throw e
    }

    return new Response(
      JSON.stringify({
        results: sanitize(parsed, items),
        meta: { model, prompt_version: PROMPT_VERSION },
        raw_output: raw,
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
