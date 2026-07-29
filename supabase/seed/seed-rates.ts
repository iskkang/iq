/**
 * rate 원장 시드 스크립트 (스펙 §1-4, §8).
 *
 * 기본: 동봉된 hts_seed_50.csv(테스트용 base MFN 50개 + 301/IEEPA 예시)를 적재.
 * 옵션: --usitc <file> — hts.usitc.gov 에서 내려받은 공식 CSV export에서
 *        ad valorem(%) general rate만 추출해 base_mfn 레이어로 적재.
 *        (301·IEEPA는 원칙상 관리자 수기 입력 — 자동 스크래핑 금지)
 *
 * 사용:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run seed:rates
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run seed:rates -- --usitc ./htsdata.csv
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Papa from 'papaparse'

const __dirname = dirname(fileURLToPath(import.meta.url))

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars are required.')
  process.exit(1)
}
const supabase = createClient(url, key)

interface SeedRow {
  hts_code: string
  origin_country: string | null
  layer: string
  ad_valorem_rate: number
  effective_from: string
  effective_to: string | null
  source: string | null
  note: string | null
}

function loadBundledSeed(): SeedRow[] {
  const csv = readFileSync(join(__dirname, 'hts_seed_50.csv'), 'utf-8')
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true })
  return parsed.data.map((r) => ({
    hts_code: r.hts_code.trim(),
    origin_country: r.origin_country?.trim() ? r.origin_country.trim().toUpperCase() : null,
    layer: r.layer.trim(),
    ad_valorem_rate: Number(r.ad_valorem_rate),
    effective_from: r.effective_from.trim(),
    effective_to: r.effective_to?.trim() ? r.effective_to.trim() : null,
    source: r.source?.trim() || null,
    note: r.note?.trim() || null,
  }))
}

/**
 * USITC 공식 CSV export 파서 (hts.usitc.gov → Export → CSV).
 * 'HTS Number' + 'General Rate of Duty' 컬럼에서 "N%" 형태의 종가세만 추출.
 * Free → 0. 종량세/복합세("$0.02/kg + 4%")는 MVP 미지원이라 건너뛰고 개수만 보고.
 */
function loadUsitcCsv(file: string, effectiveFrom: string): SeedRow[] {
  const csv = readFileSync(file, 'utf-8')
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true })
  const rows: SeedRow[] = []
  let skipped = 0
  for (const r of parsed.data) {
    const hts = (r['HTS Number'] ?? r['hts_number'] ?? '').replace(/\D/g, '')
    if (hts.length !== 8 && hts.length !== 10) continue
    const rateStr = (r['General Rate of Duty'] ?? r['general_rate_of_duty'] ?? '').trim()
    if (!rateStr) continue
    let rate: number | null = null
    if (/^free$/i.test(rateStr)) rate = 0
    else {
      const m = rateStr.match(/^(\d+(?:\.\d+)?)\s*%$/)
      if (m) rate = Number(m[1]) / 100
    }
    if (rate === null) {
      skipped++
      continue
    }
    rows.push({
      hts_code: hts,
      origin_country: null,
      layer: 'base_mfn',
      ad_valorem_rate: rate,
      effective_from: effectiveFrom,
      effective_to: null,
      source: `USITC export ${file.split('/').pop()}`,
      note: null,
    })
  }
  if (skipped > 0) console.log(`Skipped ${skipped} non-ad-valorem rows (specific/compound rates — MVP supports ad valorem only)`)
  return rows
}

async function main() {
  const args = process.argv.slice(2)
  const usitcIdx = args.indexOf('--usitc')
  const rows =
    usitcIdx >= 0 && args[usitcIdx + 1]
      ? loadUsitcCsv(args[usitcIdx + 1], args[usitcIdx + 2] ?? '2025-01-01')
      : loadBundledSeed()

  console.log(`rate_ledger upsert: ${rows.length} rows`)
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500)
    const { error } = await supabase
      .from('rate_ledger')
      .upsert(chunk, { onConflict: 'hts_code,origin_country,layer,effective_from' })
    if (error) {
      console.error('rate_ledger upsert failed:', error.message)
      process.exit(1)
    }
  }

  // MPF·HMF 설정 (FY2025 — 매년 10/1 CBP 고시로 조정, 관리자 갱신 필요)
  const { error: feeError } = await supabase.from('fee_settings').upsert(
    [
      {
        mpf_rate: 0.003464,
        mpf_min_usd: 32.71,
        mpf_max_usd: 634.62,
        hmf_rate: 0.00125,
        effective_from: '2024-10-01',
        note: 'FY2025 MPF min/max — verify annual adjustment every Oct 1',
      },
    ],
    { onConflict: 'effective_from' },
  )
  if (feeError) {
    console.error('fee_settings upsert failed:', feeError.message)
    process.exit(1)
  }

  console.log('Seed complete. (Enter real Section 301 / IEEPA rates manually in rate_ledger — SAMPLE rows are placeholders.)')
}

main()
