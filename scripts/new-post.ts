/**
 * 에디토리얼 초안 생성 — `npm run blog:new -- --slug=my-post [--date=YYYY-MM-DD]`
 *
 * ── 왜 있는가 ────────────────────────────────────────────────────
 * 주 3 회에서 병목은 글쓰기가 아니라 **준비**다. 어떤 코드를 고를지, 최근에 뭘
 * 썼는지, 그 코드가 어느 리스트에 걸리는지를 매번 손으로 확인하면 그 마찰이
 * 곧 "아무거나 쓰기" 로 이어진다. 그 준비를 여기서 한다.
 *
 * ── 다만 스스로 발행되지는 않는다 ────────────────────────────────
 * 사실 층은 유도값이라 사람이 손댈 곳이 없다. 그래서 **의견을 사람이 썼다는 것**
 * 이 이 파이프라인에 남은 유일한 사람의 흔적이고, 그게 에디토리얼이 프로그래매틱
 * 코퍼스와 다른 물건인 유일한 이유다.
 *
 * 그래서 초안의 title·dek·take·question·본문에 TODO 를 박아 둔다. 채우지 않으면
 * blog:build 가 거부한다 — 스캐폴드가 자기 자신을 발행할 수 없다.
 *
 * 코드 선정은 최근 글에서 덜 쓴 것을 고른다 (반복 가드와 같은 기준).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'content/blog')
const LISTS = join(root, 'data/section301_lists.json')
const CODES_PER_POST = 8
const RECENT_WINDOW = 10

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

interface ListFile {
  lists: Array<{ list: string; rate: number; active: boolean; codes: string[] }>
}

function recentlyUsed(): Set<string> {
  if (!existsSync(SRC)) return new Set()
  const files = readdirSync(SRC).filter((f) => f.endsWith('.md'))
  const posts = files
    .map((f) => {
      const m = readFileSync(join(SRC, f), 'utf-8').match(/^---\n([\s\S]*?)\n---/)
      if (!m) return null
      try {
        return JSON.parse(m[1]) as { date?: string; codes?: string[] }
      } catch {
        return null
      }
    })
    .filter((p): p is { date?: string; codes?: string[] } => p !== null)
    .sort((a, b) => ((a.date ?? '') < (b.date ?? '') ? 1 : -1))
    .slice(0, RECENT_WINDOW)
  return new Set(posts.flatMap((p) => p.codes ?? []))
}

function main() {
  const slug = arg('slug')
  if (!slug || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    throw new Error('--slug=kebab-case 가 필요하다. 예: npm run blog:new -- --slug=list-4a-quietly-moved')
  }
  const out = join(SRC, `${slug}.md`)
  if (existsSync(out)) throw new Error(`${out} 가 이미 있다 — 덮어쓰지 않는다`)

  const date = arg('date') ?? new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date 는 YYYY-MM-DD 여야 한다: ${date}`)

  const lists = (JSON.parse(readFileSync(LISTS, 'utf-8')) as ListFile).lists.filter((l) => l.active)
  const skip = recentlyUsed()

  // 활성 리스트를 번갈아 뽑는다 — 한 리스트만 모으면 매번 같은 이야기가 된다
  const pools = lists.map((l) => l.codes.filter((c) => !skip.has(c)).sort())
  const picked: string[] = []
  for (let i = 0; picked.length < CODES_PER_POST && i < 2000; i++) {
    const pool = pools[i % pools.length]
    // 결정론적으로 고른다 — 같은 상태에서 같은 초안이 나와야 재현이 된다
    const cand = pool[(Math.floor(i / pools.length) * 7919) % pool.length]
    if (cand && !picked.includes(cand)) picked.push(cand)
  }
  if (picked.length < CODES_PER_POST) throw new Error('쓸 수 있는 코드가 모자라다 — 최근 글에서 너무 많이 소진했다')

  const front = {
    title: 'TODO — 한 문장으로 주장한다. 요약이 아니라 주장이다',
    slug,
    date,
    dek: 'TODO — 무엇에 대한 글인지 한 문장. meta description 으로도 쓰인다',
    codes: picked.sort(),
    take: 'TODO — 여기가 의견이다. 화면에 의견 배지가 붙는다. 데이터가 말하지 않는 것을 말할 것 (해석·예측). 틀릴 수 있어야 좋은 take 다',
    question: 'TODO — 답글을 부르는 질문. 자기 사례를 꺼내게 만드는 형태로',
    sources: [
      { label: 'USTR — Section 301 tariff actions', url: 'https://ustr.gov/issue-areas/enforcement/section-301-investigations/tariff-actions' },
      { label: 'USITC — Harmonized Tariff Schedule', url: 'https://hts.usitc.gov/' },
    ],
  }

  const body = `## TODO — 첫 소제목

TODO — 본문. 최소 300 단어. 표를 쓰지 말 것: 세율·리스트는 위 표가 자동으로 그린다.

지원 문법은 ## ### 제목 · 문단 · - 목록 · > 인용 · --- 구분선 ·
**굵게** *기울임* \`코드\` [링크](/hts/${picked[0]}) 뿐이다. 벗어나면 빌드가 줄 번호와 함께 거부한다.
`

  writeFileSync(out, `---\n${JSON.stringify(front, null, 2)}\n---\n${body}`, 'utf-8')

  console.log(`── 초안 생성 ──────────────────────────────────`)
  console.log(`  ${out}`)
  console.log(`  코드 ${picked.length}개 (최근 ${RECENT_WINDOW}편에서 쓴 것은 제외): ${picked.join(' ')}`)
  console.log('')
  console.log('  TODO 를 전부 채워야 발행된다 — 스캐폴드는 자기 자신을 발행할 수 없다.')
  console.log('  다 쓰면: npm run blog:build')
}

main()
