/**
 * Supabase 저장소 — RLS로 워크스페이스 격리 (§3, §6-6).
 * 모든 쿼리는 anon key + 사용자 JWT로 실행되며 서버 정책이 격리를 보장한다.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { FeeSettings, RateRow } from '../calc/types'
import { CONFIDENCE_THRESHOLD } from '../classify/types'
import type { ClassifyBatchResult } from '../classify/types'
import type { ParsedItemRow } from '../csv/parseItems'
import { DEFAULT_FEES } from '../seedRates'
import type { Item, ItemPatch, NewShipment, Repo, Shipment } from './types'

export function createSupabaseRepo(url: string, anonKey: string): Repo & { client: SupabaseClient } {
  const supabase = createClient(url, anonKey)
  let workspaceId: string | null = null

  async function getWorkspaceId(): Promise<string> {
    if (workspaceId) return workspaceId
    const { data, error } = await supabase.from('workspaces').select('id').limit(1).single()
    if (error) throw new Error(`워크스페이스 조회 실패: ${error.message}`)
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
      throwIf(error, '로그인 실패')
    },
    async signUp(email, password) {
      const { data, error } = await supabase.auth.signUp({ email, password })
      throwIf(error, '가입 실패')
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
      throwIf(error, '선적 목록 조회 실패')
      return (data ?? []) as Shipment[]
    },
    async getShipment(id) {
      const { data, error } = await supabase.from('shipments').select('*').eq('id', id).maybeSingle()
      throwIf(error, '선적 조회 실패')
      return (data as Shipment) ?? null
    },
    async createShipment(input: NewShipment) {
      const ws = await getWorkspaceId()
      const { data, error } = await supabase
        .from('shipments')
        .insert({ ...input, workspace_id: ws })
        .select()
        .single()
      throwIf(error, '선적 생성 실패')
      return data as Shipment
    },
    async updateShipment(id, patch) {
      const { error } = await supabase.from('shipments').update(patch).eq('id', id)
      throwIf(error, '선적 수정 실패')
    },
    async deleteShipment(id) {
      const { error } = await supabase.from('shipments').delete().eq('id', id)
      throwIf(error, '선적 삭제 실패')
    },

    async listItems(shipmentId) {
      const { data, error } = await supabase
        .from('items')
        .select('*, hts_candidates(rank, hts_code, confidence, rationale)')
        .eq('shipment_id', shipmentId)
        .order('created_at', { ascending: true })
      throwIf(error, 'SKU 조회 실패')
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
        throwIf(error, 'SKU 추가 실패')
      }
      return payload.length
    },
    async updateItem(id, patch: ItemPatch) {
      const { error } = await supabase.from('items').update(patch).eq('id', id)
      throwIf(error, 'SKU 수정 실패')
    },
    async deleteItem(id) {
      const { error } = await supabase.from('items').delete().eq('id', id)
      throwIf(error, 'SKU 삭제 실패')
    },

    async saveClassification(_shipmentId, batches: ClassifyBatchResult[]) {
      const ws = await getWorkspaceId()
      for (const batch of batches) {
        for (const r of batch.results) {
          if (r.candidates.length === 0) continue
          const top = r.candidates[0]
          const confident = top.confidence >= CONFIDENCE_THRESHOLD

          // 분류 이력 (§5: 모델·프롬프트 버전 포함)
          const { error: runErr } = await supabase.from('classification_runs').insert({
            item_id: r.item_id,
            workspace_id: ws,
            model: batch.meta.model,
            prompt_version: batch.meta.prompt_version,
            input: { item_id: r.item_id },
            raw_output: JSON.parse(JSON.stringify({ candidates: r.candidates })),
          })
          throwIf(runErr, '분류 이력 저장 실패')

          // 후보 교체
          const { error: delErr } = await supabase.from('hts_candidates').delete().eq('item_id', r.item_id)
          throwIf(delErr, '기존 후보 삭제 실패')
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
          throwIf(candErr, '후보 저장 실패')

          // 상태 전이 (§1-3: 저신뢰는 자동 확정 금지 → needs_review, 잠정값만 기록)
          const { error: updErr } = await supabase
            .from('items')
            .update({
              hts_final: top.hts_code,
              hts_source: 'llm',
              classification_status: confident ? 'auto_confirmed' : 'needs_review',
            })
            .eq('id', r.item_id)
          throwIf(updErr, '상태 갱신 실패')
        }
      }
    },

    async getRates(): Promise<RateRow[]> {
      const all: RateRow[] = []
      let from = 0
      const page = 1000
      for (;;) {
        const { data, error } = await supabase
          .from('rate_ledger')
          .select('hts_code, origin_country, layer, ad_valorem_rate, effective_from, effective_to')
          .range(from, from + page - 1)
        throwIf(error, 'rate 원장 조회 실패')
        const rows = (data ?? []).map((r) => ({ ...r, ad_valorem_rate: Number(r.ad_valorem_rate) })) as RateRow[]
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
      throwIf(error, 'fee 설정 조회 실패')
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
