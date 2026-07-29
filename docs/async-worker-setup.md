# 비동기 분류 워커 — 설치와 운용

500 SKU 분류는 10분이 걸린다. 브라우저를 붙잡아 둘 수 없으므로 서버측 워커가
처리하고, 사용자는 결과가 도착하는 대로 본다.

- **구조**: `enqueue_classification()` → `classification_tasks` 큐 → pg_cron 이 10초마다
  `dispatch_classification_tasks()` → `net.http_post` 로 `classify` Edge Function 호출 →
  함수가 결과를 DB 에 쓰고 `complete_classification_task()` 로 보고
- **왜 pg_cron 인가**: 브라우저 폴링은 탭을 닫으면 멈추고, 외부 워커는 매각 시 넘길
  계정이 하나 늘어난다. pg_cron 은 Supabase 안에 있어 벤더가 늘지 않는다.
- **이중 처리 방지**: 클레임에 `FOR UPDATE SKIP LOCKED`. 크론 틱이 겹쳐도 같은 태스크를
  두 번 집지 않는다. 이게 없으면 LLM 비용이 2배가 되고 결과가 서로 덮어쓴다.

## 1회 설치 — Vault 시크릿

**이 단계는 계정 소유자가 직접 해야 한다.** Supabase CLI 에는 임의 SQL 실행
서브커맨드가 없고, 서비스 롤 키를 다른 도구에 흘리지 않는 편이 낫다.

[SQL Editor](https://supabase.com/dashboard/project/hwcfjxwdmmlydnrfyjqk/sql/new) 에서
아래를 한 번 실행한다. `<SERVICE_ROLE_KEY>` 는 Settings → API Keys 의 `service_role` 값이다.

```sql
select vault.create_secret(
  'https://hwcfjxwdmmlydnrfyjqk.supabase.co/functions/v1/classify',
  'classify_function_url',
  'pg_cron 워커가 호출하는 분류 함수 엔드포인트'
);

select vault.create_secret(
  '<SERVICE_ROLE_KEY>',
  'service_role_key',
  'pg_cron 워커가 Edge Function 을 부를 때 쓰는 인증 토큰'
);
```

시크릿이 없으면 디스패처는 아무 일도 하지 않고 경고만 남긴다 — 큐가 조용히
쌓이기만 하므로, 설치 후 아래 확인을 반드시 거칠 것.

## 설치 확인

```sql
-- 1) 크론이 등록됐는가
select jobname, schedule, active from cron.job where jobname like 'classify-%';
--   classify-dispatch | 10 seconds | t
--   classify-cleanup  | 17 4 * * * | t

-- 2) 시크릿이 보이는가 (값은 안 보여도 된다)
select name from vault.decrypted_secrets where name in ('classify_function_url','service_role_key');

-- 3) 디스패처를 손으로 한 번 돌려본다 (큐가 비어 있으면 0 이 정상)
select public.dispatch_classification_tasks();
```

## 운용 — 자주 볼 쿼리

```sql
-- 진행 중인 작업
select j.id, j.status, j.done_tasks || '/' || j.total_tasks as progress,
       j.created_at, j.finished_at
  from public.classification_jobs j
 where j.status in ('queued','running')
 order by j.created_at;

-- 막힌 태스크 (재시도 소진)
select id, job_id, seq, attempts, error
  from public.classification_tasks
 where status = 'failed'
 order by finished_at desc limit 20;

-- 크론 실행 이력 (실패 원인 추적)
select start_time, status, return_message
  from cron.job_run_details
 where jobname = 'classify-dispatch'
 order by start_time desc limit 20;
```

## 손잡이

| 값 | 위치 | 지금 값 | 근거 |
|---|---|---|---|
| 동시 실행 상한 | `dispatch_classification_tasks()` 의 `max_in_flight` | 16 | bench 실측. 그 이상은 처리량이 안 늘고 rate limit 만 건드린다 |
| 크론 주기 | `cron.schedule('classify-dispatch', ...)` | 10초 | 첫 태스크가 최대 10초 안에 출발 — "첫 결과 60초" 예산 안 |
| 배치 크기 | `enqueue_classification()` 의 `rn / 10` | 10건 | `classify` 의 `MAX_ITEMS` 와 같아야 한다 |
| 재시도 한도 | `claim_...` / `complete_...` 의 `attempts < 3` | 3회 | |
| 좀비 회수 | `locked_at < now() - interval '5 minutes'` | 5분 | Edge Function 타임아웃(120초)보다 넉넉해야 정상 작업을 뺏지 않는다 |

## 멈췄을 때

1. `cron.job_run_details` 에 실패가 찍히는가 → vault 시크릿부터 확인
2. 크론은 도는데 태스크가 `queued` 그대로 → `max_in_flight` 가 이미 찼거나
   `attempts >= 3` 으로 클레임 대상에서 빠졌다
3. 태스크가 `running` 에 5분 넘게 머문다 → Edge Function 이 보고 없이 죽었다.
   좀비 회수가 자동으로 되돌리므로 기다리면 되지만, 반복되면 함수 로그를 볼 것
4. 큐를 통째로 비우려면:
   ```sql
   update public.classification_jobs set status = 'cancelled', finished_at = now()
    where status in ('queued','running');
   delete from public.classification_tasks where status in ('queued','running');
   ```
