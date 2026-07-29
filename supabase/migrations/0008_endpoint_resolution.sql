-- ═══════════════════════════════════════════════════════════════════
-- 워커 엔드포인트 해석을 한 곳으로 모은다
--
-- 0005 는 `classify_function_url` 이라는 시크릿에 **전체 URL**을 넣도록 했다.
-- 그러면 함수 이름이 코드와 Vault 두 곳에 존재하고, 어긋나면 크론은 계속 도는데
-- net.http_post 가 404 를 받는다 — 큐만 쌓이고 아무 데도 안 보인다.
-- 실제로 어긋났다: Vault 에는 `project_url` 과 `service_role_key` 가 들어 있었다.
--
-- 이제 함수 이름은 코드(classify_endpoint)에만 있고, Vault 에는 프로젝트 주소만
-- 둔다. Supabase 문서가 웹훅 예제에서 쓰는 이름(project_url·service_role_key)과
-- 같아서 나중에 다른 워커를 붙일 때도 재사용된다.
--
-- 두 이름 모두 받아준다 (classify_function_url 이 이미 있으면 그대로 쓴다).
-- ═══════════════════════════════════════════════════════════════════

/**
 * 호출할 classify 엔드포인트 전체 URL. 못 찾으면 null.
 *
 * 우선순위:
 *   1) classify_function_url — 전체 URL 이 직접 지정된 경우
 *   2) project_url + /functions/v1/classify — 권장. 함수 이름은 여기 한 곳에만 있다
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
  if v is not null and length(btrim(v)) > 0 then
    return btrim(v);
  end if;

  select decrypted_secret into v from vault.decrypted_secrets where name = 'project_url';
  if v is null or length(btrim(v)) = 0 then
    return null;
  end if;

  v := rtrim(btrim(v), '/');
  -- project_url 에 이미 함수 경로가 들어 있는 경우도 받아준다
  if v like '%/functions/v1/classify' then
    return v;
  end if;
  return v || '/functions/v1/classify';
end;
$$;

-- ── 디스패처를 새 해석기로 교체 ─────────────────────────────────────
create or replace function public.dispatch_classification_tasks()
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  max_in_flight constant integer := 16;
  v_running integer;
  v_slots   integer;
  v_url     text;
  v_key     text;
  rec       public.classification_tasks%rowtype;
  v_sent    integer := 0;
begin
  -- 큐가 비어 있으면 즉시 반환한다. 크론이 10초마다 도는데 여기서 vault 를 읽거나
  -- 경고를 내면 유휴 상태에서 로그가 하루 8,640줄씩 쌓인다.
  if not exists (
    select 1 from public.classification_tasks
     where attempts < 3
       and (status = 'queued' or (status = 'running' and locked_at < now() - interval '5 minutes'))
  ) then
    return 0;
  end if;

  select count(*) into v_running
    from public.classification_tasks
   where status = 'running' and locked_at >= now() - interval '5 minutes';

  v_slots := max_in_flight - v_running;
  if v_slots <= 0 then
    return 0;
  end if;

  v_url := public.classify_endpoint();
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then
    raise warning 'vault 설정 누락 — endpoint=% key=%. worker_selftest() 로 진단할 것',
      v_url is not null, v_key is not null;
    return 0;
  end if;

  for rec in select * from public.claim_classification_tasks(v_slots) loop
    perform net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_key
      ),
      body    := jsonb_build_object('task_id', rec.id),
      timeout_milliseconds := 120000
    );
    v_sent := v_sent + 1;
  end loop;

  update public.classification_jobs j
     set status = 'running', started_at = coalesce(j.started_at, now())
   where j.status = 'queued'
     and exists (select 1 from public.classification_tasks t
                  where t.job_id = j.id and t.status = 'running');

  return v_sent;
end;
$$;

-- ── 자가진단도 같은 해석기를 쓴다 ───────────────────────────────────
create or replace function public.worker_selftest()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_url text;
  v_key text;
  v_req bigint;
begin
  v_url := public.classify_endpoint();
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';

  if v_url is null or v_key is null then
    return jsonb_build_object(
      'ok', false,
      'reason', 'vault 시크릿이 없다 — project_url 과 service_role_key 를 등록할 것',
      'endpoint_resolved', v_url is not null,
      'service_role_key', v_key is not null,
      'found_names', (select coalesce(jsonb_agg(name order by name), '[]'::jsonb) from vault.decrypted_secrets)
    );
  end if;

  select net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body    := jsonb_build_object('selftest', true),
    timeout_milliseconds := 20000
  ) into v_req;

  -- 시크릿 값은 반환하지 않는다. URL 은 비밀이 아니라 대조에 쓰도록 보여준다.
  return jsonb_build_object(
    'ok', true,
    'request_id', v_req,
    'endpoint', v_url,
    'key_len', length(v_key),
    'key_looks_like_jwt', v_key like 'eyJ%'
  );
end;
$$;

revoke all on function public.classify_endpoint() from public, anon, authenticated;
revoke all on function public.dispatch_classification_tasks() from public, anon, authenticated;
revoke all on function public.worker_selftest() from public, anon, authenticated;
grant execute on function public.worker_selftest() to service_role;
