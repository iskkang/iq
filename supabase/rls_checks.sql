-- §6-6 RLS 격리 점검 (Supabase SQL Editor에서 실행)
--
-- A. 정책·RLS 활성화 상태 확인 (모든 고객 테이블 rowsecurity = true 여야 함)
select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
order by 1;

select tablename, policyname, cmd, qual
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- B. 익명(anon) 차단 확인 — 결과 0행이어야 함
set local role anon;
select count(*) as anon_visible_shipments from public.shipments;
select count(*) as anon_visible_items from public.items;
reset role;

-- C. 계정 간 격리 실검증 (2계정 절차 — 배포 후 1회 수행)
--   1) 계정 A·B를 각각 가입시키고 A로 선적/SKU 생성
--   2) B의 JWT로 REST 호출:
--      curl "$SUPABASE_URL/rest/v1/items?select=*" \
--        -H "apikey: $ANON_KEY" -H "Authorization: Bearer $B_ACCESS_TOKEN"
--      → A의 데이터가 보이면 실패. 빈 배열이어야 통과.
--   3) B의 JWT로 A의 shipment id를 직접 지정해 조회/수정/삭제 시도 → 전부 0행이어야 통과.
--   4) rate_ledger 는 두 계정 모두 읽기만 가능, is_admin=false 계정의 insert 는 거부되어야 통과.
