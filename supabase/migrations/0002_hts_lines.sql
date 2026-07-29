-- ─────────────────────────────────────────────────────────────
-- HTS 라인 카탈로그 (USITC 공식 export)
--
-- 목적: 분류기가 코드를 자유 생성하지 못하게 막는다. 2단계 분류의 (b) 단계에서
-- "해당 호의 실제 라인"을 보기로 제시하고 그 안에서만 고르게 하는 근거 데이터.
-- 동시에 auto_confirm 조건인 "코드가 실존하는가" 판정에도 쓰인다.
--
-- rate_ledger 와 역할이 다르다:
--   hts_lines   = 어떤 코드가 존재하고 무엇을 뜻하는가 (분류용)
--   rate_ledger = 그 코드에 몇 %가 붙는가 (계산용, 발효일 있음)
-- ─────────────────────────────────────────────────────────────
create table public.hts_lines (
  code text primary key,                  -- 숫자만 10자리
  heading text not null,                  -- 앞 4자리
  description text not null,              -- 조상 설명을 이어붙인 전체 문장
  leaf text not null,                     -- 그 라인 자체의 마지막 마디
  general text,                           -- USITC general(MFN) 원문
  general_inherited boolean not null default false,
  units text[] not null default '{}',
  source text,
  fetched_at timestamptz not null default now(),
  constraint hts_lines_code_digits check (code ~ '^[0-9]{10}$'),
  constraint hts_lines_heading_digits check (heading ~ '^[0-9]{4}$')
);

create index hts_lines_heading_idx on public.hts_lines (heading);

alter table public.hts_lines enable row level security;

-- 전역 참조 데이터: 로그인 유저 읽기, 관리자만 쓰기 (rate_ledger 와 동일 정책)
create policy "hts_lines_read" on public.hts_lines
  for select to authenticated using (true);
create policy "hts_lines_admin_write" on public.hts_lines
  for insert to authenticated with check (public.is_admin());
create policy "hts_lines_admin_update" on public.hts_lines
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "hts_lines_admin_delete" on public.hts_lines
  for delete to authenticated using (public.is_admin());

-- ─────────────────────────────────────────────────────────────
-- 분류 캐시 — 동일 입력 재호출 금지
--
-- key = sha256(정규화된 상품명+설명+원산지 + 모델 + 프롬프트버전).
-- 정규화(소문자·공백 축약·구두점 제거)라 표기만 다른 같은 상품은 같은 키가 된다.
-- 같은 CSV 를 두 번 올려도 같은 결과가 나오게 하는 재현성 장치.
-- ─────────────────────────────────────────────────────────────
create table public.classification_cache (
  cache_key text primary key,
  model text not null,
  prompt_version text not null,
  result jsonb not null,
  hit_count integer not null default 0,
  created_at timestamptz not null default now(),
  last_hit_at timestamptz
);

alter table public.classification_cache enable row level security;

-- 캐시는 상품 설명 기반이라 워크스페이스 간 공유해도 고객 데이터 유출이 아니다
-- (저장되는 것은 HTS 판정 결과뿐, 단가·수량 등 거래 정보는 들어가지 않는다).
create policy "classification_cache_read" on public.classification_cache
  for select to authenticated using (true);
create policy "classification_cache_write" on public.classification_cache
  for insert to authenticated with check (true);
create policy "classification_cache_update" on public.classification_cache
  for update to authenticated using (true) with check (true);

-- ─────────────────────────────────────────────────────────────
-- items: 새 분류 파이프라인 산출물
-- ─────────────────────────────────────────────────────────────
alter table public.items
  add column if not exists classification_consensus jsonb;

comment on column public.items.classification_consensus is
  'k=3 투표 결과: {votes, unanimous, in_ledger, reason}. auto_confirmed 근거 감사용.';
