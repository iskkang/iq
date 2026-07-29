-- ═══════════════════════════════════════════════════════════════════
-- 분류 작업 큐 + pg_cron 워커 (비동기 전환 1/2 — DB 계층)
--
-- 왜 pg_cron 인가 (선택지 (a)):
--   (b) 브라우저 폴링은 탭을 닫으면 작업이 멈춘다. 500 SKU 가 10분 걸리는데
--       그건 "리포트가 안 나와요" 문의로 직결되고, 고객지원 부담은 1인 운영
--       SaaS 를 죽인다. 게다가 완료 알림 때문에 결국 서버측 워커를 또 만들어야
--       하므로 두 번 짓는 셈이다.
--   (c) 외부 워커는 매각 시 넘길 계정이 하나 늘어 실사 표면만 넓힌다.
--   pg_cron 은 Supabase 안에 있어 벤더가 늘지 않는다.
--
-- 이중 처리 방지: 작업 클레임을 FOR UPDATE SKIP LOCKED 로 건다.
-- 크론 틱이 겹쳐 실행돼도 같은 task 를 두 번 집지 않는다 (사용자 지시).
--
-- 선행: 0001_init.sql, 0002_hts_lines.sql
-- ═══════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- ── 1. 작업(job) — 선적 1건의 분류 요청 ─────────────────────────────
create table public.classification_jobs (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  total_tasks integer not null default 0,
  done_tasks integer not null default 0,
  failed_tasks integer not null default 0,
  model text,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index classification_jobs_shipment_idx on public.classification_jobs (shipment_id);
create index classification_jobs_workspace_idx on public.classification_jobs (workspace_id);
-- 선적당 진행 중인 작업은 하나만 (중복 큐잉 방지)
create unique index classification_jobs_active_idx
  on public.classification_jobs (shipment_id)
  where status in ('queued', 'running');

-- ── 2. 태스크 — classify 호출 1회 단위 (아이템 최대 10건) ───────────
--
-- seq 는 아이템 입력 순서를 보존한다. 낮은 seq 부터 처리하므로
-- "첫 20건이 60초 안에" 요건이 큐 순서만으로 자연히 충족된다.
create table public.classification_tasks (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.classification_jobs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  seq integer not null,
  item_ids uuid[] not null check (array_length(item_ids, 1) between 1 and 10),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed')),
  attempts integer not null default 0,
  locked_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
-- 클레임 쿼리(status + seq)가 타는 인덱스
create index classification_tasks_claim_idx
  on public.classification_tasks (status, seq)
  where status in ('queued', 'running');
create index classification_tasks_job_idx on public.classification_tasks (job_id);

-- ── 3. RLS — 사용자는 자기 워크스페이스 것만 읽는다 ─────────────────
--
-- 쓰기는 service_role 전용이다. 사용자가 직접 status 를 건드리면 큐가 깨진다.
-- 큐잉은 아래 enqueue_classification() 이 security definer 로 대신 한다.
alter table public.classification_jobs enable row level security;
alter table public.classification_tasks enable row level security;

create policy "classification_jobs_read_own" on public.classification_jobs
  for select using (public.is_workspace_owner(workspace_id));
create policy "classification_tasks_read_own" on public.classification_tasks
  for select using (public.is_workspace_owner(workspace_id));

-- ── 4. 큐잉 ────────────────────────────────────────────────────────
--
-- 아직 확정되지 않은(hts_final is null) 아이템만 태스크로 만든다.
-- 이미 진행 중인 작업이 있으면 그 id 를 그대로 돌려준다 (멱등).
create or replace function public.enqueue_classification(p_shipment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws uuid;
  v_job uuid;
  v_total integer;
begin
  select workspace_id into v_ws from public.shipments where id = p_shipment_id;
  if v_ws is null then
    raise exception '선적을 찾을 수 없다: %', p_shipment_id;
  end if;
  if not public.is_workspace_owner(v_ws) then
    raise exception '권한 없음';
  end if;

  select id into v_job
    from public.classification_jobs
   where shipment_id = p_shipment_id and status in ('queued', 'running')
   limit 1;
  if v_job is not null then
    return v_job;
  end if;

  insert into public.classification_jobs (shipment_id, workspace_id)
  values (p_shipment_id, v_ws)
  returning id into v_job;

  -- 10건씩 묶어 태스크 생성. 입력 순서(created_at, id)를 유지한다.
  with ordered as (
    select id, (row_number() over (order by created_at, id) - 1) as rn
      from public.items
     where shipment_id = p_shipment_id and hts_final is null
  ),
  batched as (
    select (rn / 10)::integer as seq, array_agg(id order by rn) as ids
      from ordered
     group by (rn / 10)::integer
  )
  insert into public.classification_tasks (job_id, workspace_id, seq, item_ids)
  select v_job, v_ws, seq, ids from batched;

  get diagnostics v_total = row_count;

  update public.classification_jobs
     set total_tasks = v_total,
         status      = case when v_total = 0 then 'done' else 'queued' end,
         finished_at = case when v_total = 0 then now() else null end
   where id = v_job;

  return v_job;
end;
$$;

-- ── 5. 클레임 — FOR UPDATE SKIP LOCKED ─────────────────────────────
--
-- 크론 틱이 겹쳐도 같은 태스크를 두 번 집지 않는다. SKIP LOCKED 가 없으면
-- 두 번째 틱이 첫 틱의 잠금을 기다렸다가 이미 running 이 된 행을 다시 읽어
-- 이중 처리(= LLM 비용 2배, 결과 덮어쓰기)가 난다.
--
-- 5분 넘게 running 인 태스크는 좀비로 보고 회수한다 (Edge Function 이 죽은 경우).
create or replace function public.claim_classification_tasks(p_limit integer)
returns setof public.classification_tasks
language sql
security definer
set search_path = public
as $$
  update public.classification_tasks t
     set status    = 'running',
         attempts  = t.attempts + 1,
         locked_at = now()
   where t.id in (
     select c.id
       from public.classification_tasks c
      where c.attempts < 3
        and (
          c.status = 'queued'
          or (c.status = 'running' and c.locked_at < now() - interval '5 minutes')
        )
      order by c.seq, c.created_at
      limit p_limit
      for update skip locked
   )
  returning t.*;
$$;

-- ── 6. 디스패치 — 크론이 부르는 진입점 ──────────────────────────────
--
-- net.http_post 는 비동기다(요청을 큐에 넣고 즉시 반환). 크론 틱이 응답을
-- 기다리지 않으므로 한 틱이 다음 틱을 막지 않는다.
--
-- 동시 실행 상한은 16 — bench 로 실측한 값이다. 그 이상 띄워도 처리량이
-- 늘지 않고 Anthropic rate limit 만 건드린다.
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

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'classify_function_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then
    raise warning 'vault 에 classify_function_url / service_role_key 가 없다 — 디스패치 중단';
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

-- ── 7. 완료 보고 — Edge Function 이 호출 ────────────────────────────
create or replace function public.complete_classification_task(
  p_task_id uuid,
  p_ok      boolean,
  p_error   text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job      uuid;
  v_attempts integer;
begin
  select job_id, attempts into v_job, v_attempts
    from public.classification_tasks where id = p_task_id;
  if v_job is null then
    raise exception '태스크를 찾을 수 없다: %', p_task_id;
  end if;

  if p_ok then
    update public.classification_tasks
       set status = 'done', finished_at = now(), error = null
     where id = p_task_id;
  elsif v_attempts >= 3 then
    -- 재시도 소진 → 최종 실패
    update public.classification_tasks
       set status = 'failed', finished_at = now(), error = p_error
     where id = p_task_id;
  else
    -- 다음 틱에서 재시도되도록 큐로 되돌린다
    update public.classification_tasks
       set status = 'queued', locked_at = null, error = p_error
     where id = p_task_id;
  end if;

  -- 작업 진행률 갱신 + 종료 판정
  update public.classification_jobs j
     set done_tasks   = s.done,
         failed_tasks = s.failed,
         status       = case when s.done + s.failed >= j.total_tasks
                             then (case when s.failed > 0 then 'failed' else 'done' end)
                             else j.status end,
         finished_at  = case when s.done + s.failed >= j.total_tasks then now() else null end
    from (
      select count(*) filter (where status = 'done')   as done,
             count(*) filter (where status = 'failed') as failed
        from public.classification_tasks where job_id = v_job
    ) s
   where j.id = v_job;
end;
$$;

-- ── 8. 크론 등록 ───────────────────────────────────────────────────
--
-- 10초 간격. 첫 태스크(아이템 1~10)가 최대 10초 안에 출발하므로
-- "첫 결과 60초" 예산 안에서 디스패치 지연이 문제되지 않는다.
select cron.schedule(
  'classify-dispatch',
  '10 seconds',
  $$select public.dispatch_classification_tasks()$$
);

-- 하루 지난 완료 작업 정리 (테이블 무한 증가 방지)
select cron.schedule(
  'classify-cleanup',
  '17 4 * * *',
  $$delete from public.classification_jobs
     where status in ('done', 'failed', 'cancelled')
       and finished_at < now() - interval '7 days'$$
);

revoke all on function public.dispatch_classification_tasks() from public, anon, authenticated;
revoke all on function public.claim_classification_tasks(integer) from public, anon, authenticated;
revoke all on function public.complete_classification_task(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.enqueue_classification(uuid) to authenticated;
