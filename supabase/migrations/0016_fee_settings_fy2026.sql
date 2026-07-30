-- ═══════════════════════════════════════════════════════════════════
-- fee_settings FY2026 정정
--
-- 0015 에서 넣은 값(min $32.71 / max $634.62)은 **FY2025 값**이었다. 기억에서
-- 꺼내 CBP 고시로 대조하지 않고 effective_to 없이 넣어 현행처럼 보이게 했다 —
-- 이 저장소가 지키기로 한 규칙("확인되지 않은 세율을 확인된 것처럼 넣지 않는다")을
-- 스스로 깬 것이다.
--
-- 근거: 2025-07-23 관보 90 FR 34665 (CBP Dec. 25-10), CSMS #65741993.
--       19 CFR 24.22·24.23 의 FAST Act 물가연동 절차.
--       2025-10-01 이후 입항·신고분부터 적용.
--
--   MPF 종가율  0.3464%   변동 없음
--   MPF 최소    $32.71 → $33.58
--   MPF 최대    $634.62 → $651.50
--   HMF         0.125%    변동 없음
--
-- 다음 조정은 FY2027, 2026-10-01 이다. SOP 분기 점검에 날짜를 박아둔다.
-- ═══════════════════════════════════════════════════════════════════

-- 감사 가능하도록 근거 컬럼을 둔다 (없으면 어느 고시에서 온 값인지 남지 않는다)
-- effective_to 가 아예 없었다. 만료 개념 없이 effective_from 최신 행만 골라 쓰고
-- 있었다는 뜻이라, 어느 회계연도 값인지·언제까지 유효했는지가 남지 않았다.
alter table public.fee_settings add column if not exists effective_to date;
alter table public.fee_settings add column if not exists source text;
alter table public.fee_settings add column if not exists note text;

-- 기존 FY2025 행 만료. 엔진의 inForce 는 `effective_to <= asOf` 를 제외하므로
-- 만료일 당일(2025-10-01)부터 미적용이고, 같은 날 신규 행이 이어받는다.
update public.fee_settings
   set effective_to = date '2025-10-01',
       source = coalesce(source, 'FY2025 (CBP Dec. 24-xx)'),
       note = coalesce(note, '') || ' / FY2026 조정으로 2025-10-01 만료. 최초 적재 시 근거 미대조였다'
 where effective_from = date '2024-10-01';

insert into public.fee_settings
  (mpf_rate, mpf_min_usd, mpf_max_usd, hmf_rate, effective_from, effective_to, source, note)
select 0.003464, 33.58, 651.50, 0.00125, date '2025-10-01', null,
       '90 FR 34665 (CBP Dec. 25-10), CSMS #65741993',
       'FY2026. 19 CFR 24.22·24.23 FAST Act 물가연동. 2025-10-01 이후 입항·신고분. '
       '종가율 0.3464% 와 HMF 0.125% 는 변동 없음. 다음 조정 FY2027 = 2026-10-01'
where not exists (select 1 from public.fee_settings where effective_from = date '2025-10-01');
