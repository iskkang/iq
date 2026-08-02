/**
 * 웨이브 1 코드 선정 (docs/seo-indexing-policy.md §5).
 *
 * 입력
 *   data/hts_lines.json        USITC 카탈로그 (gitignore — npm run hts:fetch 로 생성)
 *   data/section301_lists.json 301 리스트별 8 자리 코드 (커밋됨)
 *
 * 출력
 *   data/wave1.json            뽑힌 코드 + 근거. 사람이 검수하는 대상이다.
 *
 * **폴백하지 않는다.** 카탈로그가 없으면 명시적으로 실패한다 — 부분 카탈로그로
 * 뽑으면 "왜 이 코드가 빠졌지" 를 나중에 재현할 수 없고, 웨이브 1 은 이후 전체
 * 발행의 근거가 되는 표본이라 조용히 틀리면 그 위에 다 쌓인다.
 *
 * 실행: npm run seo:wave1
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decidePage, dotted, pagePath } from '../src/lib/seo/pages'
import { selectWave, chapterSpread, type WaveCandidate } from '../src/lib/seo/wave'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG = join(root, 'data/hts_lines.json')
const LISTS = join(root, 'data/section301_lists.json')
const OUT = join(root, 'data/wave1.json')

const SIZE = 200
/** 200 / 96 장 ≈ 2. 넉넉히 8 로 둔다 — 한 장이 표본의 4 % 를 넘지 못한다 */
const MAX_PER_CHAPTER = 8

/**
 * 광고 검색어 리포트(2026-07-30~08-02)에서 나온 **US 수입자 의도** 코드.
 * 나머지 7 개는 `hsn code` 질의(인도 HSN)라 제외했다. 질의가 6 자리라 접두어다.
 */
const SEED_PREFIXES = ['711319', '39269'] as const

/**
 * 리스트별 발효일. `supabase/seed/duty_programs.csv` 와 같은 값이어야 한다 —
 * 페이지가 "언제부터" 를 말하는 근거이고, 원장과 갈라지면 그게 곧 거짓말이 된다.
 * section301_lists.json 에는 날짜가 없어서 여기 둔다.
 */
const LIST_EFFECTIVE: Record<string, string> = {
  list1: '2018-07-06',
  list2: '2018-08-23',
  list3: '2019-05-10',
  list4a: '2020-02-14',
}
const UNKNOWN_EFFECTIVE = '1900-01-01'

interface CatalogLine {
  code: string
  description: string
  adValorem: number | null
}

interface ListFile {
  lists: Array<{ list: string; provision: string; rate: number; active: boolean; codes: string[] }>
}

function loadCatalog(): CatalogLine[] {
  if (!existsSync(CATALOG)) {
    throw new Error(
      `${CATALOG} 가 없다. 먼저 npm run hts:fetch 로 USITC 카탈로그를 받을 것. ` +
        '부분 데이터로 뽑으면 웨이브 1 표본이 조용히 틀리고, 이후 발행이 전부 그 위에 쌓인다.',
    )
  }
  return JSON.parse(readFileSync(CATALOG, 'utf-8')) as CatalogLine[]
}

/**
 * 10 자리 카탈로그를 8 자리로 접는다.
 *
 * 세율은 8 자리에서 정해지므로 자식들의 adValorem 은 같아야 한다. 다른 값이
 * 섞이면 그 8 자리는 세율이 하나로 정해지지 않는다는 뜻이라 색인 대상에서
 * 빠져야 한다 (게이트 G2 가 null 로 걸러낸다).
 */
function foldToEightDigit(lines: CatalogLine[]): Map<string, { description: string; adValorem: number | null }> {
  const groups = new Map<string, CatalogLine[]>()
  for (const l of lines) {
    const code = l.code.replace(/\D/g, '')
    if (code.length < 8) continue
    const key = code.slice(0, 8)
    const g = groups.get(key)
    if (g) g.push(l)
    else groups.set(key, [l])
  }

  const out = new Map<string, { description: string; adValorem: number | null }>()
  for (const [code, g] of groups) {
    const rates = new Set(g.map((x) => x.adValorem))
    const adValorem = rates.size === 1 ? [...rates][0] : null
    // 설명은 가장 긴 것 — 조상 체인이 가장 많이 붙은 라인이 그 8 자리를 가장 잘 말한다
    const description = g.reduce((a, b) => (b.description.length > a.length ? b.description : a), '')
    out.set(code, { description, adValorem })
  }
  return out
}

