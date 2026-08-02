-- 퍼널 조회 — Supabase SQL Editor 에 하나씩 붙여 넣는다.
--
-- ── 왜 파일로 두는가 ─────────────────────────────────────────────
-- 지난번 광고는 63 클릭 ₩134,729 을 쓰고 데이터가 한 줄도 남지 않았다.
-- analytics_events 테이블이 프로덕션에 없었는데, public/analytics.js 가
-- keepalive fetch 로 보내고 실패를 삼키므로 아무도 몰랐다.
--
-- 지금은 테이블도 있고 계측도 붙었다. 남은 실패 모드는 **데이터는 쌓이는데
-- 읽을 쿼리가 없어서 즉석 SQL 로 매번 다시 짜는 것**이다. 그러면 질문이
-- 조회마다 미묘하게 달라지고 비교가 안 된다. 질문을 파일에 고정한다.
--
-- 모든 쿼리는 최근 7 일 기준이다. 기간을 바꾸려면 interval 만 고친다.
--
-- ── 내부 방문은 제외한다 ────────────────────────────────────────
-- 소유자가 배포를 확인하려고 페이지를 도는 것만으로 퍼널이 오염된다. 실제로
-- 광고 재개 직후 첫 조회에서 5 세션 24 page_view 가 전부 내부 방문이었고,
-- 그게 광고 트래픽처럼 보였다. 표본이 20~30 세션인 단계에서 이건 결론을 바꾼다.
--
-- 브라우저에서 /?internal=1 을 한 번 열면 그 브라우저의 이후 이벤트에
-- internal:true 가 붙는다 (/?internal=0 으로 해제). 아래 쿼리들은 전부 뺀다.
-- 이벤트 자체는 남으므로 "계측이 도는가" 는 여전히 자기 브라우저로 확인할 수 있다.

-- ═══════════════════════════════════════════════════════════════
-- 1. 퍼널 — 어디서 떠나는가
-- ═══════════════════════════════════════════════════════════════
-- 세션 단위로 센다. 이벤트 수로 세면 한 사람이 여러 번 조회한 것과
-- 여러 사람이 한 번씩 조회한 것이 구별되지 않는다.
with s as (
  select session_id,
         max((event_name = 'page_view')::int)             as viewed,
         max((event_name = 'hts_lookup_submitted')::int)  as searched,
         max((event_name = 'hts_lookup_results')::int)    as got_results,
         max((event_name = 'hts_lookup_empty')::int)      as got_empty,
         max((event_name = 'hts_lookup_failed')::int)     as failed,
         max((event_name = 'watch_submitted')::int)       as watch_tried,
         max((event_name = 'watch_saved')::int)           as watch_saved
  from public.analytics_events
  where occurred_at > now() - interval '7 days'
  and coalesce((properties->>'internal')::boolean, false) = false
  group by session_id
)
select
  count(*)                                        as sessions,
  sum(searched)                                   as searched,
  sum(got_results)                                as got_results,
  sum(got_empty)                                  as got_empty,
  sum(failed)                                     as failed,
  sum(watch_tried)                                as watch_tried,
  sum(watch_saved)                                as watch_saved,
  round(100.0 * sum(searched)    / nullif(count(*), 0), 1)          as pct_searched,
  round(100.0 * sum(watch_saved) / nullif(sum(got_results), 0), 1)  as pct_converted
from s;

-- 읽는 법:
--   pct_searched 가 낮다      → 검색창까지 못 간다 (문구·레이아웃 문제)
--   got_results 는 있는데
--   watch_saved 가 0          → 제안이 안 먹힌다 (알림 구독이 지금의 필요와 안 맞음)
--   got_empty 가 크다         → 매칭 문제. 아래 3번으로 간다


