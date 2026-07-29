-- LandedIQ Phase 1 schema
-- 원칙: rate 하드코딩 금지(§1-4), RLS 고객 데이터 격리 필수(§3, §6-6)

-- ─────────────────────────────────────────────────────────────
-- 프로필 (관리자 플래그 — rate 원장 쓰기 권한용)
-- ─────────────────────────────────────────────────────────────
create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

-- 워크스페이스 1개/계정 (스펙 §2)
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  name text not null default 'My workspace',
  created_at timestamptz not null default now(),
  unique (owner)
);

-- 선적 (스펙 §2: 총운임·보험·모드·배부기준 + 가격 파라미터 + rate 기준일)
create table public.shipments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  freight_usd numeric not null default 0 check (freight_usd >= 0),
  insurance_usd numeric not null default 0 check (insurance_usd >= 0),
  mode text not null default 'ocean' check (mode in ('ocean', 'air')),
  allocation_basis text not null default 'value' check (allocation_basis in ('value', 'weight')),
  target_margin numeric not null default 0.30 check (target_margin >= 0 and target_margin < 1),
  channel_fee_pct numeric not null default 0.15 check (channel_fee_pct >= 0 and channel_fee_pct < 1),
  rate_as_of date not null default current_date,
  created_at timestamptz not null default now()
);
create index shipments_workspace_idx on public.shipments (workspace_id);

-- SKU (CSV 컬럼 스펙 §2 + 선택 컬럼)
create table public.items (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  sku text not null,
  product_name text not null default '',
  description_or_material text not null default '',
  unit_cost_usd numeric not null check (unit_cost_usd > 0),
  origin_country text not null,
  units_per_shipment integer not null check (units_per_shipment > 0),
  weight_kg_per_unit numeric check (weight_kg_per_unit is null or weight_kg_per_unit > 0),
  current_price_usd numeric check (current_price_usd is null or current_price_usd > 0),
  -- 확정 HTS (수동 입력 시 confidence 무시 — 스펙 §5)
  hts_final text,
  hts_source text check (hts_source in ('llm', 'manual')),
  classification_status text not null default 'pending'
    check (classification_status in ('pending', 'needs_review', 'auto_confirmed', 'user_confirmed')),
  created_at timestamptz not null default now()
);
create index items_shipment_idx on public.items (shipment_id);
create index items_workspace_idx on public.items (workspace_id);
create index items_review_idx on public.items (classification_status) where classification_status = 'needs_review';

-- LLM 후보 (스펙 §5: 2~3개 + confidence + 근거 1줄)
create table public.hts_candidates (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  rank integer not null,
  hts_code text not null,
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  rationale text not null default '',
  created_at timestamptz not null default now()
);
create index hts_candidates_item_idx on public.hts_candidates (item_id);

-- 분류 이력 (스펙 §5: 모델·프롬프트 버전 포함 — 클레임 대응용)
create table public.classification_runs (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  model text not null,
  prompt_version text not null,
  input jsonb not null,
  raw_output jsonb not null,
  created_at timestamptz not null default now()
);
create index classification_runs_item_idx on public.classification_runs (item_id);

-- ─────────────────────────────────────────────────────────────
-- rate 원장 (스펙 §1-4: 발효일 기반, 관리자 갱신. 하드코딩 금지)
-- hts_code: 숫자만 6/8/10자리 프리픽스, '*' = 전 품목(국가 단위 레이어)
-- ─────────────────────────────────────────────────────────────
create table public.rate_ledger (
  id uuid primary key default gen_random_uuid(),
  hts_code text not null,
  origin_country text,               -- ISO2, null = 전체 원산지
  layer text not null check (layer in ('base_mfn', 'section301', 'ieepa_reciprocal')),
  ad_valorem_rate numeric not null check (ad_valorem_rate >= 0),
  effective_from date not null,
  effective_to date,
  source text,
  note text,
  created_at timestamptz not null default now(),
  unique (hts_code, origin_country, layer, effective_from)
);
create index rate_ledger_lookup_idx on public.rate_ledger (layer, hts_code, origin_country, effective_from);

-- MPF·HMF 설정 (스펙 §4: min/max는 연도별 조정되는 설정값)
create table public.fee_settings (
  id uuid primary key default gen_random_uuid(),
  mpf_rate numeric not null,
  mpf_min_usd numeric not null,
  mpf_max_usd numeric not null,
  hmf_rate numeric not null,
  effective_from date not null unique,
  note text
);

-- ─────────────────────────────────────────────────────────────
-- 신규 유저 → 프로필 + 워크스페이스 자동 생성
-- ─────────────────────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id) values (new.id) on conflict do nothing;
  insert into public.workspaces (owner) values (new.id) on conflict do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─────────────────────────────────────────────────────────────
-- RLS (§6-6: 다른 계정 데이터는 API·화면 어디서도 안 보임)
-- ─────────────────────────────────────────────────────────────
create or replace function public.is_workspace_owner(ws uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from workspaces w where w.id = ws and w.owner = auth.uid());
$$;

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select p.is_admin from profiles p where p.user_id = auth.uid()), false);
$$;

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.shipments enable row level security;
alter table public.items enable row level security;
alter table public.hts_candidates enable row level security;
alter table public.classification_runs enable row level security;
alter table public.rate_ledger enable row level security;
alter table public.fee_settings enable row level security;

-- profiles: 본인 것만 (is_admin 승격은 서비스 롤/SQL로만)
create policy "profiles_select_own" on public.profiles
  for select using (user_id = auth.uid());

-- workspaces: 소유자만
create policy "workspaces_all_own" on public.workspaces
  for all using (owner = auth.uid()) with check (owner = auth.uid());

-- 고객 데이터: workspace 소유자만
create policy "shipments_all_own" on public.shipments
  for all using (public.is_workspace_owner(workspace_id))
  with check (public.is_workspace_owner(workspace_id));

create policy "items_all_own" on public.items
  for all using (public.is_workspace_owner(workspace_id))
  with check (public.is_workspace_owner(workspace_id));

create policy "hts_candidates_all_own" on public.hts_candidates
  for all using (public.is_workspace_owner(workspace_id))
  with check (public.is_workspace_owner(workspace_id));

create policy "classification_runs_all_own" on public.classification_runs
  for all using (public.is_workspace_owner(workspace_id))
  with check (public.is_workspace_owner(workspace_id));

-- 전역 참조 데이터: 로그인 유저 읽기, 관리자만 쓰기
create policy "rate_ledger_read" on public.rate_ledger
  for select to authenticated using (true);
create policy "rate_ledger_admin_write" on public.rate_ledger
  for insert to authenticated with check (public.is_admin());
create policy "rate_ledger_admin_update" on public.rate_ledger
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "rate_ledger_admin_delete" on public.rate_ledger
  for delete to authenticated using (public.is_admin());

create policy "fee_settings_read" on public.fee_settings
  for select to authenticated using (true);
create policy "fee_settings_admin_write" on public.fee_settings
  for insert to authenticated with check (public.is_admin());
create policy "fee_settings_admin_update" on public.fee_settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
