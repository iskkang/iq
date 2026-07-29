-- ═══════════════════════════════════════════════════════════════════
-- 운영 함수를 ops 스키마로 이전 (PostgREST 노출 대상에서 제외)
--
-- revoke 만으로도 anon·authenticated 는 막힌다 (실측: 전부 42501/403).
-- 그런데 Postgres 기본값이 EXECUTE TO PUBLIC 이라, 앞으로 public 에 함수를
-- 추가할 때마다 revoke 를 **기억해야** 안전하다. 한 번 잊으면 Vault 시크릿에
-- 닿는 함수가 anon key 로 열린다.
--
-- ops 는 PostgREST 노출 스키마가 아니므로 잊어도 열리지 않는다.
--
-- ── public 에 남는 것과 이유 ──────────────────────────────────────
--   enqueue_classification       앱이 로그인 사용자로 호출 (자체 소유권 검사 있음)
--   complete_classification_task Edge Function 이 PostgREST 로 호출 (service_role 전용)
--   is_admin / is_workspace_owner RLS 정책이 호출자 권한으로 평가 — 옮기면 RLS 가 깨진다
-- ═══════════════════════════════════════════════════════════════════

create schema if not exists ops;
revoke all on schema ops from public;
revoke all on schema ops from anon, authenticated;
grant usage on schema ops to postgres, service_role;

-- ── 이전 ────────────────────────────────────────────────────────────
-- 크론이 참조하므로 먼저 언스케줄한다 (없으면 조용히 넘어간다)
do $$
begin
  perform cron.unschedule('classify-dispatch');
exception when others then null;
end;
$$;

drop function if exists public.dispatch_classification_tasks();
drop function if exists public.worker_selftest();
drop function if exists public.worker_selftest_result(bigint);
drop function if exists public.worker_status();
drop function if exists public.set_worker_service_key(text);
drop function if exists public.classify_endpoint();
drop function if exists public.claim_classification_tasks(integer);

/** 호출할 classify 엔드포인트. 치환 안 된 템플릿은 거부한다. */
create function ops.classify_endpoint()
returns text
language plpgsql stable security definer
set search_path = ops, public, extensions
as $$
declare v text;
begin
  select decrypted_secret into v from vault.decrypted_secrets where name = 'classify_function_url';
  if v is null or length(btrim(v)) = 0 then
    select decrypted_secret into v from vault.decrypted_secrets where name = 'project_url';
  end if;
  if v is null or length(btrim(v)) = 0 then return null; end if;

  v := rtrim(btrim(v), '/');
  if v like '%<%' or v like '%>%' or v ~* 'your[-_]?project|project[-_]?ref|example\.com' then
    return null;
  end if;
  if v !~* '^https://[a-z0-9.-]+\.supabase\.(co|in|red)' then return null; end if;
  if v like '%/functions/v1/classify' then return v; end if;
  return v || '/functions/v1/classify';
end;
$$;

/** FOR UPDATE SKIP LOCKED — 크론 틱이 겹쳐도 같은 태스크를 두 번 집지 않는다 */
create function ops.claim_classification_tasks(p_limit integer)
returns setof public.classification_tasks
language sql security definer
set search_path = ops, public, extensions
as $$
  update public.classification_tasks t
     set status = 'running', attempts = t.attempts + 1, locked_at = now()
   where t.id in (
     select c.id from public.classification_tasks c
      where c.attempts < 3
        and (c.status = 'queued'
             or (c.status = 'running' and c.locked_at < now() - interval '5 minutes'))
      order by c.seq, c.created_at
      limit p_limit
      for update skip locked
   )
  returning t.*;
$$;

