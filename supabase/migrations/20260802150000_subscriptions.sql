-- 구독 ($29/월) — 결제 상태와 무료 한도 강제
--
-- ── 왜 지금 생기는가 ──────────────────────────────────────────────
-- 이 제품은 지금까지 무료였고 "무료 베타 이메일" 을 받았다. 그 지표로는
-- 지불 의사를 잴 수 없어서 광고 63 클릭 ₩134,729 을 쓰고도 아무 결론이
-- 나오지 않았다. 카드가 긁히는 순간만 그 질문에 답한다.
--
-- ── 쓰기 권한 ─────────────────────────────────────────────────────
-- subscriptions 는 **클라이언트가 절대 못 쓴다.** select 정책만 있고
-- insert/update/delete 정책이 없으므로 anon/authenticated 로는 쓰기가 전부
-- 거부되고, service_role 을 가진 Edge Function(stripe-webhook)만 갱신한다.
-- 사용자가 자기 status 를 'active' 로 바꿀 수 있으면 결제가 무의미해진다.

create table if not exists public.subscriptions (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  stripe_customer_id text not null unique,
  stripe_subscription_id text unique,
  -- Stripe 의 subscription.status 를 그대로 담는다. 우리가 재해석하지 않는다 —
  -- 상태 기계를 두 벌 두면 결제사와 우리 판단이 갈리고, 갈릴 때 손해는 사용자가 본다.
  status text not null default 'incomplete'
    check (status in (
      'incomplete', 'incomplete_expired', 'trialing', 'active',
      'past_due', 'canceled', 'unpaid', 'paused'
    )),
  price_id text,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists subscriptions_customer_idx on public.subscriptions (stripe_customer_id);
create index if not exists subscriptions_stripe_sub_idx on public.subscriptions (stripe_subscription_id);

alter table public.subscriptions enable row level security;

drop policy if exists "subscriptions_select_own" on public.subscriptions;
create policy "subscriptions_select_own" on public.subscriptions
  for select using (public.is_workspace_owner(workspace_id));

-- ─────────────────────────────────────────────────────────────────
-- 유료인가
-- ─────────────────────────────────────────────────────────────────
-- 만료 시각을 함께 본다. status 만 보면 결제 실패로 past_due 를 거쳐
-- canceled 가 되기 전까지 계속 유료로 취급된다.
create or replace function public.workspace_is_paid(ws uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from subscriptions s
    where s.workspace_id = ws
      and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
  );
$$;

-- ─────────────────────────────────────────────────────────────────
-- 무료 한도 — 화면이 아니라 여기서 막는다
-- ─────────────────────────────────────────────────────────────────
-- UI 에서만 막으면 anon key 로 PostgREST 를 직접 때려 무제한으로 쓸 수 있다.
-- anon key 는 브라우저에 그대로 나가 있으므로 비밀이 아니다.
--
-- **왜 RLS `with check` 가 아니라 statement 트리거인가**
-- `with check` 안의 count(*) 는 같은 INSERT 문이 넣은 행을 보지 못한다
-- (문의 스냅샷 기준). items 는 500 행씩 한 번에 넣으므로, with check 로는
-- 25행 한도가 한 번의 대량 insert 로 통째로 뚫린다. transition table 을 쓰는
-- after-statement 트리거는 삽입된 행을 포함해 센다.
create or replace function public.enforce_free_limits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- src/lib/billing/plan.ts 의 PLAN.free 와 같은 값이어야 한다.
  -- 갈라지면 화면과 서버가 다른 한도를 갖는다. plan.test.ts 가 대조한다.
  free_shipments constant integer := 2;
  free_items     constant integer := 25;
  ws uuid;
  n  integer;
begin
  for ws in select distinct workspace_id from new_rows loop
    if public.workspace_is_paid(ws) then
      continue;
    end if;

    if tg_table_name = 'shipments' then
      select count(*) into n from shipments where workspace_id = ws;
      if n > free_shipments then
        raise exception 'FREE_LIMIT_SHIPMENTS: free plan allows % shipments. Subscribe to add more.', free_shipments
          using errcode = 'check_violation';
      end if;
    else
      select count(*) into n from items where workspace_id = ws;
      if n > free_items then
        raise exception 'FREE_LIMIT_ITEMS: free plan allows % SKUs. Subscribe to add more.', free_items
          using errcode = 'check_violation';
      end if;
    end if;
  end loop;
  return null;
end;
$$;

drop trigger if exists shipments_free_limit on public.shipments;
create trigger shipments_free_limit
  after insert on public.shipments
  referencing new table as new_rows
  for each statement execute function public.enforce_free_limits();

drop trigger if exists items_free_limit on public.items;
create trigger items_free_limit
  after insert on public.items
  referencing new table as new_rows
  for each statement execute function public.enforce_free_limits();

-- updated_at 은 손으로 갱신하면 반드시 빠뜨린다.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists subscriptions_touch on public.subscriptions;
create trigger subscriptions_touch
  before update on public.subscriptions
  for each row execute function public.touch_updated_at();
