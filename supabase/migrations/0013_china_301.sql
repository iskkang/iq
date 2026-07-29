-- ═══════════════════════════════════════════════════════════════════
-- 중국 Section 301 — 리스트별 8자리 적재
--
-- 출처: HTSUS Chapter 99 Subchapter III, U.S. note 20 (USITC 공식 배포 PDF).
-- 1순위로 검토한 USITC 라인별 export 의 footnote/additionalDuties 에는
-- 9903.90.08/09(Section 232 파생 철강·알루미늄) 만 있고 9903.88(301) 참조는
-- 한 건도 없었다 (ch.42/73/84/85 전수 확인). 그래서 note 20 원문을 파싱했다.
--
-- ── 소절 → 리스트 (원문 확인) ─────────────────────────────────────
--   20(b)    9903.88.01  List 1    +25%    856 개
--   20(d)    9903.88.02  List 2    +25%    283 개
--   20(f)    9903.88.03  List 3    +25%   5906 개
--   20(s)(i) 9903.88.15  List 4A   +7.5%  2958 개
--   20(u)    9903.88.16  List 4B   정지    546 개  ← 적용 금지
--
-- List 4B 는 원문이 명시적으로 정지시켰다:
--   "[Compiler's note: Subdivisions (t) and (u) of this note and heading
--     9903.88.16 suspended.]"
-- 이 목록에만 있는 라인(도자기 머그 6912.00.44, 스테인리스 주방용품 7323.93.00,
-- 진공용기 9617.00.10, 도마 4419.11.00 등)은 **확인된 0%** 이며 미확인이 아니다.
--
-- ── coverage 컬럼을 새로 두는 이유 ────────────────────────────────
-- 엔진은 "원산지상 도달 가능한 프로그램에 매칭 행이 없으면" 경고를 낸다. 리스트를
-- 전량 적재하고 나면 목록에 없는 중국산마다 경고가 붙어, 정작 중요한 신호가 묻힌다.
-- 열거가 완결된 프로그램은 부재 자체가 정보(=0%)이므로 경고 대상에서 빼야 한다.
--   enumerated : 적용 대상이 원문에 전량 열거됨 → 부재 = 확인된 0%
--   partial    : 일부만 아는 상태 → 부재 = 미확인 (경고)
-- ═══════════════════════════════════════════════════════════════════

alter table public.duty_programs
  add column if not exists coverage text not null default 'partial'
    check (coverage in ('enumerated', 'partial'));

comment on column public.duty_programs.coverage is
  'enumerated = 적용 대상이 원문에 전량 열거됨(부재는 확인된 0%). '
  'partial = 일부만 아는 상태(부재는 미확인 → 경고). 기본값은 안전한 쪽인 partial.';

-- ── 리스트별 프로그램 ───────────────────────────────────────────────
-- 발효일은 리스트별 실제 시행일이다. List 3·4A 는 이후 세율이 조정됐으므로
-- **현재 세율이 발효한 날**을 쓴다 (그 이전 기간의 세율은 이 원장이 다루지 않는다).
insert into public.duty_programs
  (code, name, authority, rate_type, scope_type, coverage, effective_from, effective_to, source, note)
values
  ('301-china-list1', 'Section 301 — China List 1', 'Section 301', 'additive', 'country_and_hts',
   'enumerated', '2018-07-06', null, 'HTSUS ch.99 subch.III U.S. note 20(b) · 9903.88.01',
   '$34B 조치. 8자리 856개. 2018-07-06 시행 이후 25% 유지'),

  ('301-china-list2', 'Section 301 — China List 2', 'Section 301', 'additive', 'country_and_hts',
   'enumerated', '2018-08-23', null, 'HTSUS ch.99 subch.III U.S. note 20(d) · 9903.88.02',
   '$16B 조치. 8자리 283개. 2018-08-23 시행 이후 25% 유지'),

  ('301-china-list3', 'Section 301 — China List 3', 'Section 301', 'additive', 'country_and_hts',
   'enumerated', '2019-05-10', null, 'HTSUS ch.99 subch.III U.S. note 20(f) · 9903.88.03',
   '$200B 조치. 8자리 5,906개. 2018-09-24 에 10% 로 시행, 2019-05-10 부터 25%. 발효일은 현재 세율 기준'),

  ('301-china-list4a', 'Section 301 — China List 4A', 'Section 301', 'additive', 'country_and_hts',
   'enumerated', '2020-02-14', null, 'HTSUS ch.99 subch.III U.S. note 20(s)(i) · 9903.88.15',
   '$120B 조치. 8자리 2,958개. 2019-09-01 에 15% 로 시행, 2020-02-14 부터 7.5%. 발효일은 현재 세율 기준'),

  -- 적용하지 않는다. 세율이 갈릴 여지가 남은 라인을 조용히 0 으로 통과시키지 않기
  -- 위해 존재하는 프로그램이다. 행의 source 가 UNVERIFIED 로 시작하면 엔진이 경고한다.
  ('301-china-unverified', 'Section 301 — China (scope unresolved)', 'Section 301', 'additive',
   'country_and_hts', 'partial', '2018-07-06', null,
   'HTSUS ch.99 subch.III U.S. note 20 / note 31 이하',
   '두 종류를 담는다. (1) 2024 4년 재검토 인상(9903.91.xx — EV·반도체·태양광·배터리 등)은 이번 범위 밖. '
   '(2) note 가 열거한 8자리가 현행 관세표에서 재편돼 사라진 경우(예 4419.90.10 → .11/.91, '
   '8517.12.00 → .13/.14), 현행 형제 라인의 커버리지가 불명이다. 둘 다 0% 로 계산하되 경고를 낸다')
on conflict (code) do update set
  name = excluded.name, authority = excluded.authority, rate_type = excluded.rate_type,
  scope_type = excluded.scope_type, coverage = excluded.coverage,
  effective_from = excluded.effective_from, effective_to = excluded.effective_to,
  source = excluded.source, note = excluded.note;

-- 기존 프로그램은 열거가 완결되지 않았으므로 partial 로 남긴다.
-- mfn 만 예외 — USITC export 전량 적재라 부재는 곧 "해당 라인 없음"이다.
update public.duty_programs set coverage = 'enumerated' where code = 'mfn';

-- ── 구조적으로 틀린 4자리 행 제거 ───────────────────────────────────
-- 301 은 호(4자리) 단위가 아니라 8자리 라인 단위로 지정된다. 기존 SAMPLE 행은
-- 6912 전체에 25% 를 매겼는데, 실제로 6912.00.44(머그)는 정지된 List 4B 라 0% 다.
delete from public.rate_ledger where program_code = '301-china-legacy';
update public.duty_programs
   set effective_to = '2018-07-06',
       note = coalesce(note, '') || ' / 리스트별 프로그램(301-china-list1~4a)으로 대체됨. 4자리 SAMPLE 행은 구조적 오류라 삭제'
 where code = '301-china-legacy';
