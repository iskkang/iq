/**
 * 에디토리얼 마크다운 테스트.
 *
 * ── 왜 있는가 ────────────────────────────────────────────────────
 * 렌더러의 실패는 조용하다. 지원하지 않는 문법을 만나 대충 렌더하고 넘어가면,
 * **발행된 글이 저자가 쓴 글과 달라진 채로** 공개된다. 그래서 이 렌더러는
 * 모르는 문법을 만나면 던지기로 했고, 그 계약을 여기서 못박는다.
 *
 * escape 도 같이 본다 — 본문은 사람이 쓰고 댓글은 방문자가 쓴다. 한쪽이라도
 * 새면 XSS 다.
 */
import { describe, it, expect } from 'vitest'
import { renderMarkdown, esc } from '../scripts/lib/markdown'

describe('지원 범위', () => {
  it('제목·문단·목록·인용·구분선', () => {
    const html = renderMarkdown(['## Why this matters', '', 'First line.', 'Same paragraph.', '', '- one', '- two', '', '> quoted', '', '---'].join('\n'))
    expect(html).toContain('<h2>Why this matters</h2>')
    expect(html).toContain('<p>First line. Same paragraph.</p>')
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>')
    expect(html).toContain('<blockquote><p>quoted</p></blockquote>')
    expect(html).toContain('<hr />')
  })

  it('인라인 서식', () => {
    const html = renderMarkdown('A **bold** and *italic* and `code`.')
    expect(html).toBe('<p>A <strong>bold</strong> and <em>italic</em> and <code>code</code>.</p>')
  })
})

describe('링크', () => {
  it('내부 링크는 그대로 — 코퍼스로 링크가 흘러야 한다', () => {
    expect(renderMarkdown('See [6912.00.44](/hts/69120044).')).toContain('<a href="/hts/69120044">6912.00.44</a>')
  })

  it('외부 링크는 nofollow 로 나간다', () => {
    const html = renderMarkdown('Per [USTR](https://ustr.gov/x).')
    expect(html).toContain('rel="nofollow noopener"')
    expect(html).toContain('target="_blank"')
  })

  it('javascript: 는 거부한다', () => {
    expect(() => renderMarkdown('[x](javascript:alert(1))')).toThrow(/허용되지 않는 링크/)
  })

  it('http 평문도 거부한다', () => {
    expect(() => renderMarkdown('[x](http://example.com)')).toThrow(/허용되지 않는 링크/)
  })
})

describe('모르는 문법은 조용히 넘어가지 않는다', () => {
  const cases: Array<[string, RegExp]> = [
    ['# Title', /H1/],
    ['#### deep', /H4/],
    ['1. first', /번호 목록/],
    ['| a | b |', /표는 지원하지 않는다/],
    ['![alt](x.png)', /이미지/],
    ['```js', /코드 블록/],
  ]
  for (const [src, why] of cases) {
    it(`거부: ${src.slice(0, 14)}`, () => expect(() => renderMarkdown(src)).toThrow(why))
  }

  it('오류에 줄 번호가 있다 — offset 을 반영한다', () => {
    // front matter 뒤 본문이라 파일 기준 줄 번호로 말해야 고칠 수 있다
    expect(() => renderMarkdown('ok\n\n| bad |', 10)).toThrow(/^13행/)
  })

  it('표를 막는 이유가 메시지에 남아 있다', () => {
    expect(() => renderMarkdown('| a |')).toThrow(/front matter 의 facts/)
  })
})

describe('escape', () => {
  it('본문의 HTML 은 텍스트로 나간다', () => {
    expect(renderMarkdown('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
  })

  it('링크 라벨도 escape 된다', () => {
    expect(renderMarkdown('[<b>x</b>](/y)')).toContain('&lt;b&gt;x&lt;/b&gt;')
  })

  it('esc 는 따옴표까지 막는다 — 속성 안에 들어가는 값이 있다', () => {
    expect(esc(`" '`)).toBe('&quot; &#39;')
  })
})
