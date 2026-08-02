-- ═══════════════════════════════════════════════════════════════════
-- 에디토리얼 댓글
--
-- ── 왜 공개 읽기를 허용하는가 ────────────────────────────────────
-- leads 는 anon select 정책이 **없다** — 남의 이메일을 읽을 수 없어야 하기
-- 때문이다. 댓글은 반대다. 읽히라고 쓰는 글이고, 읽히지 않으면 답글을 달 이유가
-- 사라진다. 그래서 정책을 나눈다: 누구나 읽고, 누구나 쓰고, **아무도 고치거나
-- 지울 수 없다.**
--
-- ── 이메일을 받지 않는다 ─────────────────────────────────────────
-- 받으면 leads 와 성격이 다른 개인정보가 한 테이블 더 생기고, 공개 select 정책이
-- 걸린 테이블에 그게 있으면 언젠가 새어나간다. 이름만 받는다. 리드 수집은
-- leads 가 이미 하고 있고, 그쪽은 읽기가 막혀 있다.
--
-- ── 숨김은 있고 삭제는 없다 ──────────────────────────────────────
-- hidden 플래그만 둔다. 실제 삭제 정책을 열면 그 경로로 조용히 지워질 수 있고,
-- "무엇이 지워졌는지" 를 나중에 확인할 방법이 없다. 관리자는 서비스 키로
-- 움직이므로 RLS 를 우회한다 — 정책을 열어줄 필요가 없다.
--
-- ── 스팸 ────────────────────────────────────────────────────────
-- 길이 제약 + 클라이언트 honeypot 이 1차선이다. 광고를 켠 상태라 유입이 늘면
-- 부족해질 수 있다. 그때는 leads 와 같은 판단을 한다: Turnstile 을 앞에 둔다.
-- 지금 넣으면 첫 댓글의 마찰만 키운다 (댓글 0개인 글에 캡차부터 붙는다).
-- ═══════════════════════════════════════════════════════════════════

create table if not exists public.blog_comments (
  id bigint generated always as identity primary key,
  post_slug text not null check (post_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(post_slug) <= 80),

  -- 표시 이름만. 이메일은 받지 않는다 (위 참고)
  author text not null check (length(btrim(author)) between 1 and 60),
  body   text not null check (length(btrim(body)) between 4 and 2000),

  hidden boolean not null default false,
  created_at timestamptz not null default now()
);

-- 글 하나를 시간순으로 읽는 것이 유일한 조회 패턴이다
create index if not exists blog_comments_post_idx
  on public.blog_comments (post_slug, created_at asc)
  where hidden = false;

alter table public.blog_comments enable row level security;

revoke all on table public.blog_comments from anon, authenticated;
grant select, insert on table public.blog_comments to anon, authenticated;
grant usage, select on sequence public.blog_comments_id_seq to anon, authenticated;

-- 읽기: 숨기지 않은 것만. hidden 행은 존재 자체가 안 보인다
create policy "blog_comments_public_read" on public.blog_comments
  for select to anon, authenticated
  using (hidden = false);

-- 쓰기: 누구나. 단 hidden 을 스스로 켜서 넣을 수 없다 —
-- 넣자마자 안 보이는 행을 만들 수 있으면 조용한 저장소가 된다
create policy "blog_comments_public_insert" on public.blog_comments
  for insert to anon, authenticated
  with check (hidden = false);

-- update/delete 정책은 **의도적으로 없다.** 관리자는 서비스 키로 RLS 를 우회한다.

comment on table public.blog_comments is
  '에디토리얼 댓글. anon 읽기+쓰기, 수정·삭제 정책 없음. 이메일은 받지 않는다(공개 select 테이블). '
  '숨김은 hidden 플래그로만 하고 삭제하지 않는다 — 무엇이 사라졌는지 확인할 수 있어야 한다.';
