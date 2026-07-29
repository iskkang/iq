-- ═══════════════════════════════════════════════════════════════════
-- leads 중복 제거 강화 — 광고 전환율을 믿을 수 있게
--
-- leads 는 anon insert 를 허용한다(랜딩 폼이 직접 넣는다). 광고를 켜면 봇이
-- 가입 지표를 오염시키고, 그러면 "전환율 3%" 판정 자체를 못 믿게 된다.
--
-- 기존 제약은 unique(email, intent) 라 같은 주소가 hero / footer / sample_report
-- 로 최대 3행까지 들어갔다. 전환 측정의 단위는 **사람**이므로 이메일 하나당 한 행이
-- 맞다. 대소문자만 바꿔 우회하는 것도 막는다 (Bot@x.com vs bot@x.com).
--
-- 클라이언트는 이미 409 를 성공으로 처리하므로 재제출은 에러로 보이지 않는다.
-- 나머지 절반(랜딩의 honeypot 필드)은 index.html 에 있다.
-- ═══════════════════════════════════════════════════════════════════

-- 같은 주소가 여러 행이면 가장 이른 것만 남긴다 (최초 유입 시점이 전환 시점이다)
delete from public.leads a
 using public.leads b
 where lower(a.email) = lower(b.email)
   and (a.created_at, a.id) > (b.created_at, b.id);

alter table public.leads drop constraint if exists leads_email_intent_key;

create unique index if not exists leads_email_lower_key on public.leads (lower(email));

comment on index public.leads_email_lower_key is
  '이메일당 1행. 전환 측정 단위는 사람이다. 대소문자 우회도 막는다.';
