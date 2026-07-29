/**
 * 동봉 시드 CSV → RateRow[] (데모 모드·mock 분류에서 사용).
 * 실 배포에서는 Supabase rate_ledger 테이블이 단일 소스다.
 */
import Papa from 'papaparse'
import seedCsv from '../../supabase/seed/hts_seed_50.csv?raw'
import type { FeeSettings, RateLayer, RateRow } from './calc/types'

export function parseSeedCsv(csv: string): RateRow[] {
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true })
  return parsed.data.map((r) => ({
    hts_code: r.hts_code.trim(),
    origin_country: r.origin_country?.trim() ? r.origin_country.trim().toUpperCase() : null,
    layer: r.layer.trim() as RateLayer,
    ad_valorem_rate: Number(r.ad_valorem_rate),
    effective_from: r.effective_from.trim(),
    effective_to: r.effective_to?.trim() ? r.effective_to.trim() : null,
    source: r.source?.trim() || null,
    note: r.note?.trim() || null,
  }))
}

export const SEED_RATES: RateRow[] = parseSeedCsv(seedCsv)

/** FY2025 값 — 실 배포에서는 fee_settings 테이블에서 조회 (연도별 조정, 스펙 §4) */
export const DEFAULT_FEES: FeeSettings = {
  mpf_rate: 0.003464,
  mpf_min_usd: 32.71,
  mpf_max_usd: 634.62,
  hmf_rate: 0.00125,
  effective_from: '2024-10-01',
}

