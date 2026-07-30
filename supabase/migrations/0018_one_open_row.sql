-- ═══════════════════════════════════════════════════════════════════
-- "열린 행은 키당 하나" 를 DB 가 강제하게 한다
--
-- 앞서 SOP 에 "신규를 먼저 넣고 직전 행을 닫는다"고 절차를 적었는데 틀렸다.
-- 트랜잭션 안에서는 외부 조회가 시작 전 또는 완료 후 상태만 보므로 문장 순서가
-- 커버 공백을 만들지 않는다. 원자성이 막아준다. 절차로 적을 게 아니었다.
--
-- 진짜 위험은 **후속 행을 넣고 직전 행 닫는 걸 잊는 것**이고, 그건 절차가 아니라
-- 제약으로 막아야 한다. effective_to IS NULL 인 행이 키당 둘이 되는 순간
-- insert 가 실패하면, 조용히 두 행이 열려 있는 상태가 원천적으로 불가능해진다.
--
-- ── 순서에 미치는 영향 ────────────────────────────────────────────
-- 이 인덱스는 DEFERRABLE 이 아니다 (Postgres 는 unique **인덱스** 를 지연시킬 수
-- 없다 — deferrable 은 constraint 에만 걸린다). 따라서 트랜잭션 안이라도 문장
-- 단위로 즉시 검사되고, **직전 행을 먼저 닫고 신규를 넣는 순서**여야 한다.
-- 반대로 하면 insert 시점에 열린 행이 둘이 되어 위반이다.
-- 실제로 돌려서 확인한 뒤 SOP 문구를 그 순서로 고친다.
--
-- duty_programs 는 code 가 PK 라 프로그램당 행이 애초에 하나다. 인덱스를 걸어도
-- 막는 게 없으므로 넣지 않는다 — 장식용 제약은 나중에 "검사되고 있다"는 착각만 준다.
-- ═══════════════════════════════════════════════════════════════════

-- fee_settings 는 전역 요율이라 키가 없다. 열린 행 자체가 하나여야 한다.
create unique index if not exists fee_settings_one_open
  on public.fee_settings ((true))
  where effective_to is null;

-- rate_ledger: 같은 (프로그램, HTS, 원산지) 에 열린 행은 하나.
-- origin_country 는 null 이 될 수 있으므로(전 원산지) nulls not distinct 가 필요하다 —
-- 기본 동작은 null 끼리 서로 다르다고 보아 중복을 허용해버린다.
create unique index if not exists rate_ledger_one_open
  on public.rate_ledger (program_code, hts_code, origin_country) nulls not distinct
  where effective_to is null;

-- program_exclusions: 같은 (프로그램, HTS) 에 열린 면제는 하나.
create unique index if not exists program_exclusions_one_open
  on public.program_exclusions (program_code, hts_code)
  where effective_to is null;

comment on index public.rate_ledger_one_open is
  '열린 행(effective_to is null)은 키당 하나. 후속 행을 넣고 직전 행 닫는 걸 잊으면 '
  'insert 가 실패한다 — 두 행이 조용히 열려 있는 상태를 원천 차단한다. '
  '따라서 갱신은 "직전 행 닫기 → 신규 insert" 순서여야 한다.';