-- ═══════════════════════════════════════════════════════════════
-- 2. 어떤 광고가 데려왔는가
-- ═══════════════════════════════════════════════════════════════
-- 광고 귀속은 **세션 단위**로 한다. 이벤트마다 utm 을 읽으면 utm 이 붙지
-- 않은 이벤트가 하나라도 있을 때 그 세션의 전환이 (none) 으로 새고, 광고
-- 성과가 실제보다 낮게 보인다. 세션의 첫 이벤트에서 한 번만 정한다.
with attr as (
  select distinct on (session_id)
         session_id,
         coalesce(properties->>'utm_source',   '(direct)') as source,
         coalesce(properties->>'utm_campaign', '(none)')   as campaign,
         coalesce(properties->>'utm_term',     '(none)')   as term
  from public.analytics_events
  where occurred_at > now() - interval '7 days'
  and coalesce((properties->>'internal')::boolean, false) = false
  order by session_id, occurred_at
),
act as (
  select session_id,
         max((event_name = 'hts_lookup_submitted')::int) as searched,
         max((event_name = 'hts_lookup_results')::int)   as got_results,
         max((event_name = 'watch_saved')::int)          as converted
  from public.analytics_events
  where occurred_at > now() - interval '7 days'
  and coalesce((properties->>'internal')::boolean, false) = false
  group by session_id
)
select a.source, a.campaign, a.term,
       count(*)              as sessions,
       sum(c.searched)       as searched,
       sum(c.got_results)    as got_results,
       sum(c.converted)      as conversions,
       round(100.0 * sum(c.converted) / nullif(count(*), 0), 1) as pct_converted
from attr a join act c using (session_id)
group by 1, 2, 3
order by sessions desc;


-- ═══════════════════════════════════════════════════════════════
-- 3. 결과가 0 건이었던 검색어  ← 지금 가장 모르는 것
-- ═══════════════════════════════════════════════════════════════
-- 이 질문에 답하려고 q 를 계측에 넣었다. 이전에는 q_kind('code'/'keyword')
-- 만 남아서, 사용자가 넣은 코드가 오타였는지 카탈로그 구멍이었는지
-- 확인할 방법이 아예 없었다.
select
  properties->>'q'                        as query,
  properties->>'origin'                   as origin,
  count(*)                                as times,
  min(occurred_at)                        as first_seen,
  max(occurred_at)                        as last_seen
from public.analytics_events
where event_name = 'hts_lookup_empty'
  and occurred_at > now() - interval '7 days'
  and coalesce((properties->>'internal')::boolean, false) = false
group by 1, 2
order by times desc, last_seen desc
limit 50;

-- 읽는 법: 나온 코드를 SQL Editor 에서 직접 확인한다.
--   select code, description from public.hts_lines where code like '<앞자리>%' limit 5;
--   행이 나오면  → 정규화·검색 로직 문제 (내가 고칠 수 있다)
--   행이 없으면  → 카탈로그에 없는 코드 (오타이거나 시딩 범위 밖)


-- ═══════════════════════════════════════════════════════════════
-- 4. 실제 사용자가 기다린 시간
-- ═══════════════════════════════════════════════════════════════
-- 배포본 드리프트로 조회 한 건이 13.2 초 걸린 적이 있다 (DB 는 40ms 였다).
-- 지금은 882ms 지만 그건 러너에서 잰 한 건이다. 실제 분포를 본다.
select
  event_name,
  count(*)                                                                    as n,
  round(percentile_cont(0.50) within group (order by (properties->>'ms')::numeric))  as p50_ms,
  round(percentile_cont(0.90) within group (order by (properties->>'ms')::numeric))  as p90_ms,
  max((properties->>'ms')::numeric)                                           as max_ms
from public.analytics_events
where occurred_at > now() - interval '7 days'
  and coalesce((properties->>'internal')::boolean, false) = false
  and properties ? 'ms'
group by 1
order by 1;

-- 읽는 법: p90 이 3 초를 넘으면 광고비가 대기 시간에 새고 있다.


