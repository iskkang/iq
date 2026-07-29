-- ═══════════════════════════════════════════════════════════════════
-- project_url 시크릿 치환 + 플레이스홀더 방어
--
-- Vault 의 project_url 에 Supabase 문서 템플릿이 그대로 들어가 있었다:
--   https://<project-ref>.supabase.co
-- 그러면 net.http_post 가 "Bad hostname" 으로 실패한다. 크론은 계속 돌고,
-- 실패는 net._http_response 에만 남아 아무 데도 안 보인다.
--
-- 프로젝트 URL 은 비밀이 아니다 — 랜딩 index.html 에도 그대로 실려 있고
-- publishable 키와 함께 브라우저로 나간다. 그래서 여기서 직접 고친다.
-- ═══════════════════════════════════════════════════════════════════

do $$
declare
  v_id  uuid;
  v_val text;
  -- 이 저장소는 단일 프로젝트를 쓴다. 다른 프로젝트로 옮기면 여기와
  -- index.html 의 CONFIG.SUPABASE_URL 을 함께 바꿀 것.
  v_target constant text := 'https://hwcfjxwdmmlydnrfyjqk.supabase.co';
begin
  select id, decrypted_secret into v_id, v_val
    from vault.decrypted_secrets where name = 'project_url';

  if v_id is null then
    perform vault.create_secret(v_target, 'project_url', 'pg_cron 워커가 Edge Function 을 부를 때 쓰는 프로젝트 주소');
    raise notice 'project_url 생성';
  elsif v_val is distinct from v_target then
    perform vault.update_secret(v_id, v_target);
    raise notice 'project_url 치환 (이전 값이 템플릿이었다)';
  else
    raise notice 'project_url 이미 정상';
  end if;
end;
$$;

/**
 * 엔드포인트 해석 + **플레이스홀더 거부**.
 *
 * `<project-ref>` 같은 치환 안 된 값이 통과하면 net.http_post 가 Bad hostname 으로
 * 조용히 실패한다. 여기서 null 을 돌려주면 디스패처가 경고를 내고 selftest 가
 * 이유를 알려준다 — 실패가 보이는 곳으로 옮기는 것이 목적이다.
 */
create or replace function public.classify_endpoint()
returns text
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v text;
begin
  select decrypted_secret into v from vault.decrypted_secrets where name = 'classify_function_url';
  if v is null or length(btrim(v)) = 0 then
    select decrypted_secret into v from vault.decrypted_secrets where name = 'project_url';
  end if;
  if v is null or length(btrim(v)) = 0 then
    return null;
  end if;

  v := rtrim(btrim(v), '/');

  -- 치환 안 된 템플릿 (<project-ref>, YOUR_PROJECT 등) 은 거부한다
  if v like '%<%' or v like '%>%' or v ~* 'your[-_]?project|project[-_]?ref|example\.com' then
    return null;
  end if;
  if v !~* '^https://[a-z0-9.-]+\.supabase\.(co|in|red)' then
    return null;
  end if;

  if v like '%/functions/v1/classify' then
    return v;
  end if;
  return v || '/functions/v1/classify';
end;
$$;

revoke all on function public.classify_endpoint() from public, anon, authenticated;
