-- ═══════════════════════════════════════════════════════════════════
-- 1) 원장 anon 개방 철회  2) fee_settings 적재
--
-- ── 1. 왜 되돌리는가 ──────────────────────────────────────────────
-- 0014 에서 "출처가 공개 자료라 비공개로 둘 이유가 없다"고 열었는데, 그 판단이
-- 틀렸다. 원문이 공개인 것과 **큐레이션된 원장이 공개여도 되는 것**은 다르다.
-- 이 원장의 값은:
--   · 8자리 301 리스트 판정 (note 20 소절 파싱 + 카탈로그 대조)
--   · List 4B 정지 처리 (부재 = 확인된 0%)
--   · 발효일로 무효 조항 자동 제외 (IEEPA·122)
-- PostgREST 로 열려 있으면 경쟁자가 페이지네이션으로 9,929행을 그대로 받아간다.
-- 매각 실사에서 "핵심 데이터가 공개 API" 는 감점이다.
--
-- hts_lines 는 순수 USITC export 라 열어둔다 — 누구나 hts.usitc.gov 에서 받는다.
-- 판정 결과는 Edge Function 이 서버측에서 계산해 **결과만** 돌려준다.
--
-- ── 2. fee_settings 가 비어 있었다 ────────────────────────────────
-- MPF/HMF 가 DB 에 없고 코드 상수로만 존재했다. 스펙 §1-4 위반이고, 이 프로젝트의
-- 단골 실패 패턴이다 — "설정돼 있다고 보고됐지만 실제로는 하드코딩"(빈 타입체크,
-- userB 와 같은 계열). MPF 캡은 매년 10/1 조정되므로 코드에 두면 개정 때마다
-- 배포가 필요하고, 무엇보다 기준일 이력이 남지 않는다.
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. 철회 ────────────────────────────────────────────────────────
drop policy if exists "rate_ledger_read_public" on public.rate_ledger;
drop policy if exists "duty_programs_read_public" on public.duty_programs;
drop policy if exists "program_exclusions_read_public" on public.program_exclusions;
drop policy if exists "fee_settings_read_public" on public.fee_settings;

-- hts_lines 만 공개 유지 (순수 USITC export)
comment on policy "hts_lines_read_public" on public.hts_lines is
  '순수 USITC 공식 export 라 공개해도 무방하다. 큐레이션이 들어간 rate_ledger · '
  'duty_programs · program_exclusions 는 공개하지 않는다 — 판정 결과만 Edge Function 이 돌려준다.';

-- ── 2. fee_settings 적재 ───────────────────────────────────────────
-- 출처: CBP 19 CFR 24.23 (MPF) · 19 CFR 24.24 (HMF).
-- MPF 종가율 0.3464% 는 2011년 이후 고정, 최소·최대는 매년 10/1 물가연동 조정된다.
-- 다음 조정 때 새 행을 effective_from 과 함께 넣고 이 행에 effective_to 를 적을 것.
insert into public.fee_settings (mpf_rate, mpf_min_usd, mpf_max_usd, hmf_rate, effective_from)
select 0.003464, 32.71, 634.62, 0.00125, date '2024-10-01'
where not exists (select 1 from public.fee_settings where effective_from = date '2024-10-01');
