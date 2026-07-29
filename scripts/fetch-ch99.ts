/**
 * HTSUS Chapter 99 (Subchapter III) — Section 301 · IEEPA 조항 수집 → **관리자 확정용 워크시트**.
 *
 * 왜 자동 시드하지 않는가 (스펙 §4: "Section 301·IEEPA 레이어는 관리자가 수기 입력"):
 *
 *  1. **301 은 커버리지가 조항 본문에 없다.** 9903.88.01 은 "25%"라고만 말하고,
 *     어떤 8자리 HTS 가 List 1 인지는 "U.S. note 20(a)" 의 열거 목록에 있다.
 *     그 note 는 이 export 에 들어 있지 않다. 즉 세율은 알아도 **적용 대상을 모른다**.
 *     현재 시드의 4자리 301 행(3924, 4202, …)은 구조적으로 틀렸다 — 301 은 호 전체가
 *     아니라 8자리 라인 단위로 지정된다.
 *  2. **IEEPA 는 프로그램이 겹친다.** 중국은 9903.01.20/24(펜타닐 IEEPA 10%)와
 *     9903.02.xx(상호관세)가 별도로 존재하고, 발효일·경유화물 예외가 조항마다 다르다.
 *     어느 조합이 적용되는지는 사람이 판단해야 한다.
 *
 * 그래서 이 스크립트는 **공식 원문·세율·인용을 정리해 주고 입력은 사람이 한다.**
 * 워크시트에서 확정한 값을 `supabase/seed/hts_seed_50.csv` 의 301·IEEPA 행에
 * 옮겨 적고 `npm run seed:rates` 로 적재한다.
 *
 * 실행: npm run hts:ch99
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const RAW = join(root, 'data/hts_ch99.json')

interface Ch99Row {
  htsno: string
  indent: string
  description: string
  general: string
}

export interface Provision {
  code: string
  /** 계층 조상에서 끌어온 적용 대상 (국가명 또는 리스트 설명) */
  scope: string
  /** general 원문 */
  general: string
  /** 종가 추가세율. 파싱 실패 시 null */
  addedRate: number | null
  /** 커버리지를 정의하는 U.S. note 참조 (예: "U.S. note 20(a)") */
  noteRef: string | null
  description: string
}

const parseAdded = (g: string): number | null => {
  const m = (g ?? '').match(/(?:plus|\+)\s*([\d.]+)\s*%/i)
  return m ? Number(m[1]) / 100 : null
}
const parseNote = (d: string): string | null => {
  const m = (d ?? '').match(/U\.S\. note (\d+)\(([a-z]+)\)/i)
  if (m) return `U.S. note ${m[1]}(${m[2]})`
  const m2 = (d ?? '').match(/subdivision \(([a-z]+)\) of U\.S\. note (\d+)/i)
  return m2 ? `U.S. note ${m2[2]}(${m2[1]})` : null
}

/** 조상 체인에서 국가명·리스트명을 끌어온다 (조항 본문은 예외 보일러플레이트로 시작하는 경우가 많다) */
export function buildProvisions(rows: Ch99Row[]): Provision[] {
  const stack: Array<{ indent: number; text: string }> = []
  const out: Provision[] = []
  for (const row of rows) {
    const indent = Number(row.indent) || 0
    const text = (row.description ?? '').trim()
    if (!text) continue
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
    stack.push({ indent, text })

    const code = (row.htsno ?? '').trim()
    if (!code) continue

    // 적용 대상은 본문 끝의 "articles the product of X" 절에 있다.
    // 조항 본문은 경유화물 예외 보일러플레이트로 시작하므로 앞부분이 아니라
    // 이 절을 봐야 국가명이 나온다 (9903.02.26 → India).
    const m = text.match(/articles the product of ([^,]+?)(?:,| as provided)/i)
    const scope =
      m?.[1].trim() ??
      stack
        .slice(0, -1)
        .map((x) => x.text)
        .filter((t) => t.length < 90 && !/^Except/i.test(t))
        .pop() ??
      ''

    out.push({
      code,
      scope,
      general: (row.general ?? '').trim(),
      addedRate: parseAdded(row.general),
      noteRef: parseNote(row.description),
      description: text,
    })
  }
  return out
}

async function fetchCh99(): Promise<Ch99Row[]> {
  if (existsSync(RAW)) return JSON.parse(readFileSync(RAW, 'utf-8'))
  const res = await fetch('https://hts.usitc.gov/reststop/exportList?from=9901&to=9999&format=JSON&styles=false', {
    signal: AbortSignal.timeout(180_000),
  })
  if (!res.ok) throw new Error(`USITC ch99 HTTP ${res.status}`)
  const rows = (await res.json()) as Ch99Row[]
  mkdirSync(join(root, 'data'), { recursive: true })
  writeFileSync(RAW, JSON.stringify(rows), 'utf-8')
  return rows
}

