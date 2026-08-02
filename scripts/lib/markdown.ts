/**
 * 에디토리얼 본문용 마크다운 — **의도적으로 좁은 부분집합**.
 *
 * ── 왜 라이브러리를 안 쓰는가 ────────────────────────────────────
 * 이 저장소가 파는 것은 정확성이다. 본문 렌더러가 지원하지 않는 문법을 만나
 * **조용히 다른 모양으로 내보내면** 발행된 글이 저자가 쓴 글과 달라진다. 범용
 * 파서는 그런 경우 최선을 다해 무언가를 렌더하고 넘어간다 — 여기서는 그게
 * 실패 모드다.
 *
 * 그래서 지원 범위를 좁게 정하고, **벗어나면 줄 번호와 함께 던진다.** 주 1편
 * 규모에서는 좁은 범위로 충분하고, 넓히려면 여기와 테스트를 같이 고쳐야 한다.
 *
 * ── 표를 지원하지 않는 이유 ──────────────────────────────────────
 * 세율·발효일 같은 **사실은 산문이 아니라 구조화된 데이터**에서 온다
 * (front matter 의 facts). 표를 마크다운으로 쓰게 하면 사실이 다시 손으로
 * 적히고, 그 순간 원장과 갈라진다 — 이 저장소가 랜딩·리포트에서 이미 겪은 일이다.
 *
 * 지원: ## ### 제목 · 문단 · - 목록 · > 인용 · --- 구분선 ·
 *       **굵게** *기울임* `코드` [링크](url)
 */

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPE[c])

/** 링크는 외부 https 또는 사이트 내부 절대경로만. javascript: 같은 스킴을 원천 차단한다. */
function href(url: string, line: number): string {
  if (/^https:\/\/[^\s"'<>]+$/.test(url) || /^\/[^\s"'<>]*$/.test(url) || /^mailto:[^\s"'<>]+$/.test(url)) return url
  throw new Error(`${line}행: 허용되지 않는 링크 "${url}" — https · 내부 절대경로 · mailto 만 쓴다`)
}

/** 인라인 서식. 이미 HTML escape 된 문자열에만 적용한다. */
function inline(text: string, line: number): string {
  let out = text
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
    const u = href(url.trim(), line)
    const external = u.startsWith('https://')
    return `<a href="${u}"${external ? ' rel="nofollow noopener" target="_blank"' : ''}>${label}</a>`
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  return out
}

const UNSUPPORTED: Array<[RegExp, string]> = [
  [/^#\s/, 'H1 은 글 제목이 쓴다. 본문에서는 ## 부터 시작할 것'],
  [/^#{4,}\s/, 'H4 이하는 지원하지 않는다 — 그렇게 깊어지면 글을 쪼갤 것'],
  [/^\s*\d+[.)]\s/, '번호 목록은 지원하지 않는다 — 하이픈 목록을 쓸 것'],
  [/^\s*\|/, '표는 지원하지 않는다. 사실은 front matter 의 facts 로 넣을 것 (원장과 갈라지지 않게)'],
  [/^\s*!\[/, '이미지는 지원하지 않는다'],
  [/^\s*```/, '코드 블록은 지원하지 않는다'],
  [/^\s{4,}\S/, '들여쓴 코드 블록은 지원하지 않는다'],
]

/**
 * 지원 범위 밖이면 던진다. 반환값은 본문 HTML.
 * @param offset 원본 파일에서 본문이 시작하는 줄 번호 (오류 메시지를 파일 기준으로 맞춘다)
 */
export function renderMarkdown(src: string, offset = 0): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let para: string[] = []
  let list: string[] = []
  let quote: string[] = []

  const lineNo = (i: number) => i + 1 + offset

  const flushPara = () => {
    if (para.length === 0) return
    out.push(`<p>${para.join(' ')}</p>`)
    para = []
  }
  const flushList = () => {
    if (list.length === 0) return
    out.push(`<ul>${list.map((li) => `<li>${li}</li>`).join('')}</ul>`)
    list = []
  }
  const flushQuote = () => {
    if (quote.length === 0) return
    out.push(`<blockquote>${quote.map((q) => `<p>${q}</p>`).join('')}</blockquote>`)
    quote = []
  }
  const flushAll = () => { flushPara(); flushList(); flushQuote() }

  lines.forEach((raw, i) => {
    const line = raw.trimEnd()

    if (line.trim() === '') { flushAll(); return }

    for (const [re, why] of UNSUPPORTED) {
      if (re.test(line)) throw new Error(`${lineNo(i)}행: ${why}`)
    }

    const text = (s: string) => inline(esc(s), lineNo(i))

    const h = line.match(/^(#{2,3})\s+(.+)$/)
    if (h) { flushAll(); out.push(`<h${h[1].length}>${text(h[2])}</h${h[1].length}>`); return }

    if (/^---+$/.test(line)) { flushAll(); out.push('<hr />'); return }

    const li = line.match(/^-\s+(.+)$/)
    if (li) { flushPara(); flushQuote(); list.push(text(li[1])); return }

    const q = line.match(/^>\s?(.*)$/)
    if (q) { flushPara(); flushList(); quote.push(text(q[1])); return }

    flushList(); flushQuote()
    para.push(text(line))
  })

  flushAll()
  return out.join('\n')
}
