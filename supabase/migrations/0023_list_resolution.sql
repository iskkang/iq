-- ═══════════════════════════════════════════════════════════════════
-- 리스트 배정을 3값으로 — 면제(exclusion)와 같은 구조
--
--   covered      해당 리스트 세율
--   not_covered  0% (목록에 없음이 **확인**됨 — coverage='enumerated' 의 부재)
--   unresolved   숫자를 정하지 않는다
--
-- ── 왜 0% 가 틀렸나 ──────────────────────────────────────────────
-- 301-china-unverified 5행은 "리스트 배정을 확인하지 못한" 라인인데 세율이 0 이었다.
-- 경고는 냈지만 **숫자는 0 으로 합산됐다.** 우리가 세운 오차 비대칭 원칙과 방향이
-- 반대다: 과대계상은 고객이 손해를 안 보지만 과소계상은 마진을 무너뜨린다.
--
-- 그렇다고 25% 로 부과하는 것도 틀리다 — 이 라인들은 정말로 0% 일 수도 있다.
-- 확인되지 않은 것은 **숫자가 아니라 상태**다. 0 도 25 도 아닌 "모름" 이 답이다.
--
-- ── 부재로 표현한다 ──────────────────────────────────────────────
-- ad_valorem_rate 를 NULL 로 둔다. 0 을 넣으면 어딘가에서 그냥 더해지고, 그 사고는
-- 조용하다. NULL 이면 타입이 number | null 이 되어 **컴파일러가 모든 사용처를
-- 찾아준다.** 문자열 플래그를 옆에 두는 것보다 강하다.
--
-- resolution 컬럼은 의도를 명시하고 질의 가능하게 한다. 둘이 어긋나지 못하도록
-- CHECK 로 묶는다 — 한쪽만 고치는 것이 이 저장소의 반복된 실패 방식이다.
-- ═══════════════════════════════════════════════════════════════════

alter table public.rate_ledger
  alter column ad_valorem_rate drop not null;

alter table public.rate_ledger
  add column if not exists resolution text not null default 'covered';

alter table public.rate_ledger
  drop constraint if exists rate_ledger_resolution_valid;
alter table public.rate_ledger
  add constraint rate_ledger_resolution_valid
  check (resolution in ('covered', 'unresolved'));

-- 상태와 숫자가 어긋날 수 없게. covered 인데 세율이 없거나, unresolved 인데
-- 세율이 있으면 여기서 막힌다.
alter table public.rate_ledger
  drop constraint if exists rate_ledger_unresolved_has_no_rate;
alter table public.rate_ledger
  add constraint rate_ledger_unresolved_has_no_rate
  check ((resolution = 'unresolved') = (ad_valorem_rate is null));

comment on column public.rate_ledger.resolution is
  'covered = 세율이 확정된 행. unresolved = 리스트 배정을 확인하지 못해 숫자를 '
  '정하지 않은 행 (ad_valorem_rate 는 반드시 NULL). 엔진은 unresolved 를 합산하지 '
  '않고 해당 SKU 를 "301 미해결" 로 표시한다 — 0 으로 더하면 관세를 과소계상한다.';

-- ── 기존 5행 전환 ────────────────────────────────────────────────
-- 이 행들은 열려 있어(effective_to is null) 0022 아카이브 트리거에 걸리지 않는다.
update public.rate_ledger
   set resolution = 'unresolved',
       ad_valorem_rate = null
 where program_code = '301-china-unverified'
   and effective_to is null;

-- not_covered 는 행으로 표현하지 않는다. coverage='enumerated' 인 프로그램에서
-- **행이 없는 것** 이 곧 "목록에 없음이 확인됨" 이다 (List 4B 만 걸린 라인 등).
-- 확인된 0% 를 행으로 넣으면 9,929행이 27,000행이 되고 유지 부담만 는다.
