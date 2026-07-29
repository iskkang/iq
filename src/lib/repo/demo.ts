/**
 * DEMO 모드 저장소 — Supabase env 없이 전체 플로우 시연용. 인메모리(새로고침 시 초기화).
 * 분류는 mock, rate 원장은 동봉 시드 사용.
 */
import type { FeeSettings, RateRow } from '../calc/types'
import type { DutyProgram, ProgramExclusion } from '../calc/programs'
import { resolveStatus } from '../classify/status'
import type { ClassifyBatchResult } from '../classify/types'
import type { ParsedItemRow } from '../csv/parseItems'
import { DEFAULT_FEES, SEED_EXCLUSIONS, SEED_PROGRAMS, SEED_RATES } from '../seedRates'
import { SAMPLE_ITEMS, sampleShipment } from './sampleShipment'
import type { Item, ItemPatch, NewShipment, Repo, Shipment } from './types'

let seq = 0
const id = () => `demo-${++seq}`

export function createDemoRepo(): Repo {
  let email: string | null = null
  const listeners = new Set<() => void>()
  const shipments = new Map<string, Shipment>()
  const items = new Map<string, Item>()
  const notify = () => listeners.forEach((cb) => cb())

  return {
    mode: 'demo',

    async getUserEmail() {
      return email
    },
    async signIn(e) {
      email = e || 'demo@landediq.app'
      notify()
    },
    async signUp(e) {
      email = e || 'demo@landediq.app'
      notify()
      return { needsEmailConfirm: false }
    },
    async signOut() {
      email = null
      notify()
    },
    onAuthChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },

    async listShipments() {
      return [...shipments.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))
    },
    async getShipment(sid) {
      return shipments.get(sid) ?? null
    },
    async createShipment(input: NewShipment) {
      const s: Shipment = { ...input, id: id(), created_at: new Date().toISOString() }
      shipments.set(s.id, s)
      return s
    },
    async updateShipment(sid, patch) {
      const s = shipments.get(sid)
      if (s) shipments.set(sid, { ...s, ...patch })
    },
    async deleteShipment(sid) {
      shipments.delete(sid)
      for (const [k, v] of items) if (v.shipment_id === sid) items.delete(k)
    },

    async listItems(sid) {
      return [...items.values()].filter((i) => i.shipment_id === sid)
    },
    async addItems(sid, rows: ParsedItemRow[]) {
      for (const r of rows) {
        const manual = r.hts_code !== null
        const it: Item = {
          id: id(),
          shipment_id: sid,
          sku: r.sku,
          product_name: r.product_name,
          description_or_material: r.description_or_material,
          unit_cost_usd: r.unit_cost_usd,
          origin_country: r.origin_country,
          units_per_shipment: r.units_per_shipment,
          weight_kg_per_unit: r.weight_kg_per_unit,
          current_price_usd: r.current_price_usd,
          hts_final: r.hts_code,
          hts_source: manual ? 'manual' : null,
          classification_status: manual ? 'user_confirmed' : 'pending',
          candidates: [],
        }
        items.set(it.id, it)
      }
      return rows.length
    },
    async updateItem(iid, patch: ItemPatch) {
      const it = items.get(iid)
      if (it) items.set(iid, { ...it, ...patch })
    },
    async deleteItem(iid) {
      items.delete(iid)
    },

    async saveClassification(_sid, batches: ClassifyBatchResult[]) {
      for (const batch of batches) {
        for (const r of batch.results) {
          const it = items.get(r.item_id)
          if (!it || r.candidates.length === 0) continue
          // 판정은 consensus 가 한다 (k=3 만장일치 + 원장 실존). confidence 는 참고 표기.
          const status = resolveStatus(r)
          items.set(it.id, {
            ...it,
            candidates: r.candidates,
            hts_final: r.consensus?.code ?? r.candidates[0].hts_code, // 미확정이면 잠정값 (§5)
            hts_source: 'llm',
            classification_status: status,
            classification_consensus: r.consensus ?? null,
          })
        }
      }
    },

    async ensureSampleShipment(): Promise<Shipment | null> {
      if (shipments.size > 0) return null
      const s: Shipment = {
        ...sampleShipment(new Date().toISOString().slice(0, 10)),
        id: id(),
        created_at: new Date().toISOString(),
      }
      shipments.set(s.id, s)
      await this.addItems(s.id, SAMPLE_ITEMS)
      return s
    },

    async getRates(): Promise<RateRow[]> {
      return SEED_RATES
    },
    async getPrograms(): Promise<DutyProgram[]> {
      return SEED_PROGRAMS
    },
    async getExclusions(): Promise<ProgramExclusion[]> {
      return SEED_EXCLUSIONS
    },
    async getFees(): Promise<FeeSettings> {
      return DEFAULT_FEES
    },
  }
}
