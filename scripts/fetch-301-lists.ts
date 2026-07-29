/**
 * 중국 Section 301 리스트 적재 — HTSUS Chapter 99, U.S. note 20 원문 파싱.
 *
 * ── 왜 이 경로인가 ────────────────────────────────────────────────
 * 1순위는 USITC 라인별 export 의 footnote/additionalDuties 였다. 실측 결과
 * 그 필드에는 9903.90.08/09(Section 232 파생 철강·알루미늄) 만 들어 있고
 * **9903.88(301) 참조는 한 건도 없다** (ch.42/73/84/85 전수 확인).
 * 그래서 2순위인 Chapter 99 공식 PDF 의 U.S. note 20 을 파싱한다.
 * 같은 USITC 공식 배포물이므로 base MFN 과 동일한 허용 경로다.
 *
 * ── 소절 → 리스트 대응 (원문으로 확인) ────────────────────────────
 *   note 20(b)    → heading 9903.88.01  List 1   +25%
 *   note 20(d)    → heading 9903.88.02  List 2   +25%
 *   note 20(f)    → heading 9903.88.03  List 3   +25%
 *   note 20(s)(i) → heading 9903.88.15  List 4A  +7.5%
 *
 * (s)(ii) 는 8자리 열거가 아니라 서술형 품목 정의다("Other printed books …
 * provided for in subheading 4901.99.00, except for …"). 기계적으로 8자리로
 * 환원할 수 없으므로 **적용하지 않고 미확정으로 남긴다.**
 *
 * 2024 4년 재검토 인상(9903.91.xx — EV·반도체·태양광·배터리 등)은 이번 범위
 * 밖이다. 다만 해당 라인을 조용히 낮은 세율로 통과시키면 안 되므로 별도로
 * 뽑아 "301 미확정" 표시용으로 남긴다.
 *
 * ── 검증 ─────────────────────────────────────────────────────────
 * 파싱한 모든 코드가 USITC 8자리 카탈로그에 실존하는지 대조한다. 다단 레이아웃
 * 이 어긋나면 존재하지 않는 코드가 생기므로, 이 대조가 파싱 오류의 탐지기다.
 *
 * 선행: npm run hts:fetch (data/hts_lines.json)
 * 필요: pdftotext (poppler). 없으면 명확히 실패한다.
 * 실행: npm run hts:301
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(root, 'data')
const PDF = join(DATA, 'hts_ch99.pdf')
const TXT = join(DATA, 'hts_ch99.txt')
const CH99_URL = 'https://hts.usitc.gov/reststop/file?release=currentRelease&filename=Chapter%2099'

/** 소절 → (리스트 이름, 9903 조항, 가산율) */
const LISTS = [
  { sub: 'b', list: 'list1', provision: '9903.88.01', rate: 0.25, active: true },
  { sub: 'd', list: 'list2', provision: '9903.88.02', rate: 0.25, active: true },
  { sub: 'f', list: 'list3', provision: '9903.88.03', rate: 0.25, active: true },
  { sub: 's', list: 'list4a', provision: '9903.88.15', rate: 0.075, active: true, romanPart: 'i' },
  // List 4B — 원문이 명시적으로 정지시켰다:
  //   "[Compiler's note: Subdivisions (t) and (u) of this note and heading 9903.88.16 suspended.]"
  // 적용하지 않지만 **반드시 따로 기록한다.** 이 목록에만 있는 라인은 "미확인"이 아니라
  // "확인된 0%"다. 골든 SKU 대부분(머그·팬·텀블러·도마·주방용품)이 여기 속한다.
  { sub: 'u', list: 'list4b', provision: '9903.88.16', rate: 0.15, active: false },
] as const

const CODE_RE = /\b(\d{4})\.(\d{2})\.(\d{2})\b/g

