/**
 * 중국 Section 301 리스트를 rate_ledger 에 적재한다.
 *
 * 입력: data/section301_lists.json (npm run hts:301 산출)
 * 선행: supabase/migrations/0013_china_301.sql 적용
 * 실행: npm run seed:301
 *
 * ── 무엇을 넣는가 ────────────────────────────────────────────────
 * 1. 활성 리스트(List 1/2/3/4A)의 8자리마다 한 행. 프로그램은 리스트별로 분리해
 *    감사 시 어느 소절 근거인지 바로 보이게 한다.
 * 2. List 4B(정지)는 **넣지 않는다.** 원문이 정지시켰으므로 0% 가 맞고,
 *    프로그램 coverage=enumerated 라 부재가 곧 "확인된 0%" 로 해석된다.
 * 3. 미확정 행(source 가 UNVERIFIED 로 시작) — 엔진이 경고를 낸다:
 *    a. 2024 4년 재검토 인상(9903.91.xx) 라인 — 이번 범위 밖
 *    b. note 가 열거한 8자리가 현행 관세표에서 재편돼 사라진 경우의 현행 형제 라인.
 *       예: note 는 4419.90.10 을 열거하지만 현행은 .11/.91 로 쪼개졌다. 그 둘의
 *       커버리지가 불명이므로 0% 로 계산하되 경고한다.
 *
 * 카탈로그에 없는 8자리는 넣지 않는다 — 어떤 10자리와도 매칭될 수 없어 무의미하고,
 * 원장에 죽은 행을 남기면 나중에 세는 숫자가 틀린다.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function dotenv(): Record<string, string> {
  const f = join(root, '.env')
  if (!existsSync(f)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(f, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
  return out
}
const env = dotenv()
const URL_ = process.env.VITE_SUPABASE_URL ?? env.VITE_SUPABASE_URL
const SRV = process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY
if (!URL_ || !SRV) throw new Error('VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요하다')

const H = { 'Content-Type': 'application/json', apikey: SRV, Authorization: `Bearer ${SRV}` }

/** 리스트 → 프로그램 코드·발효일 (0013 마이그레이션과 일치해야 한다) */
const PROGRAM: Record<string, { code: string; from: string }> = {
  list1: { code: '301-china-list1', from: '2018-07-06' },
  list2: { code: '301-china-list2', from: '2018-08-23' },
  list3: { code: '301-china-list3', from: '2019-05-10' },
  list4a: { code: '301-china-list4a', from: '2020-02-14' },
}
const UNVERIFIED = { code: '301-china-unverified', from: '2018-07-06' }

interface Row {
  program_code: string
  hts_code: string
  origin_country: string
  layer: string
  ad_valorem_rate: number
  effective_from: string
  effective_to: null
  source: string
  note: string
}

async function del(programCode: string) {
  const res = await fetch(`${URL_}/rest/v1/rate_ledger?program_code=eq.${programCode}`, {
    method: 'DELETE',
    headers: H,
  })
  if (!res.ok) throw new Error(`delete ${programCode}: ${res.status} ${(await res.text()).slice(0, 200)}`)
}

async function insert(rows: Row[]) {
  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK)
    const res = await fetch(`${URL_}/rest/v1/rate_ledger`, {
      method: 'POST',
      headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify(batch),
    })
    if (!res.ok) throw new Error(`insert @${i}: ${res.status} ${(await res.text()).slice(0, 300)}`)
    process.stdout.write(`\r  적재 ${Math.min(i + CHUNK, rows.length)}/${rows.length}`)
  }
  process.stdout.write('\n')
}

