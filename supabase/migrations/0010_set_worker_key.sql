-- ═══════════════════════════════════════════════════════════════════
-- 워커 서비스 키 등록 헬퍼 (형식 검증 포함)
--
-- vault.create_secret 를 손으로 부르면 플레이스홀더가 그대로 저장된다.
-- 실제로 그렇게 됐다 — `<SERVICE_ROLE_KEY>` 18자가 들어가 있었고, 크론은
-- 계속 돌면서 401(UNAUTHORIZED_INVALID_JWT_FORMAT)만 조용히 받고 있었다.
--
-- 여기서는 저장 전에 형식을 본다. 치환 안 된 값이면 에러를 내고 멈춘다.
-- 키 자체는 이 파일에 없다 — 호출할 때 인자로 넘긴다 (git 에 남기지 않는다).
--
-- 사용:
--   select public.set_worker_service_key('eyJhbGciOi...');   -- 실제 service_role 키
--   select public.worker_selftest();                          -- 바로 검증
-- ═══════════════════════════════════════════════════════════════════

create or replace function public.set_worker_service_key(p_key text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
  v    text := btrim(coalesce(p_key, ''));
begin
  if v = '' then
    raise exception '키가 비어 있다';
  end if;
  if v like '%<%' or v like '%>%' then
    raise exception '치환되지 않은 플레이스홀더다 (%). Settings → API Keys 의 service_role 값을 그대로 붙여넣을 것', left(v, 30);
  end if;
  -- 레거시 JWT(eyJ...) 또는 신형 시크릿 키(sb_secret_...) 만 받는다
  if not (v like 'eyJ%' or v like 'sb_secret_%') then
    raise exception '서비스 키 형식이 아니다 (앞 8자: %, 길이 %). eyJ... 또는 sb_secret_... 이어야 한다', left(v, 8), length(v);
  end if;
  if length(v) < 40 then
    raise exception '키가 너무 짧다 (길이 %) — 잘려 붙여넣어졌을 수 있다', length(v);
  end if;

  select id into v_id from vault.decrypted_secrets where name = 'service_role_key';
  if v_id is null then
    perform vault.create_secret(v, 'service_role_key', 'pg_cron 워커가 Edge Function 을 부를 때 쓰는 인증 토큰');
    return format('service_role_key 생성 (길이 %s)', length(v));
  end if;
  perform vault.update_secret(v_id, v);
  return format('service_role_key 갱신 (길이 %s)', length(v));
end;
$$;

-- 운영자만. 일반 사용자에게 열면 워커 인증을 바꿔치기할 수 있다.
revoke all on function public.set_worker_service_key(text) from public, anon, authenticated;
grant execute on function public.set_worker_service_key(text) to service_role;

-- ── 디스패처도 형식이 어긋나면 시끄럽게 실패한다 ────────────────────
--
-- 예전에는 키가 있기만 하면 그대로 쐈다. 그래서 플레이스홀더가 401 을 받는
-- 상태로 계속 돌았다. 이제는 아예 보내지 않고 경고를 남긴다.
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

  if v_url is null then
    raise warning '워커 미설정: 엔드포인트를 못 찾았다. select public.worker_selftest(); 로 진단할 것';
    return 0;
  end if;
  if v_key is null or not (v_key like 'eyJ%' or v_key like 'sb_secret_%') then
    raise warning '워커 미설정: service_role_key 형식이 아니다. select public.set_worker_service_key(''<실제 키>''); 로 등록할 것';
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

revoke all on function public.dispatch_classification_tasks() from public, anon, authenticated;
