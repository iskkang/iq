/**
 * 가입 즉시 만들어지는 데모 선적 (스펙 §MVP).
 *
 * 빈 화면 + 7필드 폼으로 시작하면 신규 사용자가 첫 리포트까지 못 간다.
 * 선적 1건과 SKU 5건을 미리 넣어 **클릭 한 번에 리포트가 뜨게** 한다.
 * HTS 는 확정 상태로 넣어 분류를 기다리지 않고 바로 숫자를 볼 수 있다.
 *
 * 실제 CSV 업로드와 같은 경로(addItems)를 타므로 별도 코드 경로가 아니다.
 *
 * **원산지는 중국이다.** 레거시 301 리스트를 8자리 단위로 적재했으므로 이제 중국
 * 관세를 완결로 표시할 수 있고, 리스트별로 결과가 갈리는 게 첫 화면에서 보인다:
 * 백팩(List 3 +25%)은 3층 스택, 머그(List 4B 정지)는 MFN + 강제노동 301 2층.
 */
import type { ParsedItemRow } from '../csv/parseItems'
import type { NewShipment } from './types'

export const SAMPLE_SHIPMENT_NAME = 'Sample shipment (try me)'

export function sampleShipment(rateAsOf: string): NewShipment {
  return {
    name: SAMPLE_SHIPMENT_NAME,
    freight_usd: 2000,
    insurance_usd: 100,
    mode: 'ocean',
    allocation_basis: 'value',
    target_margin: 0.3,
    channel_fee_pct: 0.15,
    rate_as_of: rateAsOf,
  }
}

/** HTS 확정 상태로 넣는다 — 분류를 기다리지 않고 바로 리포트가 나오도록 */
export const SAMPLE_ITEMS: ParsedItemRow[] = [
  {
    sku: 'MUG-01',
    product_name: 'Ceramic coffee mug 11oz',
    description_or_material: 'Glazed stoneware ceramic mug for hot beverages',
    unit_cost_usd: 2.5,
    origin_country: 'CN',
    units_per_shipment: 1000,
    weight_kg_per_unit: null,
    current_price_usd: 12.99,
    hts_code: '6912004400',
  },
  {
    sku: 'BACKPACK-01',
    product_name: 'Laptop backpack',
    description_or_material: '100% polyester outer shell with padded straps',
    unit_cost_usd: 8.5,
    origin_country: 'CN',
    units_per_shipment: 400,
    weight_kg_per_unit: null,
    current_price_usd: 39.99,
    hts_code: '4202923120',
  },
  {
    sku: 'PAN-01',
    product_name: 'Stainless frying pan 28cm',
    description_or_material: 'Stainless steel kitchen frying pan',
    unit_cost_usd: 6.4,
    origin_country: 'CN',
    units_per_shipment: 300,
    weight_kg_per_unit: null,
    current_price_usd: 24.99,
    hts_code: '7323930060',
  },
  {
    sku: 'TSHIRT-01',
    product_name: "Men's crew neck t-shirt",
    description_or_material: '100% cotton knitted short-sleeve t-shirt',
    unit_cost_usd: 3.2,
    origin_country: 'CN',
    units_per_shipment: 800,
    weight_kg_per_unit: null,
    current_price_usd: 19.99,
    hts_code: '6109100012',
  },
  {
    sku: 'TUMBLER-01',
    product_name: 'Insulated tumbler 20oz',
    description_or_material: 'Double-wall vacuum insulated stainless steel tumbler with lid',
    unit_cost_usd: 3.1,
    origin_country: 'CN',
    units_per_shipment: 600,
    weight_kg_per_unit: null,
    current_price_usd: 24.99,
    hts_code: '9617001000',
  },
]
