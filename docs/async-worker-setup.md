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

**이 단계는 계정 소유자가 직접 해야 한다.** 서비스 롤 키는 git 에도, 마이그레이션
파일에도 남기지 않는다.

[SQL Editor](https://supabase.com/dashboard/project/hwcfjxwdmmlydnrfyjqk/sql/new) 에서
아래 한 줄만 실행한다. **따옴표 안을 Settings → API Keys 의 `service_role` 값으로
반드시 바꿀 것** — 문구를 그대로 붙여넣으면 함수가 거부한다.

```sql
select ops.set_worker_service_key('여기에_실제_service_role_키');
```

`project_url` 은 마이그레이션(0009)이 알아서 넣는다. 프로젝트 주소는 비밀이 아니라
랜딩 `index.html` 에도 실려 있다.

> **왜 헬퍼를 쓰나.** 예전 안내는 `vault.create_secret('<SERVICE_ROLE_KEY>', ...)` 였고
> 실제로 그 18자 문자열이 그대로 저장됐다. 크론은 계속 돌면서 401
> (`UNAUTHORIZED_INVALID_JWT_FORMAT`)만 조용히 받았다. `set_worker_service_key()` 는
> 치환 안 된 값·형식 불일치·잘린 키를 저장 전에 거부한다.

> **운영 함수는 `ops` 스키마에 있다.** `public` 은 PostgREST 가 외부에 노출하는
> 스키마다. Postgres 기본값이 `EXECUTE TO PUBLIC` 이라 revoke 를 한 번만 잊어도
> Vault 시크릿에 닿는 함수가 anon key 로 열린다. `ops` 는 노출 대상이 아니라
> 잊어도 열리지 않는다 — 실측: 이전 후 service_role 로도 REST 에서 404.
>
> 대신 이 함수들은 **SQL Editor 에서만** 호출된다. `public` 에 남는 것은
> `enqueue_classification`(앱이 로그인 사용자로 호출),
> `complete_classification_task`(Edge Function 이 service_role 로 호출),
> `is_admin`·`is_workspace_owner`(RLS 정책이 호출자 권한으로 평가) 뿐이다.

## 설치 확인 — 반드시 거칠 것

이름이나 값이 어긋나도 크론은 정상적으로 돈다. 실패는 `net._http_response` 에만
남으므로 **자가진단으로 확인해야 한다.**

```sql
select ops.worker_selftest();
--  {"ok": true, "request_id": 1, "endpoint": "https://….supabase.co/functions/v1/classify",
--   "key_len": 219, "key_looks_like_jwt": true}
--  ok:false 면 found_names 에 실제 등록된 이름이 나온다

-- 몇 초 뒤, 위에서 받은 request_id 로
select ops.worker_selftest_result(1);
--  {"status_code": 200, "verdict": "정상 — 이름·URL·키 모두 맞다", ...}
```

| status_code | 뜻 | 조치 |
|---|---|---|
| 200 | 정상 | — |
| 401 | 키가 틀렸거나 만료 | `set_worker_service_key()` 다시 |
| 404 | 함수 이름/경로가 틀림 | `classify_function_url` 시크릿이 남아 있는지 확인 후 삭제 |
| `ok:false` | 시크릿을 못 찾음 | `found_names` 와 대조 |

크론·큐 상태 한눈에:

```sql
select ops.worker_status();
--  cron_jobs(2개 active) · queue(queued/running/failed) · recent_cron_failures
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
-- job_run_details 에는 jobname 이 없다 — cron.job 과 jobid 로 조인해야 한다
select d.start_time, d.status, d.return_message
  from cron.job_run_details d
  join cron.job j on j.jobid = d.jobid
 where j.jobname = 'classify-dispatch'
 order by d.start_time desc limit 20;
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