-- ═══════════════════════════════════════════════════════════════
-- 5. 원산지 배너가 행동을 만드는가
-- ═══════════════════════════════════════════════════════════════
-- 원산지를 안 고르면 MFN 만 계산돼 실제보다 훨씬 낮은 숫자가 나온다.
-- 그 사실을 알리는 배너를 붙였는데, 효과는 아직 모르는 질문이다.
select
  count(distinct session_id) filter (where event_name = 'hts_result_no_origin')  as saw_partial,
  count(distinct session_id) filter (where event_name = 'origin_prompt_clicked') as clicked,
  round(100.0 * count(distinct session_id) filter (where event_name = 'origin_prompt_clicked')
              / nullif(count(distinct session_id) filter (where event_name = 'hts_result_no_origin'), 0), 1) as pct
from public.analytics_events
where occurred_at > now() - interval '7 days'
  and coalesce((properties->>'internal')::boolean, false) = false;


-- ═══════════════════════════════════════════════════════════════
-- 6. 무엇이 실패했는가
-- ═══════════════════════════════════════════════════════════════
-- 저장·조회 실패는 사용자에게 메시지로 보이지만 우리는 집계로만 안다.
select
  event_name,
  properties->>'reason' as reason,
  count(*)              as n,
  max(occurred_at)      as last_seen
from public.analytics_events
where event_name in ('hts_lookup_failed', 'watch_failed', 'signup_failed', 'section301_watch_failed')
  and occurred_at > now() - interval '7 days'
  and coalesce((properties->>'internal')::boolean, false) = false
group by 1, 2
order by n desc;


-- ═══════════════════════════════════════════════════════════════
-- 7. 유료 전환 — $29 요금제
-- ═══════════════════════════════════════════════════════════════
-- 지난 두 캠페인은 "이메일을 줄 것인가" 를 쟀다. 그 답이 나와도 사업이
-- 되는지는 알 수 없었다. 이 쿼리가 재는 것은 **카드를 긁는가** 다.
--
-- 세션 단위로 센다. 한 사람이 결제창을 세 번 열었다 닫은 것과 세 사람이
-- 한 번씩 연 것은 완전히 다른 이야기다.
with s as (
  select session_id,
         max((event_name = 'page_view')::int)                    as viewed,
         max((event_name = 'plan_limit_hit')::int)               as hit_limit,
         max((event_name = 'checkout_started')::int)             as opened_checkout,
         max((event_name = 'checkout_abandoned')::int)           as abandoned,
         max((event_name = 'checkout_failed')::int)              as failed,
         max((event_name = 'subscription_started')::int)         as subscribed,
         max((event_name = 'subscription_activation_slow')::int) as slow_activation
  from public.analytics_events
  where occurred_at > now() - interval '30 days'
  and coalesce((properties->>'internal')::boolean, false) = false
  group by session_id
)
select
  count(*)                  as sessions,
  sum(hit_limit)            as hit_free_limit,
  sum(opened_checkout)      as opened_checkout,
  sum(abandoned)            as abandoned,
  sum(failed)               as checkout_failed,
  sum(subscribed)           as subscribed,
  sum(slow_activation)      as slow_activation,
  round(100.0 * sum(subscribed) / nullif(sum(opened_checkout), 0), 1) as pct_checkout_to_paid
from s;

-- 읽는 법:
--   hit_free_limit 는 큰데 opened_checkout 가 0  → 한도는 맞는데 가격이 안 팔린다.
--                                                   한도를 늘려서 풀 문제가 아니다
--   opened_checkout 는 있는데 subscribed 가 0     → 결제창에서 떨어진다.
--                                                   Stripe 대시보드의 이탈 지점을 볼 것
--   checkout_failed 가 있다                       → 우리 쪽 설정 문제.
--                                                   6번 쿼리에 checkout_failed 를 넣어 사유를 본다
--   slow_activation 이 있다                       → 웹훅이 20초 안에 안 온다.
--                                                   돈은 받았는데 화면이 안 열린 사람이 있다는 뜻 — 최우선

-- 결제 상태의 실물은 여기 있다 (analytics 가 아니라 진짜 원장):
--   select status, count(*), max(current_period_end)
--   from public.subscriptions group by 1 order by 2 desc;
