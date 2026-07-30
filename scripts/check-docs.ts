/**
 * 문서 무결성 검사.
 *
 * ── 왜 생겼는가 ──────────────────────────────────────────────────
 * SOP 의 SQL 블록이 통째로 비어 있었다. 셸 이스케이프 사고로 내용이 날아갔는데
 * 커밋 시점에 아무도 몰랐다. 승계 문서에 구멍이 나면 그 절차는 실행되지 않는다 —
 * 이 저장소에서 문서는 장식이 아니라 자산이다.
 *
 * 네 가지를 본다:
 *   1. 코드 블록이 비어 있지 않은가        (이번 사고의 직접 원인)
 *   2. 인용한 npm 스크립트가 실존하는가
 *   3. 인용한 파일 경로가 실존하는가
 *   4. 인용한 테이블·컬럼이 마이그레이션에 있는가  (check-schema 와 같은 파서)
 *
 * 실행: npm run check:docs (npm run check 에 포함)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { collectTables } from './lib/migrations'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail: string[] = []

function markdownFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) {
        if (e === 'node_modules' || e === '.git' || e === 'dist' || e === 'data') continue
        walk(p)
      } else if (e.endsWith('.md')) out.push(p)
    }
  }
  walk(join(root, 'docs'))
  if (existsSync(join(root, 'README.md'))) out.push(join(root, 'README.md'))
  return out
}

const scripts = new Set(Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).scripts ?? {}))
const tables = collectTables()

for (const file of markdownFiles()) {
  const rel = relative(root, file).replace(/\\/g, '/')
  const text = readFileSync(file, 'utf-8')
  const lines = text.split('\n')

  // ── 1. 빈 코드 블록 ─────────────────────────────────────────────
  let open: number | null = null
  let body = ''
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith('```')) {
      if (open === null) {
        open = i + 1
        body = ''
      } else {
        if (body.trim() === '') fail.push(`${rel}:${open} 코드 블록이 비어 있다`)
        open = null
      }
    } else if (open !== null) {
      body += line
    }
  })
  if (open !== null) fail.push(`${rel}:${open} 코드 블록이 닫히지 않았다`)

  // ── 2. npm 스크립트 ─────────────────────────────────────────────
  for (const m of text.matchAll(/npm run ([a-z0-9:-]+)/g)) {
    if (!scripts.has(m[1])) fail.push(`${rel}: npm run ${m[1]} — package.json 에 없다`)
  }

  // ── 3. 파일 경로 ────────────────────────────────────────────────
  // 백틱 안이거나 마크다운 링크인 것만 본다. 확장자가 있어야 경로로 취급한다.
  const paths = new Set<string>()
  for (const m of text.matchAll(/`([\w./-]+\.(?:ts|tsx|sql|json|md|html|csv|yml|mjs))`/g)) paths.add(m[1])
  for (const m of text.matchAll(/\]\(([\w./-]+\.(?:ts|tsx|sql|json|md|html|csv|yml|mjs))\)/g)) paths.add(m[1])
  for (const p of paths) {
    if (p.startsWith('http')) continue
    // **경로만 검사한다.** `main.tsx` 처럼 맨 파일명은 산문 속 참조이지 경로가
    // 아니다 — 그걸 "파일 없음" 으로 잡으면 오탐이 문서 전체를 덮어 검사가 꺼진다.
    if (!p.includes('/')) continue
    if (!existsSync(join(root, p))) fail.push(`${rel}: ${p} — 파일이 없다`)
  }

  // ── 4. 테이블·컬럼 ──────────────────────────────────────────────
  // 테이블은 `public.X` 로 명시된 것만 본다. 접두어 추측(rate_·program_ …)은
  // program_code · rate_type 같은 **컬럼명·enum 값**까지 테이블로 오인했다.
  for (const m of text.matchAll(/`public\.([a-z][a-z0-9_]+)`/g)) {
    if (!tables.has(m[1])) fail.push(`${rel}: 테이블 public.${m[1]} — 마이그레이션에 없다`)
  }
  const EXT = /^(csv|ts|tsx|sql|json|md|html|yml|mjs|app|co)$/
  for (const m of text.matchAll(/`([a-z][a-z0-9_]+)\.([a-z][a-z0-9_]+)`/g)) {
    const [, t, c] = m
    if (!tables.has(t)) continue
    if (EXT.test(c)) continue // duty_programs.csv 는 파일명이지 컬럼이 아니다
    if (!tables.get(t)!.has(c)) fail.push(`${rel}: ${t}.${c} — 컬럼이 마이그레이션에 없다`)
  }
}

if (fail.length > 0) {
  console.error('── 문서 무결성 위반 ────────────────────────────')
  for (const f of [...new Set(fail)]) console.error('  ✗ ' + f)
  console.error()
  console.error('  문서는 승계 자산이다. 구멍이 난 절차는 실행되지 않는다.')
  process.exit(1)
}
console.log(`문서 무결성 통과 (${markdownFiles().length}개 파일)`)
