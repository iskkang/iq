/**
 * 마이그레이션 SQL 에서 최종 테이블·컬럼 상태를 뽑는다.
 *
 * check-schema(참조 테이블 규칙)와 check-docs(문서가 인용한 테이블·컬럼 실존)가
 * **같은 파서 한 벌**을 쓴다. 두 벌이 되면 한쪽만 고쳐져 서로 다른 답을 낸다 —
 * 이 저장소가 반복해서 당한 실패다.
 *
 * 정적 파싱이므로 **선언**만 본다. SQL Editor 로 직접 바꾼 것은 보이지 않는다.
 * 실제 DB 대조는 SOP 분기 점검의 information_schema 실조회가 담당한다.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const MIG = join(root, 'supabase/migrations')

/** 테이블명 → 컬럼 집합 (create + alter add 를 파일명 순서대로 누적) */
export function collectTables(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>()
  const files = readdirSync(MIG)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const f of files) {
    const sql = readFileSync(join(MIG, f), 'utf-8')

    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.(\w+)\s*\(([\s\S]*?)\n\)\s*;/gi)) {
      const cols = new Set<string>()
      for (const line of m[2].split('\n')) {
        const t = line.trim()
        if (!t || t.startsWith('--')) continue
        if (/^(primary|unique|check|foreign|constraint|exclude)\b/i.test(t)) continue
        const c = t.match(/^"?(\w+)"?\s+/)
        if (c) cols.add(c[1].toLowerCase())
      }
      tables.set(m[1].toLowerCase(), cols)
    }

    for (const m of sql.matchAll(/alter\s+table\s+public\.(\w+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?/gi)) {
      const t = m[1].toLowerCase()
      if (!tables.has(t)) tables.set(t, new Set())
      tables.get(t)!.add(m[2].toLowerCase())
    }

    for (const m of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?public\.(\w+)/gi)) {
      tables.delete(m[1].toLowerCase())
    }
  }
  return tables
}
