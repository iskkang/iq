-- ═══════════════════════════════════════════════════════════════════
-- 공개 HTS 조회(/hts)를 위한 참조 데이터 읽기 개방
--
-- 로그인 없이 조회하려면 anon 이 참조 테이블을 읽어야 한다. 지금은 네 개 모두
-- `to authenticated` 라 anon 이 빈 배열만 받는다 (실측 확인).
--
-- ── 무엇을 여는가, 왜 안전한가 ────────────────────────────────────
-- 전부 **공개 1차 자료에서 온 참조 데이터**다. 영업 비밀이 아니다.
--   hts_lines      USITC 공식 export (누구나 hts.usitc.gov 에서 받는다)
--   rate_ledger    base MFN = 위와 동일 / 중국 301 = HTSUS ch.99 note 20 공개 원문
--   duty_programs  프로그램 메타 (발효일·근거 조항)
--   fee_settings   MPF·HMF 요율 (CBP 공시)
--
-- 고객 데이터(shipments·items·leads·classification_*)는 **건드리지 않는다.**
-- 그쪽 정책은 그대로 워크스페이스 소유자 전용이다.
--
-- 읽기 전용이다. insert/update/delete 정책은 만들지 않으므로 anon 은 쓰지 못한다.
-- ═══════════════════════════════════════════════════════════════════

-- hts_lines — 라인 카탈로그
drop policy if exists "hts_lines_read_public" on public.hts_lines;
create policy "hts_lines_read_public" on public.hts_lines
  for select to anon, authenticated using (true);

-- rate_ledger — 기존 정책이 authenticated 전용이라 anon 용을 따로 둔다
drop policy if exists "rate_ledger_read_public" on public.rate_ledger;
create policy "rate_ledger_read_public" on public.rate_ledger
  for select to anon using (true);

-- duty_programs
drop policy if exists "duty_programs_read_public" on public.duty_programs;
create policy "duty_programs_read_public" on public.duty_programs
  for select to anon, authenticated using (true);

-- program_exclusions — 면제 목록도 판정에 필요하다
drop policy if exists "program_exclusions_read_public" on public.program_exclusions;
create policy "program_exclusions_read_public" on public.program_exclusions
  for select to anon, authenticated using (true);

-- fee_settings — MPF/HMF
drop policy if exists "fee_settings_read_public" on public.fee_settings;
create policy "fee_settings_read_public" on public.fee_settings
  for select to anon using (true);

comment on policy "rate_ledger_read_public" on public.rate_ledger is
  '공개 HTS 조회(/hts) 용. 출처가 USITC 공식 export 와 HTSUS ch.99 공개 원문이라 '
  '비공개로 둘 이유가 없다. 쓰기는 여전히 관리자 전용이다.';
