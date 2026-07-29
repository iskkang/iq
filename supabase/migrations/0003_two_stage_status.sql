-- ─────────────────────────────────────────────────────────────
-- HTS 상태 2단계화: suggested / user_confirmed
--
-- auto_confirmed 삭제 근거 (골든 v3 실측):
--   temperature 0 → k=3 투표가 94~100% 만장일치, (b)단계가 실제 라인만 주므로
--   "원장 실존"도 상시 참. 두 조건 모두 상수라 자동확정이 기본값이 됐고,
--   오답의 needs_review 격리율이 0% 였다. 자동으로 "확인됨"을 붙일 근거가 없다.
--
-- needs_review 도 함께 없앤다 — 확인 전에는 전부 suggested 이고,
-- "무엇을 먼저 볼지"는 상태가 아니라 리뷰 큐 정렬이 답한다 (reviewQueue.ts).
-- ─────────────────────────────────────────────────────────────

alter table public.items drop constraint if exists items_classification_status_check;

update public.items
   set classification_status = 'suggested'
 where classification_status in ('needs_review', 'auto_confirmed');

alter table public.items
  add constraint items_classification_status_check
  check (classification_status in ('pending', 'suggested', 'user_confirmed'));

-- 리뷰 큐 인덱스 교체: 이제 "확인 안 된 건"이 큐 대상이다
drop index if exists items_review_idx;
create index items_review_idx on public.items (classification_status)
  where classification_status = 'suggested';

comment on column public.items.classification_status is
  'pending=분류 전, suggested=모델 제안(사람 미확인), user_confirmed=사람 확정. '
  '리포트·CSV 는 user_confirmed 가 아닌 건을 unreviewed 로 표기한다.';

-- ─────────────────────────────────────────────────────────────
-- 교차검증 결과 — 리뷰 큐 정렬 ①번 신호
--
-- 주의: 이것은 **정렬 신호이지 자동확정 게이트가 아니다.**
-- 두 모델이 일치해도 둘 다 틀릴 수 있다 (골든 v3: BAG-01 두 모델 모두 5/5 오답).
-- ─────────────────────────────────────────────────────────────
alter table public.items
  add column if not exists cross_check_code text,
  add column if not exists cross_check_model text;

comment on column public.items.cross_check_code is
  '교차검증 모델이 제안한 10자리 코드. 주 모델과 6자리가 다르면 리뷰 큐 최상위로 올린다. '
  '자동확정 판단에는 쓰지 않는다.';
