/**
 * USITC 공식 HTS 데이터 수집 → 라인 카탈로그 + base MFN 세율.
 *
 * 스펙 §4: "rate 원장 초기 데이터: USITC HTS 공식 데이터(hts.usitc.gov, JSON/CSV 제공)에서
 * base MFN 시드. Section 301·IEEPA 레이어는 관리자가 수기 입력(자동 스크래핑 금지)"
 * → 여기서 가져오는 것은 USITC 공식 export 뿐이다. 301·IEEPA 는 건드리지 않는다.
 *
 * 산출물:
 *   data/hts_lines.json      전체 10자리 라인 (코드·조립된 설명·MFN) — gitignore
 *   data/hts_lines.meta.json 수집 메타 (건수·날짜·출처) — 커밋
 *
 * 설명 조립: USITC export 는 계층형이라 10자리 라인의 description 이 "Other" 뿐인 경우가 많다.
 * indent 로 조상을 거슬러 올라가 "부모 > 자식" 으로 이어붙여야 분류에 쓸 수 있는 문장이 된다.
 *
 * 실행: npm run hts:fetch
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(root, 'data')

interface UsitcRow {
  htsno: string
  indent: string
  description: string
  superior: string | null
  units: string[]
  general: string
  special: string
  other: string
}

export interface HtsLine {
  /** 숫자만 10자리 */
  code: string
  /** 4자리 호 */
  heading: string
  /** 조상 설명을 이어붙인 전체 문장 */
  description: string
  /** 그 라인 자체의 설명 (마지막 마디) */
  leaf: string
  /** USITC general(MFN) 원문 — "Free", "9.8%", "3.9¢/kg" 등 */
  general: string
  /** general 이 자기 행에 없어 상위 라인에서 물려받았는지 */
  generalInherited: boolean
  /** 종가세로 해석된 값. 종량세·복합세면 null (MVP 는 종가세만, README 주의사항) */
  adValorem: number | null
  units: string[]
}

/** "Free" → 0, "9.8%" → 0.098, 종량세·복합세 → null */
export function parseAdValorem(general: string): number | null {
  const g = general.trim()
  if (g === '' ) return null
  if (/^free$/i.test(g)) return 0
  // 순수 종가세만 허용: "9.8%" / "9.8 %" — 앞뒤에 ¢·$ 등이 붙으면 복합세로 보고 제외
  const m = g.match(/^(\d+(?:\.\d+)?)\s*%$/)
  if (!m) return null
  return Number(m[1]) / 100
}

async function fetchChapter(ch: number): Promise<UsitcRow[]> {
  const c = String(ch).padStart(2, '0')
  const url = `https://hts.usitc.gov/reststop/exportList?from=${c}01&to=${c}99&format=JSON&styles=false`
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as UsitcRow[]
    } catch (e) {
      if (attempt === 3) throw new Error(`chapter ${c} 실패: ${e}`)
      await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
  return []
}

/**
 * 계층 설명 조립.
 * indent 가 깊어지면 스택에 쌓고, 같거나 얕아지면 그만큼 걷어낸 뒤 현재 마디를 얹는다.
 * htsno 가 빈 행(장·절 제목, "superior" 행)도 조상으로는 유효하다.
 */
export function buildLines(rows: UsitcRow[]): HtsLine[] {
  const stack: Array<{ indent: number; text: string; general: string }> = []
  const out: HtsLine[] = []

  for (const row of rows) {
    const indent = Number(row.indent) || 0
    const text = (row.description ?? '').trim()
    if (!text) continue

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
    const own = (row.general ?? '').trim()
    stack.push({ indent, text, general: own })

    const digits = (row.htsno ?? '').replace(/\D/g, '')
    if (digits.length !== 10) continue

    // 세율 상속: 10자리 행이 비어 있으면 세율이 8자리 등 상위에 적혀 있다.
    // 가장 가까운 조상의 general 을 물려받는다 (USITC 표기 관행).
    let general = own
    let inherited = false
    if (!general) {
      for (let i = stack.length - 2; i >= 0; i--) {
        if (stack[i].general) {
          general = stack[i].general
          inherited = true
          break
        }
      }
    }

    // 조상 체인에서 로마숫자 절 제목(전부 대문자) 은 노이즈라 제외
    const chain = stack.filter((s) => !/^[IVX]+\.\s/.test(s.text)).map((s) => s.text)
    out.push({
      code: digits,
      heading: digits.slice(0, 4),
      description: chain.join(' > '),
      leaf: text,
      general,
      generalInherited: inherited,
      adValorem: parseAdValorem(general),
      units: row.units ?? [],
    })
  }
  return out
}

async function main() {
  const chapters = Array.from({ length: 97 }, (_, i) => i + 1).filter((c) => c !== 77) // 77 은 유보 장
  const all: HtsLine[] = []
  let failed: number[] = []

  // 동시 4장씩 — USITC 서버 부담을 줄이면서 전체 5~10분 내
  for (let i = 0; i < chapters.length; i += 4) {
    const wave = chapters.slice(i, i + 4)
    const results = await Promise.all(
      wave.map(async (ch) => {
        try {
          return { ch, lines: buildLines(await fetchChapter(ch)) }
        } catch (e) {
          console.error(`  ch${ch} 실패: ${e}`)
          return { ch, lines: [] as HtsLine[] }
        }
      }),
    )
    for (const r of results) {
      if (r.lines.length === 0) failed.push(r.ch)
      all.push(...r.lines)
    }
    console.log(`  ${Math.min(i + 4, chapters.length)}/${chapters.length} 장 · 누적 ${all.length} 라인`)
  }

  // 중복 코드 제거 (같은 코드가 여러 번 나오면 첫 번째 유지)
  const seen = new Set<string>()
  const lines = all.filter((l) => (seen.has(l.code) ? false : (seen.add(l.code), true)))

  const adValoremCount = lines.filter((l) => l.adValorem !== null).length
  const headings = new Set(lines.map((l) => l.heading))

  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, 'hts_lines.json'), JSON.stringify(lines), 'utf-8')
  const meta = {
    source: 'https://hts.usitc.gov/reststop/exportList (USITC 공식 export)',
    fetched_chapters: chapters.length,
    failed_chapters: failed,
    line_count: lines.length,
    heading_count: headings.size,
    ad_valorem_count: adValoremCount,
    non_ad_valorem_count: lines.length - adValoremCount,
    note: '종량세·복합세 라인은 adValorem=null — MVP 는 종가세만 지원 (README 주의사항)',
  }
  writeFileSync(join(OUT_DIR, 'hts_lines.meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf-8')

  console.log('── USITC HTS 카탈로그 ──────────────────────────')
  console.log(`10자리 라인:   ${lines.length.toLocaleString()}`)
  console.log(`4자리 호:      ${headings.size.toLocaleString()}`)
  console.log(`종가세 파싱됨: ${adValoremCount.toLocaleString()} (${((adValoremCount / lines.length) * 100).toFixed(1)}%)`)
  console.log(`종량·복합세:   ${(lines.length - adValoremCount).toLocaleString()} → adValorem=null`)
  if (failed.length > 0) console.log(`⚠ 실패한 장: ${failed.join(', ')}`)
  console.log(`→ data/hts_lines.json (${(JSON.stringify(lines).length / 1e6).toFixed(1)} MB)`)
  if (failed.length > 0) process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('fetch-hts-catalog.ts')) {
  main()
}
