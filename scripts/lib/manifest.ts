/**
 * 원장 매니페스트 — 드리프트 탐지 계층 (백로그 A-2).
 *
 * ── 왜 있는가 ────────────────────────────────────────────────────
 * 0021·0022 가 급한 불(중복·아카이브 임의 삭제)을 DB 에서 막는다. 하지만 둘 다
 * **그 경로를 통과할 때만** 막는다. SQL Editor 는 이 저장소에서 실제로 쓰이는
 * 경로이고, `set local app.allow_archive_edit = 'on'` 이라는 탈출구도 열려 있다.
 * 즉 원장이 조용히 달라질 수 있는 길이 남아 있다.
 *
 * 매니페스트는 그 위의 탐지 계층이다. 프로그램별 행수와 해시를 커밋해 두고,
 * DB 를 다시 읽어 대조한다. 다르면 "언제 무엇이 달라졌는지" 가 git diff 로 남는다.
 *
 * ── 왜 지금 우선순위가 올라갔는가 ────────────────────────────────
 * docs/seo-indexing-policy.md §7: 코드 페이지를 발행하면 원장 오류의 폭발 반경이
 * "조회한 사용자 한 명" 에서 "11,000 개 공개 페이지가 틀린 채 구글에 캐시된다"
 * 로 바뀐다. 되돌리는 비용이 비대칭이라 탐지가 발행보다 먼저 있어야 한다.
 *
 * ── 시간 의존성이라는 함정 ───────────────────────────────────────
 * 아카이브 경계는 `effective_to <= today` 라 **날짜에 따라 움직인다**. 매니페스트를
 * 만든 날과 대조하는 날이 다르면, 아무도 원장을 건드리지 않았는데 행이 active 에서
 * archive 로 넘어가 드리프트로 보인다. 거짓 경보를 내는 탐지기는 곧 꺼진다.
 *
 * 그래서 `as_of` 를 매니페스트에 **박아 두고**, 대조할 때도 그 날짜를 쓴다. 날짜가
 * 바뀌어 생기는 이동은 매니페스트를 새로 만들 때만 반영되고, 그건 사람이 보는
 * 변경이다.
 */
import { createHash } from 'node:crypto'
import { isArchived } from './db'

/** 대조에 쓰는 원장 행. PostgREST select 로 가져오는 컬럼과 같다. */
export interface LedgerRow {
  program_code: string
  hts_code: string
  origin_country: string | null
  ad_valorem_rate: number | string
  effective_from: string
  effective_to: string | null
}

export interface SectionEntry {
  rows: number
  /** 코드 집합(program_code·hts_code·origin_country)의 해시 — **구성원**이 바뀌면 달라진다 */
  codes_sha256: string
  /** 세율·발효일까지 포함한 해시 — **값**이 바뀌면 달라진다 */
  rows_sha256: string
}

export interface LedgerManifest {
  /** 아카이브 경계 판정에 쓴 날짜. 대조할 때도 이 값을 쓴다 (위 함정 참고) */
  as_of: string
  generated_note: string
  totals: { rows: number; active: number; archive: number; programs: number }
  /** 아직 만료되지 않은 행 */
  active: Record<string, SectionEntry>
  /** 만료된 행 — 사라지면 과거 선적을 재계산할 수 없다 (0022) */
  archive: Record<string, SectionEntry>
}

const sha = (parts: string[]) => createHash('sha256').update(parts.join('\n')).digest('hex')

/** 세율은 numeric 이라 PostgREST 가 문자열로 줄 수 있다. 표기 차이로 해시가 흔들리지 않게 정규화한다. */
function rate(v: number | string): string {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) throw new Error(`ad_valorem_rate 를 숫자로 읽지 못했다: ${JSON.stringify(v)}`)
  return n.toFixed(6)
}

const codeKey = (r: LedgerRow) => `${r.program_code}|${r.hts_code}|${r.origin_country ?? '*'}`
const rowKey = (r: LedgerRow) => `${codeKey(r)}|${rate(r.ad_valorem_rate)}|${r.effective_from}|${r.effective_to ?? ''}`

function section(rows: LedgerRow[]): Record<string, SectionEntry> {
  const byProgram = new Map<string, LedgerRow[]>()
  for (const r of rows) {
    const g = byProgram.get(r.program_code)
    if (g) g.push(r)
    else byProgram.set(r.program_code, [r])
  }
  const out: Record<string, SectionEntry> = {}
  // 프로그램 이름 순 — 행 순서가 아니라 내용이 해시를 정한다 (PostgREST 정렬에 기대지 않는다)
  for (const code of [...byProgram.keys()].sort()) {
    const g = byProgram.get(code)!
    out[code] = {
      rows: g.length,
      codes_sha256: sha(g.map(codeKey).sort()),
      rows_sha256: sha(g.map(rowKey).sort()),
    }
  }
  return out
}

export function buildManifest(rows: readonly LedgerRow[], asOf: string): LedgerManifest {
  const active: LedgerRow[] = []
  const archive: LedgerRow[] = []
  for (const r of rows) (isArchived(r.effective_to, asOf) ? archive : active).push(r)

  const a = section(active)
  const b = section(archive)
  return {
    as_of: asOf,
    generated_note:
      'rate_ledger 드리프트 탐지용. 갱신: npm run ledger:manifest — 대조: npm run ledger:verify. ' +
      'as_of 는 아카이브 경계 판정 기준일이며 대조 시에도 이 값을 쓴다.',
    totals: {
      rows: rows.length,
      active: active.length,
      archive: archive.length,
      programs: new Set([...Object.keys(a), ...Object.keys(b)]).size,
    },
    active: a,
    archive: b,
  }
}

export interface Drift {
  section: 'active' | 'archive'
  program: string
  kind: 'added' | 'removed' | 'rows' | 'membership' | 'values'
  detail: string
}

/**
 * 커밋된 매니페스트와 방금 만든 것을 비교한다.
 *
 * 구성원 변화와 값 변화를 나눠서 보고한다 — "코드가 빠졌다" 와 "세율이 바뀌었다"
 * 는 대응이 완전히 다르고, 한 덩어리로 뭉치면 어느 쪽인지 알려면 결국 DB 를
 * 다시 뒤져야 한다.
 */
export function diffManifest(committed: LedgerManifest, current: LedgerManifest): Drift[] {
  const out: Drift[] = []
  for (const s of ['active', 'archive'] as const) {
    const was = committed[s]
    const now = current[s]
    for (const p of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort()) {
      const a = was[p]
      const b = now[p]
      if (!a) { out.push({ section: s, program: p, kind: 'added', detail: `새 프로그램 (${b.rows}행)` }); continue }
      if (!b) { out.push({ section: s, program: p, kind: 'removed', detail: `사라졌다 (${a.rows}행이었다)` }); continue }
      if (a.rows !== b.rows) out.push({ section: s, program: p, kind: 'rows', detail: `행수 ${a.rows} → ${b.rows}` })
      if (a.codes_sha256 !== b.codes_sha256) {
        out.push({ section: s, program: p, kind: 'membership', detail: '코드 집합이 달라졌다' })
      } else if (a.rows_sha256 !== b.rows_sha256) {
        // 구성원이 같은데 값이 다르면 세율·발효일이 바뀐 것이다
        out.push({ section: s, program: p, kind: 'values', detail: '세율 또는 발효일이 달라졌다' })
      }
    }
  }
  return out
}
