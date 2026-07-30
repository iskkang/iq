/**
 * duty_programs · rate_ledger 시드 적재.
 *
 * ── 다시 쓴 이유 ─────────────────────────────────────────────────
 * 이전 판은 **한 번도 성공한 적이 없었다.** 조용한 실패가 셋 겹쳐 있었다:
 *   1. SUPABASE_URL 만 읽는데 .env 는 VITE_SUPABASE_URL 이었다
 *   2. 이름을 맞춰도 supabase-js 가 Node 20 에서 죽는다 (WebSocket 부재)
 *   3. duty_programs 를 아예 적재하지 않았다 — 그래서 프로그램이 없어
 *      세율 행이 FK 위반으로 들어갈 수도 없었다
 * 결과: 강제노동 301 이 원장에 없는 채로 몇 세션이 지났고 프로덕션이 관세를
 * 과소계상했다. "실행했다" 와 "들어갔다" 는 다르다.
 *
 * 이제 PostgREST 로 쓰고 **쓰기 전후 행수를 DB 에서 다시 읽어** 확인한다.
 * 0건 삽입은 언제나 실패다.
 *
 * fee_settings 는 여기서 건드리지 않는다. 이전 판이 FY2025 값을 upsert 해서
 * 마이그레이션으로 넣은 FY2026 을 덮어썼다 — 요율 이력은 마이그레이션이 관리한다.
 *
 * 실행: npm run seed:rates
 *       npm run seed:rates -- --usitc ./htsdata.csv [effective_from]
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Papa from 'papaparse'
import { countRows, dbUrl, insertRows, serviceKey, verifiedWrite } from '../../scripts/lib/db'

const here = dirname(fileURLToPath(import.meta.url))

type Row = Record<string, string | number | null>

function parse(file: string): Row[] {
  const csv = readFileSync(file, 'utf-8')
  const { data } = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true })
  return data
    .filter((r) => Object.values(r).some((v) => v?.trim()))
    .map((r) => {
      const o: Row = {}
      for (const [k, v] of Object.entries(r)) o[k.trim()] = v?.trim() ? v.trim() : null
      if (o.ad_valorem_rate !== null && o.ad_valorem_rate !== undefined) o.ad_valorem_rate = Number(o.ad_valorem_rate)
      if (typeof o.origin_country === 'string') o.origin_country = o.origin_country.toUpperCase()
      return o
    })
}

/** USITC 공식 CSV export → base MFN 행 (종가세만) */
function loadUsitc(file: string, effectiveFrom: string): Row[] {
  const { data } = Papa.parse<Record<string, string>>(readFileSync(file, 'utf-8'), {
    header: true,
    skipEmptyLines: true,
  })
  const rows: Row[] = []
  let skipped = 0
  for (const r of data) {
    const hts = (r['HTS Number'] ?? r['hts_number'] ?? '').replace(/\D/g, '')
    if (hts.length !== 8 && hts.length !== 10) continue
    const s = (r['General Rate of Duty'] ?? r['general_rate_of_duty'] ?? '').trim()
    if (!s) continue
    let rate: number | null = null
    if (/^free$/i.test(s)) rate = 0
    else {
      const m = s.match(/^(\d+(?:\.\d+)?)\s*%$/)
      if (m) rate = Number(m[1]) / 100
    }
    if (rate === null) {
      skipped++
      continue
    }
    rows.push({
      program_code: 'mfn',
      hts_code: hts,
      origin_country: null,
      layer: 'base_mfn',
      ad_valorem_rate: rate,
      effective_from: effectiveFrom,
      effective_to: null,
      source: `USITC export ${file.split(/[/\\]/).pop()}`,
      note: null,
    })
  }
  if (skipped > 0) console.log(`  종가세가 아닌 ${skipped}행은 건너뜀 (종량세·복합세는 MVP 미지원)`)
  return rows
}

async function main() {
  const args = process.argv.slice(2)
  const usitc = args.indexOf('--usitc')

  // ── 1. duty_programs (upsert) ──────────────────────────────────
  // 세율 행이 program_code FK 를 갖고 있어 프로그램이 먼저다.
  const programs = parse(join(here, 'duty_programs.csv'))
  const pBefore = await countRows('duty_programs')
  await insertRows('duty_programs', programs, 'return=minimal,resolution=merge-duplicates')
  const pAfter = await countRows('duty_programs')
  console.log(
    `  duty_programs: ${pAfter - pBefore}행 삽입 / ${programs.length - (pAfter - pBefore)}행 갱신 ` +
      `(${pBefore} → ${pAfter}, DB 재조회 값)`,
  )
  if (pAfter === 0) throw new Error('duty_programs 가 여전히 0행이다 — 적재되지 않았다')

  // ── 2. rate_ledger ─────────────────────────────────────────────
  const all =
    usitc >= 0 && args[usitc + 1] ? loadUsitc(args[usitc + 1], args[usitc + 2] ?? '2025-01-01') : parse(join(here, 'hts_seed_50.csv'))

  // **mfn 은 건드리지 않는다.** 진실 출처는 USITC 전량 적재(npm run hts:seed,
  // 17,633행)이고 이 CSV 의 50행은 초기 테스트용 표본이다. 예전 판이 이걸
  // 구분하지 않아, 지우고-다시-넣기가 USITC 17,583행을 날렸다 (실제로 겪었다).
  // --usitc 모드는 USITC 파일이 곧 진실 출처이므로 예외다.
  const rates = usitc >= 0 ? all : all.filter((r) => r.program_code !== 'mfn')
  if (usitc < 0 && rates.length < all.length) {
    console.log(`  mfn ${all.length - rates.length}행은 건너뜀 — USITC 적재(hts:seed)가 진실 출처다`)
  }
  const codes = [...new Set(rates.map((r) => String(r.program_code)))]
  const filter = `program_code=in.(${codes.join(',')})`

  // 멱등하게 만든다. `*_one_open` 인덱스가 (program_code, hts_code, origin_country)
  // 당 열린 행을 하나로 강제하므로, 그냥 다시 넣으면 두 번째 실행이 23505 로 죽는다.
  // 시드는 "이 CSV 가 그 프로그램들의 진실 출처" 라는 선언이므로 지우고 다시 넣는다.
  await verifiedWrite(
    'rate_ledger',
    'rate_ledger',
    async () => {
      const res = await fetch(`${dbUrl()}/rest/v1/rate_ledger?${filter}`, {
        method: 'DELETE',
        headers: { apikey: serviceKey(), Authorization: `Bearer ${serviceKey()}` },
      })
      if (!res.ok) throw new Error(`기존 행 삭제 실패: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
      await insertRows('rate_ledger', rates)
    },
    { filter, expectedDeltaAbsolute: rates.length },
  )

  console.log()
  console.log('적재 완료 — 위 숫자는 요청 건수가 아니라 DB 에서 다시 읽은 값이다.')
  console.log('fee_settings 는 마이그레이션이 관리한다 (여기서 건드리지 않는다).')
}

main().catch((e) => {
  console.error()
  console.error('✗ 시드 실패:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})