async function ensureText(): Promise<string> {
  if (existsSync(TXT)) {
    console.log(`텍스트 재사용: ${TXT}`)
    return readFileSync(TXT, 'utf-8')
  }
  mkdirSync(DATA, { recursive: true })
  if (!existsSync(PDF)) {
    console.log('Chapter 99 PDF 다운로드…')
    const res = await fetch(CH99_URL, { signal: AbortSignal.timeout(300_000) })
    if (!res.ok) throw new Error(`USITC ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.subarray(0, 4).toString() !== '%PDF') throw new Error('PDF 가 아니다 — 엔드포인트 변경 의심')
    writeFileSync(PDF, buf)
    console.log(`  ${PDF} (${(buf.length / 1e6).toFixed(1)} MB)`)
  }
  try {
    execFileSync('pdftotext', ['-layout', PDF, TXT], { stdio: 'pipe' })
  } catch {
    throw new Error(
      'pdftotext 를 실행할 수 없다. poppler-utils 를 설치하거나, 직접 추출한 텍스트를 ' +
        `${TXT} 에 두고 다시 실행할 것.`,
    )
  }
  return readFileSync(TXT, 'utf-8')
}

/** note 20 본문의 시작 줄 (0-indexed) */
function findNote20(lines: string[]): number {
  const i = lines.findIndex((l) => /^\s{0,6}20\.\s*\(a\)\s+For the purposes of heading 9903\.88\.01/.test(l))
  if (i < 0) throw new Error('U.S. note 20(a) 를 찾지 못했다 — PDF 구조가 바뀌었다')
  return i
}

/**
 * note 20 안에서 소절 `(tag)` 의 줄 범위를 찾는다.
 *
 * 소절 마커는 줄 왼쪽 여백 뒤의 `(x)` 다. 다음 소절 마커까지가 본문이다.
 * 같은 표기가 본문 중간에 인용으로 나오기도 해서(예: "U.S. note 20(b) to
 * subchapter III"), **줄 시작** 위치만 마커로 인정한다.
 */
function subdivisionRange(lines: string[], from: number, tag: string): [number, number] {
  const marker = (l: string) => l.match(/^\s{0,14}\(([a-z]{1,4}|i{1,3}v?|iv)\)\s/)
  let start = -1
  for (let i = from; i < lines.length; i++) {
    const m = marker(lines[i])
    if (m && m[1] === tag) {
      start = i
      break
    }
  }
  if (start < 0) throw new Error(`note 20(${tag}) 를 찾지 못했다`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const m = marker(lines[i])
    if (m && m[1] !== tag) {
      end = i
      break
    }
  }
  return [start, end]
}

interface ParsedList {
  list: string
  provision: string
  rate: number
  /** false = 원문이 정지시킨 목록 (적용 금지, 기록만) */
  active: boolean
  codes: string[]
  /** 소절 인용문 — 수기 대조용 */
  citation: string
}

function parseList(lines: string[], note20: number, spec: (typeof LISTS)[number]): ParsedList {
  let [start, end] = subdivisionRange(lines, note20, spec.sub)
  // (s) 는 (i)/(ii) 로 다시 갈라진다. 8자리 열거는 (i) 뿐이다.
  if ('romanPart' in spec && spec.romanPart) {
    ;[start, end] = subdivisionRange(lines, start + 1, spec.romanPart)
  }
  const body = lines.slice(start, end)

  // 헤더 문장(첫 줄)에는 "8-digit subheadings" 안내와 조항 번호가 섞여 있다.
  // 그 줄의 9903.xx 인용을 코드로 오인하지 않도록 9903 으로 시작하는 건 제외한다.
  const codes = new Set<string>()
  for (const line of body) {
    // 페이지 머리말 제거
    if (/Harmonized Tariff Schedule of the United States/.test(line)) continue
    for (const m of line.matchAll(CODE_RE)) {
      const code = m[1] + m[2] + m[3]
      if (code.startsWith('9903')) continue // 조항 자기 인용
      if (code.startsWith('99')) continue // 챕터 99 는 실체 상품이 아니다
      codes.add(code)
    }
  }
  return {
    list: spec.list,
    provision: spec.provision,
    rate: spec.rate,
    active: spec.active,
    codes: [...codes].sort(),
    citation: `HTSUS ch.99 subch.III U.S. note 20(${spec.sub}${'romanPart' in spec && spec.romanPart ? `)(${spec.romanPart}` : ''}) · ${spec.provision}`,
  }
}

/** 2024 4년 재검토(9903.91.xx)가 건드리는 8자리 — 이번 범위 밖, 미확정 표시용 */
function parseReview2024(lines: string[]): string[] {
  const codes = new Set<string>()
  // 9903.91.xx 를 규정하는 note 는 31 번대다. 조항 본문에 8자리가 직접 열거되는
  // 경우도 있어, 9903.91 언급 줄 주변을 넓게 훑는 대신 note 31~34 범위를 본다.
  const start = lines.findIndex((l) => /^\s{0,6}3[1-9]\.\s*\(a\)/.test(l))
  if (start < 0) return []
  const end = Math.min(lines.length, start + 4000)
  for (let i = start; i < end; i++) {
    if (!/9903\.91|following 8-digit|subheading/.test(lines[i])) continue
    for (const m of lines[i].matchAll(CODE_RE)) {
      const code = m[1] + m[2] + m[3]
      if (code.startsWith('99')) continue
      codes.add(code)
    }
  }
  return [...codes].sort()
}

async function main() {
  const text = await ensureText()
  const lines = text.split('\n')
  const note20 = findNote20(lines)
  console.log(`U.S. note 20 시작: ${note20 + 1} 행`)
  console.log()

  // ── USITC 8자리 카탈로그 (검증용) ────────────────────────────────
  const catPath = join(DATA, 'hts_lines.json')
  if (!existsSync(catPath)) throw new Error('data/hts_lines.json 이 없다 — npm run hts:fetch 먼저')
  const cat = JSON.parse(readFileSync(catPath, 'utf-8')) as Array<{ code: string }>
  const eight = new Set(cat.map((l) => l.code.slice(0, 8)))
  console.log(`카탈로그 8자리 소호: ${eight.size.toLocaleString()}개 (10자리 ${cat.length.toLocaleString()}행)`)
  console.log()

  const parsed = LISTS.map((s) => parseList(lines, note20, s))
  const review = parseReview2024(lines)

  console.log('── 파싱 결과 ────────────────────────────────────────')
  let bad = 0
  for (const p of parsed) {
    const missing = p.codes.filter((c) => !eight.has(c))
    bad += missing.length
    console.log(
      `  ${p.list.padEnd(7)} ${p.provision}  ${String(p.codes.length).padStart(5)}개  ` +
        `가산 ${(p.rate * 100).toFixed(1)}%${p.active ? '        ' : ' (정지)'}  미존재 ${missing.length}개` +
        (missing.length ? ` → ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ' …' : ''}` : ''),
    )
  }
  console.log(`  ${'2024재검토'.padEnd(7)} 9903.91.xx  ${String(review.length).padStart(5)}개  (범위 밖 — 미확정 표시용)`)
  console.log()

  // 리스트 간 중복 — 원칙적으로 없어야 한다 (한 라인은 한 리스트)
  const seen = new Map<string, string>()
  const dupes: string[] = []
  for (const p of parsed.filter((x) => x.active)) {
    for (const c of p.codes) {
      if (seen.has(c)) dupes.push(`${c} (${seen.get(c)} ↔ ${p.list})`)
      else seen.set(c, p.list)
    }
  }
  console.log(`리스트 간 중복: ${dupes.length}건${dupes.length ? ' → ' + dupes.slice(0, 5).join(', ') : ''}`)
  console.log(`적용 대상 8자리(정지 제외): ${seen.size.toLocaleString()}개 (전체 소호의 ${((seen.size / eight.size) * 100).toFixed(1)}%)`)

  const out = {
    fetched_at: new Date().toISOString().slice(0, 10),
    source: CH99_URL,
    source_note: 'HTSUS Chapter 99 Subchapter III, U.S. note 20 (USITC 공식 배포 PDF)',
    catalog_8digit: eight.size,
    lists: parsed.map((p) => ({ ...p, missing_in_catalog: p.codes.filter((c) => !eight.has(c)) })),
    review_2024_excluded: review,
  }
  writeFileSync(join(DATA, 'section301_lists.json'), JSON.stringify(out, null, 2))
  console.log()
  console.log('→ data/section301_lists.json')
  if (bad > 0) {
    console.log()
    console.log(`⚠ 카탈로그에 없는 코드가 ${bad}개 있다. 다단 레이아웃 파싱 오류일 수 있으니`)
    console.log('  적재 전에 section301_lists.json 의 missing_in_catalog 를 확인할 것.')
  }
}

main()
