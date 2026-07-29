import type { AllocationBasis, FeeSettings, RateRow, TransportMode } from '../calc/types'
import type { DutyProgram, ProgramExclusion } from '../calc/programs'
import type { ClassifyBatchResult, ClassifyConsensus, HtsCandidate } from '../classify/types'
import type { ParsedItemRow } from '../csv/parseItems'

export type { ClassificationStatus } from '../classify/status'
import type { ClassificationStatus } from '../classify/status'

export interface Shipment {
  id: string
  name: string
  freight_usd: number
  insurance_usd: number
  mode: TransportMode
  allocation_basis: AllocationBasis
  target_margin: number
  channel_fee_pct: number
  rate_as_of: string
  created_at: string
}

export type NewShipment = Omit<Shipment, 'id' | 'created_at'>

export interface Item {
  id: string
  shipment_id: string
  sku: string
  product_name: string
  description_or_material: string
  unit_cost_usd: number
  origin_country: string
  units_per_shipment: number
  weight_kg_per_unit: number | null
  current_price_usd: number | null
  hts_final: string | null
  hts_source: 'llm' | 'manual' | null
  classification_status: ClassificationStatus
  candidates: HtsCandidate[]
  /** k=3 투표 결과 (리뷰 큐 정렬 신호). 구 데이터는 null */
  classification_consensus?: ClassifyConsensus | null
  /** 교차검증 모델의 제안 — 리뷰 큐 정렬 ①번 신호. 자동확정에는 쓰지 않는다 */
  cross_check_code?: string | null
  cross_check_model?: string | null
}

export type ItemPatch = Partial<
  Pick<
    Item,
    | 'sku'
    | 'product_name'
    | 'description_or_material'
    | 'unit_cost_usd'
    | 'origin_country'
    | 'units_per_shipment'
    | 'weight_kg_per_unit'
    | 'current_price_usd'
    | 'hts_final'
    | 'hts_source'
    | 'classification_status'
  >
>

/**
 * 데이터 접근 인터페이스.
 * demo(인메모리) / supabase(실제, RLS로 워크스페이스 격리) 두 구현.
 */
export interface Repo {
  mode: 'demo' | 'supabase'

  getUserEmail(): Promise<string | null>
  signIn(email: string, password: string): Promise<void>
  signUp(email: string, password: string): Promise<{ needsEmailConfirm: boolean }>
  signOut(): Promise<void>
  onAuthChange(cb: () => void): () => void

  listShipments(): Promise<Shipment[]>
  getShipment(id: string): Promise<Shipment | null>
  createShipment(input: NewShipment): Promise<Shipment>
  updateShipment(id: string, patch: Partial<NewShipment>): Promise<void>
  deleteShipment(id: string): Promise<void>

  listItems(shipmentId: string): Promise<Item[]>
  addItems(shipmentId: string, rows: ParsedItemRow[]): Promise<number>
  updateItem(id: string, patch: ItemPatch): Promise<void>
  deleteItem(id: string): Promise<void>

  /** 분류 결과 저장: 후보 교체 + 이력 기록 + 상태 전이 (§5) */
  saveClassification(shipmentId: string, batches: ClassifyBatchResult[]): Promise<void>

  /**
   * 선적이 하나도 없으면 샘플 선적 1건을 만든다 (스펙 §MVP: 가입 즉시 데모 프로젝트).
   * 이미 있으면 아무것도 하지 않는다. 생성했으면 그 선적을 돌려준다.
   */
  ensureSampleShipment(): Promise<Shipment | null>
  getRates(): Promise<RateRow[]>
  /** 관세 프로그램 (발효일·적용범위·가산방식) */
  getPrograms(): Promise<DutyProgram[]>
  /** 프로그램별 면제 라인 */
  getExclusions(): Promise<ProgramExclusion[]>
  getFees(asOf: string): Promise<FeeSettings>
}
