/**
 * data/hts_lines.json → Supabase `hts_lines` + `rate_ledger`(base_mfn).
 *
 * 스펙 §4 근거: base MFN 은 USITC 공식 데이터에서 시드한다. 301·IEEPA 는
 * 관리자 수기 입력이므로 이 스크립트가 건드리지 않는다.
 *
 * 부수 효과: 골든 v1·v2 에서 넣었던 UNVERIFIED-PLACEHOLDER 행을 지운다.
 * 이제 실제 USITC 값이 있으므로 자리표시자를 남겨두면 잘못된 값이 이긴다.
 *
 * 사용:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run hts:seed
 *   ... npm run hts:seed -- --lines-only        # rate_ledger 는 건드리지 않음
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { HtsLine } from './fetch-hts-catalog'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function envOrDotenv(name: string): string | undefined {
  if (process.env[name]) return process.env[name]
  const f = join(root, '.env')
  if (!existsSync(f)) return undefined
  const m = readFileSync(f, 'utf-8').match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)\\s*$`, 'm'))
  return m ? m[1].replace(/^["']|["']$/g, '') : undefined
}

const url = envOrDotenv('SUPABASE_URL') ?? envOrDotenv('VITE_SUPABASE_URL')
const key = envOrDotenv('SUPABASE_SERVICE_ROLE_KEY')
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요 (.env 또는 env)')
  process.exit(1)
}
/**
 * PostgREST 직접 호출.
 * supabase-js 는 realtime 초기화에 전역 WebSocket 을 요구하는데 Node 20 에는 없다.
 * 시드에 필요한 건 REST 뿐이라 fetch 로 직접 친다.
 */
async function rest(
  method: 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key!,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res
}

const upsert = (table: string, rows: unknown[], onConflict: string) =>
  rest('POST', `${table}?on_conflict=${onConflict}`, rows, {
    Prefer: 'resolution=merge-duplicates,return=minimal',
  })

const CATALOG = join(root, 'data/hts_lines.json')
const META = join(root, 'data/hts_lines.meta.json')

async function main() {
  const linesOnly = process.argv.includes('--lines-only')
  if (!existsSync(CATALOG)) {
    console.error(`${CATALOG} 없음 — 먼저 npm run hts:fetch`)
    process.exit(1)
  }
  const lines: HtsLine[] = JSON.parse(readFileSync(CATALOG, 'utf-8'))
  const meta = JSON.parse(readFileSync(META, 'utf-8'))
  const source = `USITC HTS export (${meta.source})`
  console.log(`카탈로그 ${lines.length.toLocaleString()} 라인`)

  // ── hts_lines ────────────────────────────────────────────────
  const CHUNK = 1000
  for (let i = 0; i < lines.length; i += CHUNK) {
    const chunk = lines.slice(i, i + CHUNK).map((l) => ({
      code: l.code,
      heading: l.heading,
      description: l.description,
      leaf: l.leaf,
      general: l.general || null,
      general_inherited: l.generalInherited,
      units: l.units ?? [],
      source,
    }))
    await upsert('hts_lines', chunk, 'code')
    process.stdout.write(`\r  hts_lines ${Math.min(i + CHUNK, lines.length).toLocaleString()}/${lines.length.toLocaleString()}`)
  }
  console.log('')

  if (linesOnly) {
    console.log('--lines-only → rate_ledger 생략')
    return
  }

  // ── rate_ledger base_mfn (종가세만) ──────────────────────────
  const rateRows = lines
    .filter((l) => l.adValorem !== null)
    .map((l) => ({
      hts_code: l.code,
      origin_country: null,
      layer: 'base_mfn',
      ad_valorem_rate: l.adValorem as number,
      effective_from: '2025-01-01',
      effective_to: null,
      source,
      note: l.generalInherited ? `general "${l.general}" — 상위 라인에서 상속` : `general "${l.general}"`,
    }))
  console.log(`rate_ledger base_mfn ${rateRows.length.toLocaleString()} 행 (종량·복합세 ${(lines.length - rateRows.length).toLocaleString()}건 제외)`)

  for (let i = 0; i < rateRows.length; i += CHUNK) {
    await upsert('rate_ledger', rateRows.slice(i, i + CHUNK), 'hts_code,origin_country,layer,effective_from')
    process.stdout.write(`\r  rate_ledger ${Math.min(i + CHUNK, rateRows.length).toLocaleString()}/${rateRows.length.toLocaleString()}`)
  }
  console.log('')

  // ── 자리표시자 정리 ──────────────────────────────────────────
  await rest('DELETE', 'rate_ledger?source=eq.UNVERIFIED-PLACEHOLDER', undefined, { Prefer: 'return=minimal' })
  console.log('UNVERIFIED-PLACEHOLDER 행 삭제 완료')

  console.log('')
  console.log('완료. Section 301·IEEPA 는 여전히 관리자 수기 입력 대상이다 (스펙 §4).')
}

main()
