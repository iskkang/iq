-- ═══════════════════════════════════════════════════════════════════
-- 공개 /hts 조회 레이트리밋
--
-- 원장은 anon 에 닫혀 있고 조회는 Edge Function 을 통해서만 된다. 그 함수가
-- 무제한이면 누구나 코드를 훑어 판정 결과를 통째로 긁어갈 수 있다 — 원장을
-- 직접 열지 않은 의미가 사라진다.
--
-- 분 단위 버킷 카운터. IP 당 분당 상한을 넘으면 함수가 429 를 낸다.
-- ops 스키마에 두어 PostgREST 로 노출되지 않는다.
-- ═══════════════════════════════════════════════════════════════════

create table if not exists ops.hts_lookup_hits (
  ip text not null,
  bucket timestamptz not null,          -- 분 단위로 잘린 시각
  hits integer not null default 0,
  primary key (ip, bucket)
);

comment on table ops.hts_lookup_hits is
  '공개 HTS 조회 레이트리밋 카운터. 참조 데이터가 아니라 운영 카운터이므로 '
  'effective_from/to·source 규칙 대상이 아니다 (check-schema 의 판별 규칙이 '
  '요율/프로그램 성격 컬럼과 program_code 를 보므로 여기에 걸리지 않는다).';

/**
 * 1분 버킷으로 세고 상한 초과 여부를 돌려준다.
 *
 * true  = 허용 (카운트 증가됨)
 * false = 상한 초과
 *
 * 오래된 버킷은 같은 호출에서 정리한다 — 별도 크론을 두면 잊힌다.
 */
create or replace function ops.hts_lookup_allow(p_ip text, p_limit integer default 30)
returns boolean
language plpgsql
security definer
set search_path = ops, public
as $$
declare
  v_bucket timestamptz := date_trunc('minute', now());
  v_hits integer;
begin
  delete from ops.hts_lookup_hits where bucket < now() - interval '10 minutes';

  insert into ops.hts_lookup_hits (ip, bucket, hits)
  values (coalesce(nullif(btrim(p_ip), ''), 'unknown'), v_bucket, 1)
  on conflict (ip, bucket) do update set hits = ops.hts_lookup_hits.hits + 1
  returning hits into v_hits;

  return v_hits <= p_limit;
end;
$$;

revoke all on function ops.hts_lookup_allow(text, integer) from public, anon, authenticated;
grant execute on function ops.hts_lookup_allow(text, integer) to service_role;