function main() {
  const eight = foldToEightDigit(loadCatalog())

  const rateByCode = new Map<string, number>()
  const listByCode = new Map<string, string[]>()
  /** 리스트별 세율·조항·발효일. 페이지가 "언제부터" 를 말하려면 필요하다 */
  const listMeta = new Map<string, { rate: number; provision: string; effective_from: string }>()
  const lists = (JSON.parse(readFileSync(LISTS, 'utf-8')) as ListFile).lists
  for (const l of lists) {
    if (!l.active) continue // 만료된 리스트는 지금 세율에 안 붙는다
    listMeta.set(l.list, { rate: l.rate, provision: l.provision, effective_from: LIST_EFFECTIVE[l.list] ?? UNKNOWN_EFFECTIVE })
    for (const c of l.codes) {
      rateByCode.set(c, (rateByCode.get(c) ?? 0) + l.rate)
      listByCode.set(c, [...(listByCode.get(c) ?? []), l.list])
    }
  }

  const candidates: WaveCandidate[] = [...eight].map(([code, v]) => ({
    code,
    description: v.description,
    adValorem: v.adValorem,
    programs: listByCode.get(code) ?? [],
    programRate: rateByCode.get(code) ?? 0,
    demandRank: null,
  }))

  const blocked = candidates.filter((c) => !decidePage(c).indexable)
  const selected = selectWave(candidates, SEED_PREFIXES, { size: SIZE, maxPerChapter: MAX_PER_CHAPTER })

  const spread = [...chapterSpread(selected)].sort((a, b) => b[1] - a[1])
  console.log('── 웨이브 1 선정 ──────────────────────────────')
  console.log(`  8 자리 후보      ${candidates.length}`)
  console.log(`  게이트 탈락      ${blocked.length} (색인 제외 — 사이트맵에 안 넣는다)`)
  console.log(`  선정            ${selected.length} / ${SIZE}`)
  console.log(`  장 분포 상위     ${spread.slice(0, 6).map(([c, n]) => `${c}:${n}`).join(' ')}`)
  console.log(`  시드 포함        ${selected.filter((s) => SEED_PREFIXES.some((p) => s.code.startsWith(p))).length}`)

  if (selected.length < SIZE) {
    console.log(`\n  ⚠ ${SIZE} 를 못 채웠다 — maxPerChapter(${MAX_PER_CHAPTER}) 가 조이거나 게이트 탈락이 많다`)
  }

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generated_for: 'wave 1',
        policy: 'docs/seo-indexing-policy.md §5',
        size: selected.length,
        max_per_chapter: MAX_PER_CHAPTER,
        seed_prefixes: SEED_PREFIXES,
        seed_note: '광고 검색어 리포트(2026-07-30~08-02)의 US 수입자 의도 코드. hsn 질의는 제외했다.',
        as_of: new Date().toISOString().slice(0, 10),
        note: '이 파일이 발행 대상이다. build-hts-pages 는 카탈로그가 아니라 이걸 읽는다 — git diff 가 곧 무엇을 발행하는지의 기록이다.',
        codes: selected.map((s) => ({
          code: s.code,
          display: dotted(s.code),
          path: pagePath(s.code),
          description: s.description,
          ad_valorem: s.adValorem,
          program_rate: s.programRate,
          programs: s.programs.map((list) => {
            const meta = listMeta.get(list)
            if (!meta) throw new Error(`${s.code}: 리스트 ${list} 의 메타를 찾지 못했다`)
            return { list, rate: meta.rate, provision: meta.provision, effective_from: meta.effective_from }
          }),
          // 같은 6자리 안의 다른 8자리. 렌더러가 카탈로그 없이도 형제를 그릴 수 있게 여기 담는다
          siblings: [...eight.keys()].filter((c) => c !== s.code && c.slice(0, 6) === s.code.slice(0, 6)).sort().slice(0, 12),
        })),
      },
      null,
      2,
    ) + String.fromCharCode(10),
  )
  console.log(`\n→ ${OUT} — 발행 전 사람이 검수한다 (§5)`)
}

main()