create function ops.dispatch_classification_tasks()
returns integer
language plpgsql security definer
set search_path = ops, public, extensions
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
  -- 큐가 비면 즉시 반환 — 10초마다 도는데 여기서 vault 를 읽으면 로그가 쌓인다
  if not exists (
    select 1 from public.classification_tasks
     where attempts < 3
       and (status = 'queued' or (status = 'running' and locked_at < now() - interval '5 minutes'))
  ) then
    return 0;
  end if;

  select count(*) into v_running from public.classification_tasks
   where status = 'running' and locked_at >= now() - interval '5 minutes';
  v_slots := max_in_flight - v_running;
  if v_slots <= 0 then return 0; end if;

  v_url := ops.classify_endpoint();
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';

  if v_url is null then
    raise warning '워커 미설정: 엔드포인트를 못 찾았다. select ops.worker_selftest(); 로 진단할 것';
    return 0;
  end if;
  if v_key is null or not (v_key like 'eyJ%' or v_key like 'sb_secret_%') then
    raise warning '워커 미설정: service_role_key 형식이 아니다. select ops.set_worker_service_key(''<실제 키>''); 로 등록할 것';
    return 0;
  end if;

  for rec in select * from ops.claim_classification_tasks(v_slots) loop
    perform net.http_post(
      url     := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
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

/** 저장 전에 형식을 검증한다 — 플레이스홀더가 그대로 들어간 적이 있다 */
create function ops.set_worker_service_key(p_key text)
returns text
language plpgsql security definer
set search_path = ops, public, extensions
as $$
declare
  v_id uuid;
  v    text := btrim(coalesce(p_key, ''));
begin
  if v = '' then raise exception '키가 비어 있다'; end if;
  if v like '%<%' or v like '%>%' then
    raise exception '치환되지 않은 플레이스홀더다 (%). Settings → API Keys 의 service_role 값을 붙여넣을 것', left(v, 30);
  end if;
  if not (v like 'eyJ%' or v like 'sb_secret_%') then
    raise exception '서비스 키 형식이 아니다 (앞 8자: %, 길이 %)', left(v, 8), length(v);
  end if;
  if length(v) < 40 then
    raise exception '키가 너무 짧다 (길이 %) — 잘려 붙여넣어졌을 수 있다', length(v);
  end if;

  select id into v_id from vault.decrypted_secrets where name = 'service_role_key';
  if v_id is null then
    perform vault.create_secret(v, 'service_role_key', 'pg_cron 워커 인증 토큰');
    return format('service_role_key 생성 (길이 %s)', length(v));
  end if;
  perform vault.update_secret(v_id, v);
  return format('service_role_key 갱신 (길이 %s)', length(v));
end;
$$;

/** 저장된 시크릿 그대로 한 번 쏴본다. Anthropic 을 안 불러 비용이 없다. */
create function ops.worker_selftest()
returns jsonb
language plpgsql security definer
set search_path = ops, public, extensions
as $$
declare v_url text; v_key text; v_req bigint;
begin
  v_url := ops.classify_endpoint();
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

  return jsonb_build_object('ok', true, 'request_id', v_req, 'endpoint', v_url,
                            'key_len', length(v_key), 'key_looks_like_jwt', v_key like 'eyJ%');
end;
$$;

create function ops.worker_selftest_result(p_request_id bigint)
returns jsonb
language plpgsql security definer
set search_path = ops, public, extensions
as $$
declare r record;
begin
  select status_code, content, error_msg into r from net._http_response where id = p_request_id;
  if not found then
    return jsonb_build_object('status', 'pending', 'hint', '몇 초 뒤 다시 호출하세요');
  end if;
  return jsonb_build_object(
    'status_code', r.status_code,
    'body', left(coalesce(r.content, ''), 300),
    'error', r.error_msg,
    'verdict', case
      when r.status_code = 200 then '정상 — 이름·URL·키 모두 맞다'
      when r.status_code = 404 then 'classify 함수 이름/경로가 틀렸거나 미배포'
      when r.status_code = 401 then 'service_role_key 값이 틀렸거나 만료됐다'
      else '예상 밖 응답 — body 를 확인할 것'
    end
  );
end;
$$;

create function ops.worker_status()
returns jsonb
language sql security definer
set search_path = ops, public, extensions
as $$
  select jsonb_build_object(
    'endpoint', ops.classify_endpoint(),
    'cron_jobs', (
      select coalesce(jsonb_agg(jsonb_build_object('name', jobname, 'schedule', schedule, 'active', active)), '[]'::jsonb)
        from cron.job where jobname like 'classify-%'
    ),
    'queue', jsonb_build_object(
      'queued',  (select count(*) from public.classification_tasks where status = 'queued'),
      'running', (select count(*) from public.classification_tasks where status = 'running'),
      'failed',  (select count(*) from public.classification_tasks where status = 'failed')
    ),
    -- job_run_details 에는 jobname 이 없다 — cron.job 과 jobid 로 조인
    'recent_cron_failures', (
      select coalesce(jsonb_agg(jsonb_build_object('at', d.start_time, 'msg', left(d.return_message, 200))), '[]'::jsonb)
        from (
          select d.start_time, d.return_message
            from cron.job_run_details d
            join cron.job j on j.jobid = d.jobid
           where j.jobname = 'classify-dispatch' and d.status <> 'succeeded'
           order by d.start_time desc limit 5
        ) d
    )
  );
$$;

-- ── 크론 재등록 (ops 경로로) ────────────────────────────────────────
select cron.schedule('classify-dispatch', '10 seconds', $$select ops.dispatch_classification_tasks()$$);

-- ── public 에 남는 것: 최소 권한 재확인 ─────────────────────────────
revoke all on function public.complete_classification_task(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.complete_classification_task(uuid, boolean, text) to service_role;
grant execute on function public.enqueue_classification(uuid) to authenticated;

-- 앞으로 public 에 만들어지는 함수는 기본으로 PUBLIC 실행 권한을 갖지 않는다.
-- revoke 를 잊어도 열리지 않게 하는 것이 목적이다. RLS 정책에서 쓰는 헬퍼를
-- 새로 만들면 authenticated 에 명시적으로 grant 해야 한다.
alter default privileges in schema public revoke execute on functions from public;

comment on schema ops is
  '운영 전용. PostgREST 노출 스키마가 아니므로 anon/authenticated 가 도달할 수 없다. '
  'Vault 시크릿·크론 디스패치처럼 외부에 열리면 안 되는 함수를 여기 둔다.';
