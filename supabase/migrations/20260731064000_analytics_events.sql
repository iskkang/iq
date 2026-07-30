create table if not exists public.analytics_events (
  id bigint generated always as identity primary key,
  event_name text not null,
  occurred_at timestamptz not null default now(),
  page text,
  session_id text,
  visitor_id text,
  properties jsonb not null default '{}'::jsonb
);

create index if not exists analytics_events_name_time_idx
  on public.analytics_events (event_name, occurred_at desc);
create index if not exists analytics_events_session_idx
  on public.analytics_events (session_id, occurred_at desc);

alter table public.analytics_events enable row level security;

revoke all on table public.analytics_events from anon, authenticated;
grant insert on table public.analytics_events to anon, authenticated;
grant usage, select on sequence public.analytics_events_id_seq to anon, authenticated;

create policy "public may insert analytics events"
  on public.analytics_events
  for insert
  to anon, authenticated
  with check (
    char_length(event_name) between 1 and 80
    and jsonb_typeof(properties) = 'object'
  );

comment on table public.analytics_events is
  'Append-only product funnel events. No anon/authenticated select policy by design.';
