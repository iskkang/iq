/**
 * §4 관세 계산 도메인 타입.
 * 계산은 전부 결정론적 코드 (스펙 §1-1). LLM은 여기 관여하지 않는다.
 */

export type TransportMode = 'ocean' | 'air'
export type AllocationBasis = 'value' | 'weight'

import type { AppliedProgram, UnresolvedProgram } from './programs.ts'

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
  /**
   * ad valorem 소수 (6.5% → 0.065). MVP는 종가세만 지원.
   *
   * **null = 숫자를 정하지 않았다** (resolution='unresolved'). 0 이 아니다 —
   * 0 을 넣으면 어딘가에서 그냥 더해지고 그 사고는 조용하다. null 이면
   * 컴파일러가 모든 사용처를 찾아준다.
   */
  ad_valorem_rate: number | null
  /**
   * covered    세율이 확정된 행
   * unresolved 리스트 배정을 확인하지 못해 숫자를 정하지 않은 행
   *            (ad_valorem_rate 는 반드시 null — DB CHECK 로 묶여 있다)
   */
  resolution?: 'covered' | 'unresolved'
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
  /**
   * **null = 301 미해결.** 확정된 프로그램만으로는 합계를 말할 수 없다는 뜻이다.
   * 0 과 구분해야 한다 — 0 은 "관세 없음이 확인됨" 이다.
   */
  duty_rate_total: number | null
  /** 단위당 USD. duty_rate_total 이 null 이면 여기도 null */
  duty_usd: number | null
  /**
   * 미해결 프로그램. 비어 있지 않으면 duty_rate_total 은 null 이다.
   * 화면·리포트는 이 목록으로 "0% 또는 25%" 범위를 보여준다.
   */
  unresolved_programs: UnresolvedProgram[]
  freight_per_unit: number
  mpf_per_unit: number
  hmf_per_unit: number
  /** mpf + hmf */
  fees_per_unit: number
  /** null = duty 가 미해결이라 랜디드 코스트를 확정할 수 없다 */
  landed_cost: number | null
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
  /**
   * duty 를 확정하지 못한 SKU 수. **0 이 아니면 이 선적의 모든 합계는 부분합이다.**
   * 화면·CSV 는 "Total (excludes N unresolved SKUs)" 처럼 이름에 박아야 한다 —
   * 깨끗한 총계로 나가면 줄 단위로 지킨 원칙이 총계에서 무너진다.
   */
  unresolved_skus: number
  allocation_basis_used: AllocationBasis
}

export interface ShipmentResult {
  items: SkuResult[]
  totals: ShipmentTotals
  rate_as_of: string
  warnings: string[]
}
