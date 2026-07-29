-- ─────────────────────────────────────────────────────────────
-- 관세 프로그램 일반화 (레이어 고정 → 데이터 주도)
--
-- 2026년 5개월 동안 체계가 세 번 바뀌었다:
--   ~2026-02-24  IEEPA 상호관세·펜타닐  (대법원이 무효화, 2026-02-20)
--   2026-02-24~  Section 122 전면 10%   (150일 상한, 07-24 만료)
--   2026-07-24~  Section 301 강제노동    (60개 경제권, 10%/12.5%)
--
-- 기존 구조는 layer 를 ('base_mfn','section301','ieepa_reciprocal') enum 으로
-- 박아뒀다. 프로그램이 생기고 죽을 때마다 마이그레이션이 필요하고, 죽은
-- 프로그램을 코드에서 지우기 전까지 계속 계산에 낀다.
--
-- 결정적 근거: USITC 공식 HTS Chapter 99 에는 **무효화된 IEEPA 조항이 그대로
-- 남아 있고 만료된 Section 122 도 들어 있다.** 관세표 텍스트는 "지금 시행 중"의
-- 근거가 못 된다. 발효일이 데이터에 있어야 한다.
-- ─────────────────────────────────────────────────────────────

create table public.duty_programs (
  code text primary key,                    -- '301-list3', '301-forced-labor', '122', 'mfn'
  name text not null,
  authority text not null,                  -- 'Section 301' | 'Section 122' | 'MFN' | ...

  -- 가산형인가 상한 보정형인가.
  --   additive         : duty_total 에 그대로 더한다 (MFN, 중국 301 리스트 등)
  --   top_up_to_total  : 가산분 합계가 목표치에 못 미치면 그 차액만 더한다.
  --                      EU·대만 "MFN+301 합계 10%", 일본·한국·스위스 "합계 12.5%"가 이 형태.
  --                      이 경우 ad_valorem_rate 는 **목표 합계**를 뜻한다.
  rate_type text not null default 'additive'
    check (rate_type in ('additive', 'top_up_to_total')),

  -- 적용 범위. 이걸 안 두면 "중국 301 을 4자리 호 전체에 25%" 같은 구조적 오류를
  -- 다시 낸다 — 중국 301 은 8자리 라인 목록, 강제노동 301 은 국가 단위 + 소호 면제,
  -- 122 는 전면이었다.
  --   all              : 전 품목·전 원산지 (Section 122)
  --   country          : 원산지로만 결정 (강제노동 301 — 면제 목록은 program_exclusions)
  --   hts_list         : 지정된 HTS 라인만 (중국 301 List 1~4A)
  --   country_and_hts  : 둘 다 만족해야
  scope_type text not null default 'country_and_hts'
    check (scope_type in ('all', 'country', 'hts_list', 'country_and_hts')),

  effective_from date not null,
  effective_to date,                        -- null = 현재 유효. 만료되면 여기에 날짜를 넣는다
  source text,                              -- 'HTSUS 9903.88.03' 같은 감사 인용
  note text,
  created_at timestamptz not null default now()
);

create index duty_programs_active_idx on public.duty_programs (effective_from, effective_to);

comment on column public.duty_programs.rate_type is
  'additive = 합산. top_up_to_total = ad_valorem_rate 를 목표 합계로 보고 부족분만 더한다.';
comment on column public.duty_programs.scope_type is
  '적용 범위. hts_list 계열은 rate_ledger 행의 hts_code 로, country 계열은 origin_country 로 판정.';

-- ── 프로그램 면제 (강제노동 301 의 471개 소호 등) ──────────────
create table public.program_exclusions (
  program_code text not null references public.duty_programs(code) on delete cascade,
  hts_code text not null,                   -- 숫자만. 프리픽스 매칭
  source text,
  note text,
  primary key (program_code, hts_code)
);

create index program_exclusions_lookup_idx on public.program_exclusions (program_code, hts_code);

-- ── rate_ledger → 프로그램 참조 ───────────────────────────────
alter table public.rate_ledger add column if not exists program_code text;

-- 기존 layer 값을 프로그램으로 승격
insert into public.duty_programs (code, name, authority, rate_type, scope_type, effective_from, effective_to, source, note)
values
  ('mfn', 'Base MFN (Column 1 General)', 'MFN', 'additive', 'hts_list', '1900-01-01', null,
   'USITC HTS General Rate of Duty', 'USITC 공식 export 에서 적재'),
  ('301-china-legacy', 'Section 301 — China Lists 1-4A (2018)', 'Section 301', 'additive', 'country_and_hts',
   '2018-07-06', null, 'HTSUS 9903.88.01-.04, .15',
   '8자리 라인 단위 지정. 시드의 4자리 행은 구조적 오류이므로 U.S. note 20 열거 목록으로 재적재 필요'),
  ('ieepa-reciprocal', 'IEEPA reciprocal tariffs', 'IEEPA', 'additive', 'country',
   '2025-04-09', '2026-02-24', 'HTSUS 9903.01/.02',
   '2026-02-20 연방대법원 6-3 판결로 무효 (IEEPA 는 관세 권한을 주지 않는다). 02-24 종료. 계산에서 자동으로 빠진다')
on conflict (code) do nothing;

update public.rate_ledger set program_code = 'mfn'              where layer = 'base_mfn'         and program_code is null;
update public.rate_ledger set program_code = '301-china-legacy' where layer = 'section301'       and program_code is null;
update public.rate_ledger set program_code = 'ieepa-reciprocal' where layer = 'ieepa_reciprocal' and program_code is null;

alter table public.rate_ledger alter column program_code set not null;
alter table public.rate_ledger add constraint rate_ledger_program_fk
  foreign key (program_code) references public.duty_programs(code);

-- layer 는 하위호환용으로 남기되 새 코드는 program_code 만 본다
comment on column public.rate_ledger.layer is
  'DEPRECATED — program_code 를 쓸 것. 구 데이터 조회 호환을 위해 남겨둔다.';

create index rate_ledger_program_idx on public.rate_ledger (program_code, hts_code, origin_country);

-- ── RLS (rate_ledger 와 동일 정책) ────────────────────────────
alter table public.duty_programs enable row level security;
alter table public.program_exclusions enable row level security;

create policy "duty_programs_read" on public.duty_programs
  for select to authenticated using (true);
create policy "duty_programs_admin_write" on public.duty_programs
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "program_exclusions_read" on public.program_exclusions
  for select to authenticated using (true);
create policy "program_exclusions_admin_write" on public.program_exclusions
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