async function main() {
  const src = join(root, 'data/section301_lists.json')
  if (!existsSync(src)) throw new Error('data/section301_lists.json 이 없다 — npm run hts:301 먼저')
  const d = JSON.parse(readFileSync(src, 'utf-8')) as {
    source_note: string
    lists: Array<{ list: string; provision: string; rate: number; active: boolean; codes: string[]; citation: string }>
    review_2024_excluded: string[]
  }

  const cat = JSON.parse(readFileSync(join(root, 'data/hts_lines.json'), 'utf-8')) as Array<{ code: string }>
  const eight = new Set(cat.map((l) => l.code.slice(0, 8)))

  const rows: Row[] = []
  const activeCovered = new Set<string>()

  for (const L of d.lists) {
    if (!L.active) {
      console.log(`  ${L.list} — 정지 목록이라 적재하지 않는다 (${L.codes.length}개, 부재 = 확인된 0%)`)
      continue
    }
    const p = PROGRAM[L.list]
    const usable = L.codes.filter((c) => eight.has(c))
    for (const c of usable) {
      activeCovered.add(c)
      rows.push({
        program_code: p.code,
        hts_code: c,
        origin_country: 'CN',
        layer: 'section301',
        ad_valorem_rate: L.rate,
        effective_from: p.from,
        effective_to: null,
        source: L.citation,
        note: `${L.list} · ${L.provision} · U.S. note 20 열거 8자리`,
      })
    }
    console.log(`  ${L.list.padEnd(7)} ${usable.length}개 적재 (카탈로그 미존재 ${L.codes.length - usable.length}개 제외)`)
  }

  // ── 미확정 행 ──────────────────────────────────────────────────
  const unver = new Map<string, string>()

  // (a) 2024 4년 재검토 인상 — **레거시 301 과는 다른 조항이다.**
  //
  // 예전에는 이 코드들을 "301 미해결" 로 표시했는데, 그건 두 가지를 섞은 것이다:
  //   · Note 20 의 레거시 리스트(1·2·3·4A·4B) 배정 → 이 코드들은 **어디에도 없다.**
  //     열거되지 않았으므로 not_covered, 즉 확인된 0% 다.
  //   · 9903.91.xx 인상 조항 → 아예 적재하지 않은 **별개 프로그램**이다.
  //
  // 앞의 것은 확정됐고 뒤의 것은 라인 단위 미해결이 아니라 프로그램 단위
  // 커버리지 공백이다. 라인에 "모름" 을 붙여 두면 진짜 모르는 라인과 구분이 안 된다.
  const outOfScope = d.review_2024_excluded.filter((c) => eight.has(c) && !activeCovered.has(c))
  if (outOfScope.length > 0) {
    console.log(
      `  9903.91.xx (2024 4년 재검토 인상) ${outOfScope.length}개 코드는 적재 범위 밖 — ` +
        `Note 20 레거시 리스트 기준으로는 확인된 0% 다. 별개 프로그램 공백은 backlog A-5 참조.`,
    )
  }

  // (b) note 의 8자리가 현행에서 재편돼 사라진 경우 → 현행 형제 라인이 불명
  // **직접 열거된 코드는 형제로 덮지 않는다.** 이 규칙이 빠져 있어서 시계 3개
  // (9105.19.40 · 9105.29.40 · 9105.99.50) 가 미해결로 잘못 분류됐다 — 셋 다
  // Note 20 이 List 4B 로 **직접 열거**하고 있었다. 4B 는 정지 목록이라 부재가
  // 곧 확인된 0% 인데, 형제 규칙이 그 위에 "모름" 을 덮어썼다.
  // 정지 목록에 열거된 것은 "모르는" 게 아니라 "0% 임이 확인된" 것이다.
  const enumeratedAnywhere = new Set(d.lists.flatMap((L) => L.codes))
  const stale = d.lists.flatMap((L) => (L.active ? L.codes.filter((c) => !eight.has(c)) : []))
  // 흔적을 남긴다. 이 숫자가 note 행수와 실제 적재 행수의 차이를 그대로 설명한다
  // (list3 −7, list4a −72). 조용히 사라지면 나중에 "왜 안 맞지" 로 돌아온다.
  if (stale.length > 0) {
    console.log(`  note 20 이 열거하나 현행 관세표에 없는 코드 ${stale.length}개 — 적재 행수 차이의 원인이다`)
  }
  for (const s of stale) {
    const six = s.slice(0, 6)
    for (const sib of eight) {
      if (!sib.startsWith(six) || activeCovered.has(sib)) continue
      if (enumeratedAnywhere.has(sib)) continue
      unver.set(sib, `UNVERIFIED-RESTRUCTURED: note 는 ${s} 를 열거하나 현행 관세표에 없다 — 같은 소호의 현행 라인 커버리지 불명`)
    }
  }

  for (const [code, note] of unver) {
    rows.push({
      program_code: UNVERIFIED.code,
      hts_code: code,
      origin_country: 'CN',
      layer: 'section301',
      ad_valorem_rate: 0,
      effective_from: UNVERIFIED.from,
      effective_to: null,
      source: note.split(':')[0],
      note,
    })
  }
  console.log(`  미확정   ${unver.size}개 (0% 로 계산하되 경고)`)

  console.log()
  console.log(`총 ${rows.length.toLocaleString()}행 — 기존 행 삭제 후 적재`)
  for (const p of [...Object.values(PROGRAM), UNVERIFIED]) await del(p.code)
  await insert(rows)

  // 검증: 실제로 들어갔는지 프로그램별로 센다
  console.log()
  console.log('── 적재 확인 (DB 조회) ─────────────────────────────')
  for (const p of [...Object.values(PROGRAM), UNVERIFIED]) {
    const res = await fetch(`${URL_}/rest/v1/rate_ledger?program_code=eq.${p.code}&select=hts_code`, {
      headers: { ...H, Prefer: 'count=exact', Range: '0-0' },
    })
    const cr = res.headers.get('content-range') ?? '?'
    console.log(`  ${p.code.padEnd(24)} ${cr.split('/')[1] ?? '?'}행`)
  }
}

main()
