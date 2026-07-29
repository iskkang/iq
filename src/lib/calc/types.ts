/**
 * §4 관세 계산 도메인 타입.
 * 계산은 전부 결정론적 코드 (스펙 §1-1). LLM은 여기 관여하지 않는다.
 */

export type TransportMode = 'ocean' | 'air'
export type AllocationBasis = 'value' | 'weight'

import type { AppliedProgram } from './programs'

/**
 * @deprecated `program_code` 를 쓸 것 (duty_programs 테이블).
 *
 * 레이어를 enum 으로 박아두면 프로그램이 생기고 죽을 때마다 마이그레이션이 필요하다.
 * 2026년 5개월에 체계가 세 번 바뀌었고, IEEPA 는 무효화됐는데도 공식 관세표에
 * 조항이 남아 있었다. 발효일과 적용범위는 데이터에 있어야 한다.
 */
export type RateLayer = 'base_mfn' | 'section301' | 'ieepa_reciprocal'
export const RATE_LAYERS: RateLayer[] = ['base_mfn', 'section301', 'ieepa_reciprocal']

export const LAYER_LABEL: Record<RateLayer, string> = {
  base_mfn: 'MFN',
  section301: '301',
  ieepa_reciprocal: 'IEEPA',
}

/**
 * rate 원장 행 (스펙 §1-4: 하드코딩 금지, 발효일 기반 원장).
 * hts_code: 숫자만. 6/8/10자리 프리픽스 매칭, '*' 는 전 품목(국가 단위 레이어용).
 * origin_country: ISO2. null = 모든 원산지.
 */
export interface RateRow {
  /**
   * 프로그램 코드 (duty_programs.code). 'mfn' | '301-china-legacy' | '301-forced-labor' | ...
   * 구 데이터는 layer 로부터 승격된다 (마이그레이션 0004).
   */
  program_code?: string | null
  hts_code: string
  origin_country: string | null
  layer: RateLayer
  /** ad valorem 소수 (6.5% → 0.065). MVP는 종가세만 지원. */
  ad_valorem_rate: number
  /** ISO date (YYYY-MM-DD) */
  effective_from: string
  /** null = 현재 유효 */
  effective_to: string | null
  source?: string | null
  note?: string | null
}

/** MPF·HMF 설정 (스펙 §4: min/max는 연도별 조정되는 설정값). */
export interface FeeSettings {
  /** 0.3464% → 0.003464 */
  mpf_rate: number
  mpf_min_usd: number
  mpf_max_usd: number
  /** 0.125% → 0.00125 */
  hmf_rate: number
  effective_from: string
}

/** 계산 입력 SKU 한 줄 (CSV 컬럼 스펙 §2 + 선택 컬럼). */
export interface CalcItem {
  sku: string
  unit_cost_usd: number
  origin_country: string
  units_per_shipment: number
  /** 단위당 중량(kg). 배부 기준 weight일 때만 사용, 없으면 가액 배부로 폴백. */
  weight_kg_per_unit?: number | null
  current_price_usd?: number | null
  /** 확정(또는 잠정) HTS 10자리. null이면 duty 0 + 경고. */
  hts_code?: string | null
  /** 리포트 잠정 표시용 */
  provisional?: boolean
}

export interface CalcShipment {
  freight_usd: number
  insurance_usd: number
  mode: TransportMode
  allocation_basis: AllocationBasis
  /** 0.30 = 30% */
  target_margin: number
  /** 0.15 = 15% */
  channel_fee_pct: number
  /** rate 원장 조회 기준일 (ISO date) — 리포트에 반드시 표기 (스펙 §4). */
  rate_as_of: string
}

/** @deprecated 레이어 개념은 프로그램으로 대체됐다. lookupLayerRate 반환형으로만 남는다 */
export interface DutyLayerDetail {
  layer: RateLayer
  rate: number
  /** 매칭된 원장 행의 hts_code ('*' 포함). null = 원장에 없음 → 0 적용 */
  matched_hts: string | null
}

export interface SkuResult {
  sku: string
  hts_code: string | null
  provisional: boolean
  unit_cost: number
  units: number
  /** 적용된 프로그램과 실제 가산율 (발효일·적용범위·상한보정 근거) */
  applied_programs: AppliedProgram[]
  duty_rate_total: number
  /** 단위당 USD */
  duty_usd: number
  freight_per_unit: number
  mpf_per_unit: number
  hmf_per_unit: number
  /** mpf + hmf */
  fees_per_unit: number
  landed_cost: number
  current_price: number | null
  /** null = current_price 없음 */
  true_margin: number | null
  /** null = 분모 ≤ 0 (target+fee ≥ 100%) */
  recommended_price: number | null
  warnings: string[]
}

export interface ShipmentTotals {
  total_value: number
  total_weight: number | null
  freight_pool: number
  mpf_shipment: number
  hmf_shipment: number
  allocation_basis_used: AllocationBasis
}

export interface ShipmentResult {
  items: SkuResult[]
  totals: ShipmentTotals
  rate_as_of: string
  warnings: string[]
}
