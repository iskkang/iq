/**
 * 원장 매니페스트 생성·대조 (백로그 A-2).
 *
 *   npm run ledger:manifest   DB 를 읽어 data/ledger.manifest.json 을 새로 쓴다
 *   npm run ledger:verify     DB 를 다시 읽어 커밋된 매니페스트와 대조한다
 *
 * ── 무엇을 잡는가 ────────────────────────────────────────────────
 * 0021(중복)·0022(아카이브 불변)는 DB 제약이라 그 경로를 통과할 때만 막는다.
 * SQL Editor 는 이 저장소에서 실제로 쓰이는 경로이고, 0022 에는 의도적인 탈출구
 * (`set local app.allow_archive_edit = 'on'`)도 있다. 그 길로 원장이 달라져도
 * 아무도 모른다 — 그걸 여기서 잡는다.
 *
 * ── 왜 폴백하지 않는가 ───────────────────────────────────────────
 * 자격증명이 없으면 즉시 실패한다. "DB 를 못 읽어서 건너뛴다" 가 성공으로 보이면
 * 탐지기가 꺼진 채로 초록불이 켜지고, 그게 이 저장소가 이미 겪은 실패 모드다
 * (seed:rates 가 몇 세션 동안 조용히 실패했다 — scripts/lib/db.ts 주석 참고).
 *
 * 대조는 커밋된 매니페스트의 `as_of` 를 쓴다. 오늘 날짜를 쓰면 아무도 원장을
 * 건드리지 않아도 만료가 진행돼 거짓 드리프트가 뜬다 — 거짓 경보를 내는 탐지기는
 * 곧 꺼진다.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { dbUrl, serviceKey } from './lib/db'
import { buildManifest, diffManifest, type LedgerManifest, type LedgerRow } from './lib/manifest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, 'data/ledger.manifest.json')
const MODE = process.argv.includes('--mode=verify') ? 'verify' : 'refresh'

const SELECT = 'program_code,hts_code,origin_country,ad_valorem_rate,effective_from,effective_to'
const PAGE = 1000

/**
 * rate_ledger 전체를 페이지로 읽는다.
 *
 * PostgREST 는 기본 상한이 있어 한 번에 다 오지 않는다. 상한에 걸린 걸 모르고
 * 매니페스트를 만들면 **행수가 줄어든 채로 커밋**되고, 그 뒤 대조는 영원히
 * 통과한다 — 탐지기가 자기 기준을 잘못 잡는 최악의 형태다. 그래서 마지막
 * 페이지가 PAGE 보다 작을 때까지 확실히 끝까지 읽는다.
 */
async function loadLedger(): Promise<LedgerRow[]> {
  const headers = {
    apikey: serviceKey(),
    Authorization: `Bearer ${serviceKey()}`,
  }
  const out: LedgerRow[] = []
  for (let from = 0; ; from += PAGE) {
    const url = `${dbUrl()}/rest/v1/rate_ledger?select=${SELECT}&order=program_code.asc,hts_code.asc`
    const res = await fetch(url, { headers: { ...headers, Range: `${from}-${from + PAGE - 1}` } })
    if (!res.ok) throw new Error(`rate_ledger 조회 실패: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
    const page = (await res.json()) as LedgerRow[]
    out.push(...page)
    if (page.length < PAGE) return out
  }
}

function readCommitted(): LedgerManifest {
  if (!existsSync(OUT)) {
    throw new Error(
      `${OUT} 가 없다. 먼저 npm run ledger:manifest 로 생성해 커밋할 것. ` +
        '없다고 통과시키면 드리프트 가드가 조용히 사라진다.',
    )
  }
  return JSON.parse(readFileSync(OUT, 'utf-8')) as LedgerManifest
}

async function main() {
  const rows = await loadLedger()
  if (rows.length === 0) {
    throw new Error('rate_ledger 가 0행이다. 매니페스트를 그 상태로 쓰면 이후 모든 대조가 무의미해진다.')
  }

  if (MODE === 'refresh') {
    const asOf = new Date().toISOString().slice(0, 10)
    const m = buildManifest(rows, asOf)
    writeFileSync(OUT, JSON.stringify(m, null, 2) + String.fromCharCode(10))
    console.log('── 원장 매니페스트 생성 ────────────────────────')
    console.log(`  기준일    ${m.as_of}`)
    console.log(`  전체      ${m.totals.rows}행 (active ${m.totals.active} · archive ${m.totals.archive})`)
    console.log(`  프로그램  ${m.totals.programs}개`)
    for (const [p, e] of Object.entries(m.active)) console.log(`    ${p.padEnd(24)} ${String(e.rows).padStart(6)}행`)
    console.log(`\n→ ${OUT} — 커밋할 것. git diff 가 원장 변경 이력이 된다.`)
    return
  }

  const committed = readCommitted()
  // **커밋된 as_of 로 다시 만든다.** 오늘 날짜를 쓰면 만료 진행만으로 거짓 드리프트가 뜬다
  const current = buildManifest(rows, committed.as_of)
  const drift = diffManifest(committed, current)

  console.log(`기준일 ${committed.as_of} · 커밋 ${committed.totals.rows}행 vs 현재 ${current.totals.rows}행`)
  if (drift.length === 0) {
    console.log('원장 드리프트 없음')
    return
  }

  console.error('── 원장 드리프트 ───────────────────────────────')
  for (const d of drift) console.error(`  ✗ [${d.section}] ${d.program} — ${d.detail}`)
  console.error('')
  console.error('  의도한 변경이면 npm run ledger:manifest 로 갱신하고 커밋할 것.')
  console.error('  의도하지 않았다면 SQL Editor 로 직접 건드린 흔적이다 — docs/rate-ledger-sop.md 를 볼 것.')
  process.exit(1)
}

await main()