async function main() {
  const rows = await fetchCh99()
  const provisions = buildProvisions(rows)

  const s301 = provisions.filter((p) => p.code.startsWith('9903.88') && p.addedRate !== null)
  const ieepaCountry = provisions.filter((p) => /^9903\.02\./.test(p.code) && p.addedRate !== null)
  const ieepaOther = provisions.filter((p) => /^9903\.01\./.test(p.code) && p.addedRate !== null)

  writeFileSync(
    join(root, 'data/ch99_provisions.json'),
    JSON.stringify({ fetched: 'USITC HTS Chapter 99 export', s301, ieepaCountry, ieepaOther }, null, 2),
    'utf-8',
  )

  // ── 워크시트 ────────────────────────────────────────────────
  const L: string[] = []
  const p = (s = '') => L.push(s)
  p('# Section 301 · IEEPA 확정 워크시트')
  p()
  p('출처: USITC HTS **Chapter 99, Subchapter III** 공식 export (`https://hts.usitc.gov/reststop/exportList`).')
  p('생성: `npm run hts:ch99` ([scripts/fetch-ch99.ts](../../scripts/fetch-ch99.ts))')
  p()
  p('> ⚠️ **이 문서는 자동으로 원장에 들어가지 않는다.** 스펙 §4 대로 301·IEEPA 는 관리자가 수기 입력한다.')
  p('> 아래 세율은 공식 조항에서 뽑은 값이지만, **적용 대상 판정은 사람이 해야 한다** (아래 이유 참조).')
  p()

  p('## 왜 자동 적재가 불가능한가')
  p()
  p('**1. 301 은 세율은 조항에, 적용 대상은 note 에 있다.**')
  p('`9903.88.01` 은 "+25%"라고만 말하고, 어떤 8자리 HTS 가 List 1 인지는 `U.S. note 20(a)` 의')
  p('열거 목록에 있다. 그 note 본문은 이 export 에 포함되지 않는다 — 세율은 알아도 **대상을 모른다**.')
  p()
  p('**2. 현재 시드의 4자리 301 행은 구조적으로 틀렸다.**')
  p('`3924,CN,section301,0.25` 처럼 호(4자리) 전체에 25%를 매겼는데, 301 은 호 단위가 아니라')
  p('**8자리 라인 단위**로 지정된다. 같은 호 안에서도 List 3(25%)·List 4A(7.5%)·미지정이 섞인다.')
  p()
  p('**3. IEEPA 는 프로그램이 겹친다.**')
  p('중국은 `9903.01.20`/`9903.01.24`(펜타닐 IEEPA, +10%)와 `9903.02.xx`(상호관세)가 별도로 있고,')
  p('조항마다 발효일·경유화물 예외가 다르다. 어느 조합이 적용되는지는 사람이 판단한다.')
  p()

  p('## Section 301 — 조항별 추가세율')
  p()
  p('| 조항 | 추가세율 | 적용 대상 정의 | 비고 |')
  p('|---|---|---|---|')
  for (const x of s301) {
    p(`| \`${x.code}\` | **+${((x.addedRate as number) * 100).toFixed(1)}%** | ${x.noteRef ?? '—'} | ${x.scope || x.description.slice(0, 70)} |`)
  }
  p()
  p('확정 절차: 각 SKU 의 **8자리** HTS 를 위 note 의 열거 목록에서 찾아 해당 조항의 세율을 적는다.')
  p('note 원문: <https://hts.usitc.gov/> → Chapter 99 → Subchapter III → U.S. Notes.')
  p()

  p('## IEEPA — 국가별 상호관세 (9903.02.xx)')
  p()
  p('원장 구조와 1:1로 맞는다 (`hts_code=*`, `origin_country=XX`).')
  p()
  p('| 조항 | 국가 | 추가세율 |')
  p('|---|---|---|')
  for (const x of ieepaCountry) {
    p(`| \`${x.code}\` | ${x.scope || '(상위 행 확인 필요)'} | **+${((x.addedRate as number) * 100).toFixed(0)}%** |`)
  }
  p()

  p('## IEEPA — 기타 프로그램 (9903.01.xx)')
  p()
  p('| 조항 | 추가세율 | 적용 대상 |')
  p('|---|---|---|')
  for (const x of ieepaOther) {
    p(`| \`${x.code}\` | +${((x.addedRate as number) * 100).toFixed(0)}% | ${x.description.slice(0, 110)} |`)
  }
  p()
  p('---')
  p()
  p('## 확정한 값 적재')
  p()
  p('`supabase/seed/hts_seed_50.csv` 의 301·IEEPA 행을 위 값으로 교체하고:')
  p()
  p('```bash')
  p('SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run seed:rates')
  p('```')
  p()
  p('`source` 컬럼에 조항 번호를 적어 감사 추적을 남길 것 (예: `HTSUS 9903.88.03`).')

  const outPath = join(root, 'supabase/seed/ch99_worksheet.md')
  writeFileSync(outPath, `${L.join('\n')}\n`, 'utf-8')

  console.log('── HTSUS Chapter 99 (301 · IEEPA) ──────────────')
  console.log(`전체 조항:        ${provisions.length}`)
  console.log(`301 (세율 추출):  ${s301.length}`)
  console.log(`IEEPA 국가별:     ${ieepaCountry.length}`)
  console.log(`IEEPA 기타:       ${ieepaOther.length}`)
  console.log('')
  console.log('→ supabase/seed/ch99_worksheet.md  (관리자 확정용)')
  console.log('→ data/ch99_provisions.json')
  console.log('')
  console.log('⚠ 원장에 자동 적재하지 않았다 — 301 커버리지는 U.S. note 열거 목록이 필요하고,')
  console.log('  IEEPA 는 프로그램이 겹쳐 사람 판단이 필요하다 (스펙 §4).')
}

if (process.argv[1]?.endsWith('fetch-ch99.ts')) main()
