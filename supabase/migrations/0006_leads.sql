-- ═══════════════════════════════════════════════════════════════════
-- 랜딩 이메일 수집 (early access / sample report)
--
-- 이전에는 Formspree 로 POST 했는데 폼 ID 가 플레이스홀더(YOUR_FORMSPREE_ID)라
-- 엔드포인트가 404 였다. 제출자는 전원 "Something went wrong" 을 봤고 이메일은
-- 한 건도 남지 않았다. 광고를 켜기 전에 반드시 고쳐야 하는 상태였다.
--
-- 자체 DB 로 받는 이유: 제3자 없음, 건수 제한 없음(Formspree 무료 50건/월은
-- 광고 트래픽에서 즉시 막힌다), 데이터가 본인 계정에 남는다.
-- ═══════════════════════════════════════════════════════════════════

create table public.leads (
  id uuid primary key default gen_random_uuid(),

  -- 형식 제약을 DB 에 둔다. 클라이언트 검증은 우회 가능하고,
  -- 이 테이블은 anon 이 직접 insert 하는 유일한 곳이다.
  email text not null
    check (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
    check (length(email) between 6 and 254),

  intent   text check (intent   is null or length(intent)   <= 40),  -- hero / cta / sample_report
  variant  text check (variant  is null or length(variant)  <= 8),   -- a / b / c
  page     text check (page     is null or length(page)     <= 200),

  utm_source   text check (utm_source   is null or length(utm_source)   <= 100),
  utm_medium   text check (utm_medium   is null or length(utm_medium)   <= 100),
  utm_campaign text check (utm_campaign is null or length(utm_campaign) <= 100),
  utm_term     text check (utm_term     is null or length(utm_term)     <= 100),
  utm_content  text check (utm_content  is null or length(utm_content)  <= 100),

  created_at timestamptz not null default now(),

  -- 같은 주소가 같은 경로로 반복 제출되는 걸 막는다. 클라이언트는
  -- Prefer: resolution=ignore-duplicates 로 보내므로 재제출도 에러가 아니다.
  unique (email, intent)
);

create index leads_created_idx on public.leads (created_at desc);
create index leads_campaign_idx on public.leads (utm_campaign, created_at desc)
  where utm_campaign is not null;

alter table public.leads enable row level security;

-- 방문자는 **넣기만** 한다. select 정책이 없으므로 남의 이메일을 읽을 수 없고,
-- update/delete 정책도 없으므로 지우거나 고칠 수 없다.
create policy "leads_insert_public" on public.leads
  for insert to anon, authenticated
  with check (true);

-- 읽기는 관리자만
create policy "leads_admin_read" on public.leads
  for select using (public.is_admin());

comment on table public.leads is
  '랜딩 이메일 수집. anon 은 insert 전용(RLS). 읽기는 is_admin() 만. '
  '스팸 유입 시 created_at 기준으로 정리하고, 필요하면 Turnstile 을 앞에 둘 것.';
