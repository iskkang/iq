-- ═══════════════════════════════════════════════════════════════════
-- program_exclusions 에 발효일 체계 추가
--
-- 새로 만든 스키마 규칙 검사(scripts/check-schema.ts)가 첫 실행에서 잡은 위반이다.
-- program_exclusions 는 effective_from · effective_to 가 없었다.
--
-- 면제(exclusion)는 **대부분 만료된다.** USTR 이 부여한 301 면제는 기간이 정해져
-- 있고 연장되지 않으면 끝난다. 만료를 데이터로 표현하지 못하면 이미 끝난 면제가
-- 계속 duty 를 0 으로 만든다 — IEEPA 조항이 무효가 된 뒤에도 관세표에 남아 있던
-- 것과 정확히 같은 구조다.
--
-- 기존 행은 발효일을 모르므로 프로그램 시작일로 넣고 source 에 미확인을 남긴다.
-- 실제 면제를 적용할 때 USTR 고시로 대조해 채울 것 (SOP 3단 절차).
-- ═══════════════════════════════════════════════════════════════════

alter table public.program_exclusions add column if not exists effective_from date;
alter table public.program_exclusions add column if not exists effective_to date;
alter table public.program_exclusions add column if not exists source text;

update public.program_exclusions
   set effective_from = coalesce(effective_from, date '2018-07-06'),
       source = coalesce(source, 'UNVERIFIED — USTR 고시 미대조. 적용 전 확인 필요')
 where effective_from is null;

alter table public.program_exclusions alter column effective_from set not null;

comment on column public.program_exclusions.effective_to is
  '면제 만료일. 대부분의 301 면제는 기간이 정해져 있고 연장되지 않으면 끝난다. '
  'null 이면 현재 유효. 만료를 데이터로 두지 않으면 끝난 면제가 계속 duty 를 0 으로 만든다.';
