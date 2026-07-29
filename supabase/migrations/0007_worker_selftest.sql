-- ═══════════════════════════════════════════════════════════════════
-- 워커 자가진단
--
-- 실패 방식이 조용하다: Vault 시크릿 이름이나 값이 어긋나면 크론은 계속 도는데
-- net.http_post 가 401·404 를 받고, 그건 cron.job_run_details 나 net._http_response
-- 를 직접 열어봐야만 보인다. 큐는 쌓이고 사용자는 "리포트가 안 나와요" 라고 한다.
--
-- 여기서 저장된 값 그대로 한 번 쏴보고 상태 코드를 돌려준다.
--   200 → 이름·URL·키 모두 정상
--   404 → classify_function_url 의 함수 이름/경로가 틀렸다
--   401 → service_role_key 값이 틀렸거나 만료됐다
--   null(시크릿 없음) → 이름이 다르게 등록됐다
-- ═══════════════════════════════════════════════════════════════════

/**
 * 저장된 시크릿으로 classify 를 호출한다. Anthropic 을 부르지 않아 비용이 없다.
 * 반환된 request_id 를 worker_selftest_result() 에 넣어 결과를 읽는다.
 * (net.http_post 는 비동기라 응답이 바로 오지 않는다)
 */
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
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'classify_function_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';

  if v_url is null or v_key is null then
    return jsonb_build_object(
      'ok', false,
      'reason', 'vault 시크릿 이름이 다르다',
      'classify_function_url', v_url is not null,
      'service_role_key', v_key is not null,
      'found_names', (select coalesce(jsonb_agg(name), '[]'::jsonb) from vault.decrypted_secrets)
    );
  end if;

  select net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body    := jsonb_build_object('selftest', true),
    timeout_milliseconds := 20000
  ) into v_req;

  -- 값 자체는 절대 반환하지 않는다. URL 은 비밀이 아니라 그대로 보여 대조에 쓴다.
  return jsonb_build_object(
    'ok', true,
    'request_id', v_req,
    'url', v_url,
    'key_len', length(v_key),
    'key_looks_like_jwt', v_key like 'eyJ%'
  );
end;
$$;

/** worker_selftest() 가 준 request_id 의 응답을 읽는다 */
create or replace function public.worker_selftest_result(p_request_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r record;
begin
  select status_code, content, error_msg into r
    from net._http_response where id = p_request_id;

  if not found then
    return jsonb_build_object('status', 'pending', 'hint', '몇 초 뒤 다시 호출하세요');
  end if;

  return jsonb_build_object(
    'status_code', r.status_code,
    'body', left(coalesce(r.content, ''), 300),
    'error', r.error_msg,
    'verdict', case
      when r.status_code = 200 then '정상 — 이름·URL·키 모두 맞다'
      when r.status_code = 404 then 'classify_function_url 의 함수 이름/경로가 틀렸다'
      when r.status_code = 401 then 'service_role_key 값이 틀렸거나 만료됐다'
      else '예상 밖 응답 — body 를 확인할 것'
    end
  );
end;
$$;

/** 크론·큐 상태 한눈에 (운용용) */
create or replace function public.worker_status()
returns jsonb
language sql
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'cron_jobs', (
      select coalesce(jsonb_agg(jsonb_build_object('name', jobname, 'schedule', schedule, 'active', active)), '[]'::jsonb)
        from cron.job where jobname like 'classify-%'
    ),
    'queue', jsonb_build_object(
      'queued',  (select count(*) from public.classification_tasks where status = 'queued'),
      'running', (select count(*) from public.classification_tasks where status = 'running'),
      'failed',  (select count(*) from public.classification_tasks where status = 'failed')
    ),
    -- cron.job_run_details 에는 jobname 컬럼이 없다 (jobid 만) — cron.job 과 조인한다
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

-- 운영자만 부를 수 있다. 일반 사용자에게 노출하면 인프라 정보가 새고,
-- selftest 는 외부 호출을 발생시키므로 남용 여지도 있다.
revoke all on function public.worker_selftest() from public, anon, authenticated;
revoke all on function public.worker_selftest_result(bigint) from public, anon, authenticated;
revoke all on function public.worker_status() from public, anon, authenticated;
grant execute on function public.worker_selftest() to service_role;
grant execute on function public.worker_selftest_result(bigint) to service_role;
grant execute on function public.worker_status() to service_role;
