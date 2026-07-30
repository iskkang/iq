-- ═══════════════════════════════════════════════════════════════════
-- 아카이브(만료) 행은 DB 가 지키게 한다
--
-- ── 왜 스크립트 계층으로 부족한가 ─────────────────────────────────
-- deleteOwned 가 만료 행을 필터에서 빼고, 삭제 후 아카이브 행수까지 재확인한다.
-- 하지만 그건 **그 스크립트를 통과할 때만** 걸린다. SQL Editor 로 직접 지우면
-- 아무것도 막지 않고, 이 저장소에서 SQL Editor 는 실제로 쓰이는 경로다.
-- 오늘도 중복 정리를 거기서 했다.
--
-- ── 왜 보존하는가 ────────────────────────────────────────────────
-- 과거 선적을 그 시점 세율로 다시 계산할 수 있어야 한다 (클레임·사후 정정 대응).
-- 만료 행이 사라지면 그 계산을 재현할 방법이 없고, 재현할 수 없는 숫자는
-- 브로커 앞에서 방어할 수 없다. 감사 추적도 같은 이유다.
--
-- ── 프로그램 목록이 아니라 조건으로 판정한다 ──────────────────────
-- `122` 를 목록에 넣는 방식이면 언젠가 강제노동 301 이 끝날 때 또 손대야 하고,
-- 그때 잊는다. 조건이면 미래 만료도 자동으로 보호된다.
--
-- ── 경계일 ───────────────────────────────────────────────────────
-- `<= current_date` 다. 반열림 [from, to) 규칙에서 asOf >= effective_to 면 이미
-- 만료이므로, **오늘 만료되는 행은 오늘부터 보호된다.** inEffect / isArchived /
-- archiveSafeFilter 와 같은 경계다 (한 곳이라도 어긋나면 하루짜리 구멍이 생기고,
-- 그 하루가 하필 FY2027 전환일 같은 날이다).
-- ═══════════════════════════════════════════════════════════════════

create or replace function public.block_archived_mutation()
returns trigger
language plpgsql
as $$
begin
  if old.effective_to is not null and old.effective_to <= current_date then
    -- 탈출구를 남긴다. 없으면 정당한 수정이 필요할 때 트리거를 drop 하게 되고,
    -- 다시 붙이는 걸 잊는다 — 보호가 조용히 사라지는 가장 흔한 경로다.
    -- 트랜잭션 안에서만 유효하므로 한 번의 의도적 작업으로 범위가 제한된다:
    --   begin;
    --   set local app.allow_archive_edit = 'on';
    --   delete from ...;
    --   commit;
    if coalesce(current_setting('app.allow_archive_edit', true), 'off') <> 'on' then
      -- 메시지는 **세 테이블 공통 컬럼만** 쓴다. program_code 를 넣었다가
      -- fee_settings 에는 그 컬럼이 없어 예외를 던지는 순간 다른 오류가 난다 —
      -- 보호 장치가 자기 오류로 죽으면 무엇이 막혔는지 알 수 없게 된다.
      raise exception
        '아카이브 행은 불변이다 (%, % ~ %). 과거 선적 재계산과 감사 추적의 근거다. '
        '정말 고쳐야 하면 같은 트랜잭션에서 set local app.allow_archive_edit = ''on'' 을 먼저 실행할 것.',
        TG_TABLE_NAME, old.effective_from, old.effective_to
        using errcode = 'restrict_violation';
    end if;
  end if;
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end $$;

comment on function public.block_archived_mutation() is
  '만료 행(effective_to <= current_date)의 UPDATE/DELETE 를 막는다. 프로그램 목록이 '
  '아니라 조건으로 판정하므로 앞으로 만료될 프로그램도 자동으로 보호된다. '
  'set local app.allow_archive_edit = ''on'' 으로 한 트랜잭션 동안만 해제할 수 있다.';

drop trigger if exists rate_ledger_archive_immutable on public.rate_ledger;
create trigger rate_ledger_archive_immutable
  before update or delete on public.rate_ledger
  for each row execute function public.block_archived_mutation();

drop trigger if exists program_exclusions_archive_immutable on public.program_exclusions;
create trigger program_exclusions_archive_immutable
  before update or delete on public.program_exclusions
  for each row execute function public.block_archived_mutation();

drop trigger if exists fee_settings_archive_immutable on public.fee_settings;
create trigger fee_settings_archive_immutable
  before update or delete on public.fee_settings
  for each row execute function public.block_archived_mutation();

-- 한계를 적어둔다: TRUNCATE 는 행 트리거를 타지 않는다. 서비스 롤이 truncate 를
-- 실행하면 막히지 않으므로, 이 트리거는 "실수로 지우는 것" 을 막는 장치이지
-- 권한 통제가 아니다.
