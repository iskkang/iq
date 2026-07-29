import Papa from 'papaparse'

/** CSV 필수 컬럼 (스펙 §2) */
export const REQUIRED_COLUMNS = [
  'sku',
  'product_name',
  'description_or_material',
  'unit_cost_usd',
  'origin_country',
  'units_per_shipment',
] as const

/** 선택 컬럼: 중량 배부·마진 계산·HTS 직접 지정용 */
export const OPTIONAL_COLUMNS = ['weight_kg_per_unit', 'current_price_usd', 'hts_code'] as const

export interface ParsedItemRow {
  sku: string
  product_name: string
  description_or_material: string
  unit_cost_usd: number
  origin_country: string
  units_per_shipment: number
  weight_kg_per_unit: number | null
  current_price_usd: number | null
  hts_code: string | null
}

export interface ParseResult {
  items: ParsedItemRow[]
  /** 행 단위 오류 (행 번호는 헤더 제외 1-base) */
  errors: string[]
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const s = String(v).replace(/[$,\s]/g, '')
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export function parseItemsCsv(csvText: string): ParseResult {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  })

  const errors: string[] = []
  const fields = parsed.meta.fields ?? []
  const missing = REQUIRED_COLUMNS.filter((c) => !fields.includes(c))
  if (missing.length > 0) {
    return { items: [], errors: [`Missing required columns: ${missing.join(', ')}`] }
  }

  const items: ParsedItemRow[] = []
  parsed.data.forEach((row, i) => {
    const line = i + 1
    const sku = (row.sku ?? '').trim()
    const cost = num(row.unit_cost_usd)
    const units = num(row.units_per_shipment)
    const origin = (row.origin_country ?? '').trim().toUpperCase()

    if (!sku) return errors.push(`Row ${line}: missing sku`)
    if (cost === null || cost <= 0) return errors.push(`Row ${line} (${sku}): unit_cost_usd must be a positive number`)
    if (units === null || units <= 0 || !Number.isInteger(units))
      return errors.push(`Row ${line} (${sku}): units_per_shipment must be a positive integer`)
    if (!origin) return errors.push(`Row ${line} (${sku}): missing origin_country`)

    const weight = num(row.weight_kg_per_unit)
    const price = num(row.current_price_usd)
    const hts = (row.hts_code ?? '').replace(/\D/g, '')

    items.push({
      sku,
      product_name: (row.product_name ?? '').trim(),
      description_or_material: (row.description_or_material ?? '').trim(),
      unit_cost_usd: cost,
      origin_country: origin,
      units_per_shipment: units,
      weight_kg_per_unit: weight !== null && weight > 0 ? weight : null,
      current_price_usd: price !== null && price > 0 ? price : null,
      hts_code: hts.length === 10 ? hts : null,
    })
  })

  return { items, errors }
}
