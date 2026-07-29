# LandedIQ — Phase 1 (코어)

미국 중소 수입셀러용 landed cost 추정 웹앱. 상품 CSV 업로드 → HTS 후보 추정(LLM) → 관세·수수료·운임 배부 → SKU별 landed cost·실제 마진·권장 판매가 리포트.

스펙: `landed-cost-mvp-spec-v1.md` (Phase 1 = 가입 → CSV 업로드 → HTS 추정 → 계산 → 화면 리포트 + CSV 다운로드)

## 실행

### 데모 모드 (키 불필요 — 바로 확인)

```bash
npm install
npm run dev
```

Supabase 환경변수가 없으면 자동으로 데모 모드(인메모리 저장 + mock 분류 + 동봉 시드 원장)로 뜹니다. `samples/sample_products.csv`를 업로드해 전 플로우를 확인하세요.

### 실전 모드 (Supabase)

1. Supabase 프로젝트 생성 → SQL Editor에서 `supabase/migrations/0001_init.sql` 실행 (또는 `supabase db push`)
2. rate 원장 시드: `SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run seed:rates`
3. 분류 함수 배포: `supabase functions deploy classify` + `supabase secrets set ANTHROPIC_API_KEY=sk-ant-...` (모델 변경: `CLASSIFY_MODEL`)
4. `.env` 에 `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` 설정 (`.env.example` 참고)
5. 배포: Vercel에 연결 (`vercel.json` SPA rewrite 포함), 환경변수 등록

### 스크립트

| 명령 | 내용 |
|---|---|
| `npm run test` | 단위 테스트 58건 (§4 계산식 + 골든 10건 + CSV 파싱 + 301 원산지 스코핑) |
| `npm run golden` | 골든 테스트 실행 (`golden-test-products.csv` → `test-results.md`) |
| `npm run bench` | §6-2 벤치마크 (500 SKU 파이프라인) |
| `npm run seed:rates` | rate 원장 시드 (옵션 `-- --usitc <USITC export.csv>` 로 공식 데이터 적재) |
| `node scripts/smoke-e2e.mjs` | 데모 모드 E2E 스모크 (사전 `npm run build`) |

## 구조 (핵심 원칙 매핑)

- **§1-1 계산은 코드가** — `src/lib/calc/` 순수 TS 결정론 엔진. LLM은 `classify/`(후보 추정)에만 관여.
- **§1-2 Estimates only** — `src/lib/disclaimer.ts` 단일 소스. 모든 화면 하단 고정 바 + 리포트 블록 + CSV footer.
- **§1-3 Human-in-the-loop** — confidence < 0.7 → `needs_review` (자동 확정 금지, 리포트 잠정 표시). 관리자 리뷰 큐 화면은 Phase 2.
- **§1-4 rate 원장** — `rate_ledger` 테이블(HTS×원산지×레이어×발효일). 코드 하드코딩 없음. MPF min/max는 `fee_settings` (연도별 조정).
- **§5 분류 이력** — `classification_runs` 에 모델·프롬프트 버전·원문 저장.
- **RLS** — `supabase/migrations/0001_init.sql` 정책 + `supabase/rls_checks.sql` 점검 절차.

## 수용 기준 현황 (§6)

| # | 기준 | 상태 |
|---|---|---|
| 1 | 골든 테스트 10건 수기 계산 일치 | ✅ fixture 10건 통과 (`tests/golden.test.ts`). **실제 MTL 서류 10건을 받으면 fixture 교체 후 재검증 필요** |
| 2 | CSV 500행 → 리포트 3분 이내 | ✅ 파이프라인 실측 ~26ms + LLM 호출 모델링(배치10×동시4, 웨이브당 8s) ≈ 104s < 180s |
| 5 | estimates-only 고지 전 화면·리포트 노출 | ✅ (E2E 스모크로 확인) |
| 6 | RLS 계정 간 격리 | ✅ 정책 작성 완료. **실인스턴스 2계정 검증은 배포 후 `rls_checks.sql` 절차로 1회 수행** |
| 3·4 | Free 한도·Stripe | Phase 2 |

## 골든 테스트 (광고 집행 전 게이트)

계획서 [golden-test-plan-v1.md](golden-test-plan-v1.md) · 결과 [test-results.md](test-results.md) (`npm run golden`)

현재 상태 — **광고 집행 불가**:

| 검증 | 결과 |
|---|---|
| §1 HTS 분류 | ⛔ 미집행 — `classify` Edge Function 미배포(404). mock 참고치 4/10 |
| §2-1·2 세율 대조 | ❌ 실패 — 원장에 검증된 행 0/67 (전부 test seed·SAMPLE·placeholder) |
| §2-3 계산 정확도 | ✅ 통과 — 배부 보존·MPF 캡 3경로 확인 |
| §2-4 원산지 스코핑 | ✅ 통과 — [tests/golden.origin.test.ts](tests/golden.origin.test.ts) |
| §3 E2E | ⛔ 미집행 — UI 수동 수행 필요 |

`supabase/seed/hts_seed_golden_supplement.csv` 는 골든 실행을 완결시키기 위한 **자리표시자**입니다
(9617·9405.21·9506.91·4419.11/12). USITC 확인 전까지 어떤 판단에도 쓰지 마세요.

## 주의 (운영 전 필수)

- 시드 rate는 **테스트용 스냅샷**입니다. base MFN은 `npm run seed:rates -- --usitc <export.csv>` 로 USITC 공식 데이터를 적재하고, **Section 301·IEEPA는 관리자가 수기 입력**하세요 (시드의 SAMPLE 행은 예시값).
- MVP는 **종가세(ad valorem)만** 지원. 종량세/복합세 HTS는 시드 스크립트가 건너뜁니다.
- MPF min/max는 FY2025 값 — 매년 10/1 CBP 고시 확인 후 `fee_settings` 갱신.
- react-router 7.18.2의 npm audit 경고 1건은 RSC 모드 전용 이슈로 본 SPA에는 해당 없음 (패치판 출시 시 업그레이드).
