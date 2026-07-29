/**
 * Supabase 저장소 — RLS로 워크스페이스 격리 (§3, §6-6).
 * 모든 쿼리는 anon key + 사용자 JWT로 실행되며 서버 정책이 격리를 보장한다.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { FeeSettings, RateRow } from '../calc/types'
import type { DutyProgram, ProgramExclusion } from '../calc/programs'
import { resolveStatus } from '../classify/status'
import type { ClassifyBatchResult } from '../classify/types'
import type { ParsedItemRow } from '../csv/parseItems'
import { DEFAULT_FEES } from '../seedRates'
import { SAMPLE_ITEMS, sampleShipment } from './sampleShipment'
import type { ClassificationProgress, Item, ItemPatch, NewShipment, Repo, Shipment } from './types'

export function createSupabaseRepo(url: string, anonKey: string): Repo & { client: SupabaseClient } {
  const supabase = createClient(url, anonKey)
  let workspaceId: string | null = null

  async function getWorkspaceId(): Promise<string> {
    if (workspaceId) return workspaceId
    const { data, error } = await supabase.from('workspaces').select('id').limit(1).single()
    if (error) throw new Error(`Failed to load workspace: ${error.message}`)
    workspaceId = data.id
    return data.id
  }

  const throwIf = (error: { message: string } | null, ctx: string) => {
    if (error) throw new Error(`${ctx}: ${error.message}`)
  }

  return {
    mode: 'supabase',
    client: supabase,

    async getUserEmail() {
      const { data } = await supabase.auth.getSession()
      return data.session?.user.email ?? null
    },
    async signIn(email, password) {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      throwIf(error, 'Sign-in failed')
    },
    async signUp(email, password) {
      const { data, error } = await supabase.auth.signUp({ email, password })
      throwIf(error, 'Sign-up failed')
      return { needsEmailConfirm: !data.session }
    },
    async signOut() {
      workspaceId = null
      await supabase.auth.signOut()
    },
    onAuthChange(cb) {
      const { data } = supabase.auth.onAuthStateChange(() => cb())
      return () => data.subscription.unsubscribe()
    },

    async listShipments() {
      const { data, error } = await supabase
        .from('shipments')
        .select('*')
        .order('created_at', { ascending: false })
      throwIf(error, 'Failed to list shipments')
      return (data ?? []) as Shipment[]
    },
    async getShipment(id) {
      const { data, error } = await supabase.from('shipments').select('*').eq('id', id).maybeSingle()
      throwIf(error, 'Failed to load shipment')
      return (data as Shipment) ?? null
    },
    async createShipment(input: NewShipment) {
      const ws = await getWorkspaceId()
      const { data, error } = await supabase
        .from('shipments')
        .insert({ ...input, workspace_id: ws })
        .select()
        .single()
      throwIf(error, 'Failed to create shipment')
      return data as Shipment
    },
    async updateShipment(id, patch) {
      const { error } = await supabase.from('shipments').update(patch).eq('id', id)
      throwIf(error, 'Failed to update shipment')
    },
    async deleteShipment(id) {
      const { error } = await supabase.from('shipments').delete().eq('id', id)
      throwIf(error, 'Failed to delete shipment')
    },

    async listItems(shipmentId) {
      const { data, error } = await supabase
        .from('items')
        .select('*, hts_candidates(rank, hts_code, confidence, rationale)')
        .eq('shipment_id', shipmentId)
        .order('created_at', { ascending: true })
      throwIf(error, 'Failed to load SKUs')
      return (data ?? []).map((row) => {
        const { hts_candidates, ...rest } = row as Item & {
          hts_candidates: Array<{ rank: number; hts_code: string; confidence: number; rationale: string }>
        }
        return {
          ...rest,
          candidates: (hts_candidates ?? [])
            .sort((a, b) => a.rank - b.rank)
            .map((c) => ({ hts_code: c.hts_code, confidence: Number(c.confidence), rationale: c.rationale })),
        } as Item
      })
    },
    async addItems(shipmentId, rows: ParsedItemRow[]) {
      const ws = await getWorkspaceId()
      const payload = rows.map((r) => ({
        shipment_id: shipmentId,
        workspace_id: ws,
        sku: r.sku,
        product_name: r.product_name,
        description_or_material: r.description_or_material,
        unit_cost_usd: r.unit_cost_usd,
        origin_country: r.origin_country,
        units_per_shipment: r.units_per_shipment,
        weight_kg_per_unit: r.weight_kg_per_unit,
        current_price_usd: r.current_price_usd,
        hts_final: r.hts_code,
        hts_source: r.hts_code ? ('manual' as const) : null,
        classification_status: r.hts_code ? ('user_confirmed' as const) : ('pending' as const),
      }))
      for (let i = 0; i < payload.length; i += 500) {
        const { error } = await supabase.from('items').insert(payload.slice(i, i + 500))
        throwIf(error, 'Failed to add SKUs')
      }
      return payload.length
    },
    async updateItem(id, patch: ItemPatch) {
      const { error } = await supabase.from('items').update(patch).eq('id', id)
      throwIf(error, 'Failed to update SKU')
    },
    async deleteItem(id) {
      const { error } = await supabase.from('items').delete().eq('id', id)
      throwIf(error, 'Failed to delete SKU')
    },

    async saveClassification(_shipmentId, batches: ClassifyBatchResult[]) {
      const ws = await getWorkspaceId()
      for (const batch of batches) {
        for (const r of batch.results) {
          if (r.candidates.length === 0) continue
          const status = resolveStatus(r)

          // 분류 이력 (§5: 모델·프롬프트 버전 포함 — 클레임 대응용)
          const { error: runErr } = await supabase.from('classification_runs').insert({
            item_id: r.item_id,
            workspace_id: ws,
            model: batch.meta.model,
            prompt_version: batch.meta.prompt_version,
            input: { item_id: r.item_id },
            raw_output: JSON.parse(
              JSON.stringify({
                candidates: r.candidates,
                attributes: r.attributes ?? null,
                headings: r.headings ?? [],
                consensus: r.consensus ?? null,
                cached: r.cached ?? false,
              }),
            ),
          })
          throwIf(runErr, 'Failed to save classification run')

          // 후보 교체
          const { error: delErr } = await supabase.from('hts_candidates').delete().eq('item_id', r.item_id)
          throwIf(delErr, 'Failed to clear previous candidates')
          const { error: candErr } = await supabase.from('hts_candidates').insert(
            r.candidates.map((c, rank) => ({
              item_id: r.item_id,
              workspace_id: ws,
              rank,
              hts_code: c.hts_code,
              confidence: c.confidence,
              rationale: c.rationale,
            })),
          )
          throwIf(candErr, 'Failed to save candidates')

          // 상태 전이 (§1-3: 자동 확정은 k=3 만장일치 + 원장 실존일 때만)
          const { error: updErr } = await supabase
            .from('items')
            .update({
              hts_final: r.consensus?.code ?? r.candidates[0].hts_code,
              hts_source: 'llm',
              classification_status: status,
              classification_consensus: r.consensus ?? null,
            })
            .eq('id', r.item_id)
          throwIf(updErr, 'Failed to update item status')
        }
      }
    },

    async enqueueClassification(shipmentId: string): Promise<string | null> {
      const { data, error } = await supabase.rpc('enqueue_classification', { p_shipment_id: shipmentId })
      throwIf(error, 'Failed to queue classification')
      return (data as string | null) ?? null
    },

    async classificationProgress(jobId: string): Promise<ClassificationProgress | null> {
      const { data, error } = await supabase
        .from('classification_jobs')
        .select('status, done_tasks, failed_tasks, total_tasks')
        .eq('id', jobId)
        .maybeSingle()
      throwIf(error, 'Failed to read job progress')
      if (!data) return null
      return {
        status: data.status as ClassificationProgress['status'],
        done: data.done_tasks as number,
        failed: data.failed_tasks as number,
        total: data.total_tasks as number,
      }
    },

    async ensureSampleShipment(): Promise<Shipment | null> {
      const { data, error } = await supabase.from('shipments').select('id').limit(1)
      throwIf(error, 'Failed to check shipments')
      if ((data ?? []).length > 0) return null
      const ws = await getWorkspaceId()
      const { data: created, error: insErr } = await supabase
        .from('shipments')
        .insert({ ...sampleShipment(new Date().toISOString().slice(0, 10)), workspace_id: ws })
        .select()
        .single()
      throwIf(insErr, 'Failed to create sample shipment')
      const s = created as Shipment
      await this.addItems(s.id, SAMPLE_ITEMS)
      return s
    },

    async getRates(): Promise<RateRow[]> {
      const all: RateRow[] = []
      let from = 0
      const page = 1000
      for (;;) {
        const { data, error } = await supabase
          .from('rate_ledger')
          .select('program_code, hts_code, origin_country, layer, ad_valorem_rate, effective_from, effective_to')
          .range(from, from + page - 1)
        throwIf(error, 'Failed to load rate ledger')
        const rows = (data ?? []).map((r) => ({ ...r, ad_valorem_rate: Number(r.ad_valorem_rate) })) as RateRow[]
        all.push(...rows)
        if (rows.length < page) break
        from += page
      }
      return all
    },
    async getPrograms(): Promise<DutyProgram[]> {
      const { data, error } = await supabase
        .from('duty_programs')
        .select('code, name, authority, rate_type, scope_type, effective_from, effective_to, source, note')
      throwIf(error, 'Failed to load duty programs')
      return (data ?? []) as DutyProgram[]
    },
    async getExclusions(): Promise<ProgramExclusion[]> {
      const all: ProgramExclusion[] = []
      let from = 0
      const page = 1000
      for (;;) {
        const { data, error } = await supabase
          .from('program_exclusions')
          .select('program_code, hts_code')
          .range(from, from + page - 1)
        throwIf(error, 'Failed to load program exclusions')
        const rows = (data ?? []) as ProgramExclusion[]
        all.push(...rows)
        if (rows.length < page) break
        from += page
      }
      return all
    },
    async getFees(asOf: string): Promise<FeeSettings> {
      const { data, error } = await supabase
        .from('fee_settings')
        .select('*')
        .lte('effective_from', asOf)
        .order('effective_from', { ascending: false })
        .limit(1)
        .maybeSingle()
      throwIf(error, 'Failed to load fee settings')
      if (!data) return DEFAULT_FEES
      return {
        mpf_rate: Number(data.mpf_rate),
        mpf_min_usd: Number(data.mpf_min_usd),
        mpf_max_usd: Number(data.mpf_max_usd),
        hmf_rate: Number(data.hmf_rate),
        effective_from: data.effective_from,
      }
    },
  }
}
