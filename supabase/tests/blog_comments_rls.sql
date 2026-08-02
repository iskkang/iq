-- ═══════════════════════════════════════════════════════════════════
-- blog_comments 마이그레이션 검증 — **빈 로컬 DB 전용**
--
-- 프로덕션이나 SQL Editor 에서 돌리지 말 것. 테이블을 만들고 행을 넣고 숨긴다.
--
--   createdb t && psql -d t -f supabase/tests/blog_comments_rls.sql
--
-- rls_checks.sql 은 사람이 눈으로 보는 점검 절차다. 이건 다르다 — 기대와
-- 다르면 psql 이 0 이 아닌 코드로 죽는다. 검증이 주장이 아니라 실행이어야
-- 하는 이유는, 실제로 이 스크립트가 결함을 하나 잡았기 때문이다: 정책에
-- create ... if not exists 가 없어서 두 번째 적용이 중간에서 실패했다.
--
-- 마이그레이션 파일 자체를 \i 로 그대로 읽는다. 복사본을 두면 검증 대상과
-- 발행 대상이 갈라진다 — 이 저장소에서 이미 두 번 겪은 실패다.
-- ═══════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on

do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;

\echo '=== 마이그레이션 적용 ==='
\i supabase/migrations/20260802020000_blog_comments.sql
\echo 'OK: 1회차 적용 성공'

\echo ''
\echo '=== anon 으로 전환 ==='
set role anon;

\echo '-- 정상 등록'
insert into public.blog_comments (post_slug, author, body)
  values ('one-subheading-two-tariffs', '강', '두 번째 문단이 핵심이라고 봅니다.');
\echo 'OK: anon insert 성공'

\echo '-- hidden=true 로 넣기 (거부되어야 함)'
do $$ begin
  insert into public.blog_comments (post_slug, author, body, hidden)
    values ('one-subheading-two-tariffs', '스팸', '조용히 숨은 행', true);
  raise exception 'FAIL: hidden=true insert 가 통과했다';
exception when insufficient_privilege then
  raise notice 'OK: hidden=true insert 차단됨 (RLS with check)';
end $$;

\echo '-- 잘못된 slug (거부되어야 함)'
do $$ begin
  insert into public.blog_comments (post_slug, author, body)
    values ('Bad_Slug!', '강', '체크 제약 확인용 본문');
  raise exception 'FAIL: 잘못된 slug 가 통과했다';
exception when check_violation then
  raise notice 'OK: slug 형식 제약 동작';
end $$;

\echo '-- 너무 짧은 본문 (거부되어야 함)'
do $$ begin
  insert into public.blog_comments (post_slug, author, body) values ('a-b', '강', ' x ');
  raise exception 'FAIL: 3자 미만 본문이 통과했다';
exception when check_violation then
  raise notice 'OK: 본문 길이 제약 동작';
end $$;

\echo '-- 공백만 있는 이름 (거부되어야 함)'
do $$ begin
  insert into public.blog_comments (post_slug, author, body) values ('a-b', '   ', '충분히 긴 본문입니다');
  raise exception 'FAIL: 공백 이름이 통과했다';
exception when check_violation then
  raise notice 'OK: 이름 btrim 제약 동작';
end $$;

-- grant 가 select·insert 뿐이므로 RLS 이전에 권한 단계에서 끊긴다.
-- 0행이 아니라 permission denied 다 — 더 강한 차단이다.
\echo '-- update (권한 단계에서 거부되어야 함)'
do $$ begin
  update public.blog_comments set body = '변조됨' where id = 1;
  raise exception 'FAIL: anon update 가 통과했다';
exception when insufficient_privilege then
  raise notice 'OK: anon update 권한 거부';
end $$;

\echo '-- delete (권한 단계에서 거부되어야 함)'
do $$ begin
  delete from public.blog_comments where id = 1;
  raise exception 'FAIL: anon delete 가 통과했다';
exception when insufficient_privilege then
  raise notice 'OK: anon delete 권한 거부';
end $$;

reset role;

\echo ''
\echo '=== 숨김 처리: 서비스 키(=RLS 우회)로만 가능해야 한다 ==='
update public.blog_comments set hidden = true where id = 1;

set role anon;
do $$ declare n int; begin
  select count(*) into n from public.blog_comments;
  if n <> 0 then raise exception 'FAIL: 숨긴 행이 anon 에게 % 개 보인다', n; end if;
  raise notice 'OK: hidden 행은 anon 에게 보이지 않는다';
end $$;
reset role;

\echo ''
\echo '=== 재실행 안전성 (같은 파일을 한 번 더) ==='
\i supabase/migrations/20260802020000_blog_comments.sql
\echo 'OK: 2회차 적용도 성공 — 재실행해도 안전하다'
