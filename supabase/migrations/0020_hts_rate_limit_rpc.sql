-- ops 스키마 함수는 PostgREST 가 노출하지 않으므로 Edge Function 이 .rpc() 로
-- 부를 수 없다. service_role 전용 public 래퍼를 둔다 —
-- complete_classification_task 와 같은 패턴이다 (로직은 ops 에, 진입점만 public).
create or replace function public.hts_lookup_allow(p_ip text, p_limit integer default 30)
returns boolean
language sql
security definer
set search_path = public, ops
as $$
  select ops.hts_lookup_allow(p_ip, p_limit);
$$;

revoke all on function public.hts_lookup_allow(text, integer) from public, anon, authenticated;
grant execute on function public.hts_lookup_allow(text, integer) to service_role;
