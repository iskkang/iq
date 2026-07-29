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

1. Supabase 프로젝트 생성 → `supabase db push` (마이그레이션 0001·0002)
2. rate 원장 시드: `SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run seed:rates`
3. HTS 카탈로그: `npm run hts:fetch && npm run hts:seed` (분류 (b)단계 보기 + 원장 실존 판정에 필수)
4. 분류 함수 배포: `supabase functions deploy classify` + `supabase secrets set ANTHROPIC_API_KEY=sk-ant-...` (모델 변경: `CLASSIFY_MODEL`)
5. `.env` 에 `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` 설정 (`.env.example` 참고)
6. 배포: Vercel에 연결 (`vercel.json` SPA rewrite 포함), 환경변수 등록

### 스크립트

| 명령 | 내용 |
|---|---|
| `npm run test` | 단위 테스트 112건 (§4 계산식 + 골든 10건 + CSV 파싱 + 301 원산지 스코핑 + 분류 파이프라인) |
| `npm run golden` | 골든 테스트 실행 (`golden-test-products.csv` → `test-results.md`) |
| `npm run bench` | §6-2 벤치마크 (`-- --sample=N` 으로 실 LLM 비용 측정) |
| `npm run hts:ch99` | HTSUS Ch.99 → 301·IEEPA 관리자 확정 워크시트 |
| `npm run hts:fetch` | USITC 공식 HTS 카탈로그 수집 → `data/hts_lines.json` |
| `npm run hts:seed` | 카탈로그 → Supabase `hts_lines` + `rate_ledger` base MFN |
| `npm run seed:rates` | 301·IEEPA 등 수기 원장 시드 |
| `node scripts/smoke-e2e.mjs` | 데모 모드 E2E 스모크 (사전 `npm run build`) |

## 구조 (핵심 원칙 매핑)

- **§1-1 계산은 코드가** — `src/lib/calc/` 순수 TS 결정론 엔진. LLM은 `classify/`(후보 추정)에만 관여.
- **§1-2 Estimates only** — `src/lib/disclaimer.ts` 단일 소스. 모든 화면 하단 고정 바 + 리포트 블록 + CSV footer.
- **§1-3 Human-in-the-loop** — auto_confirmed 는 k=3 만장일치 AND 원장 실존일 때만, 그 외 `needs_review` (`src/lib/classify/status.ts`). confidence 는 판정에서 빠졌다 — 골든 v2 에서 오답에 85~91% 를 줘 무력했다. 관리자 리뷰 큐 화면은 Phase 2.
- **§1-4 rate 원장** — `rate_ledger` 테이블(HTS×원산지×레이어×발효일). 코드 하드코딩 없음. MPF min/max는 `fee_settings` (연도별 조정).
- **§5 분류 이력** — `classification_runs` 에 모델·프롬프트 버전·원문 저장.
- **RLS** — `supabase/migrations/0001_init.sql` 정책 + `supabase/rls_checks.sql` 점검 절차.

## 수용 기준 현황 (§6)

| # | 기준 | 상태 |
|---|---|---|
| 1 | 골든 테스트 10건 수기 계산 일치 | ✅ fixture 10건 통과 (`tests/golden.test.ts`). **실제 MTL 서류 10건을 받으면 fixture 교체 후 재검증 필요** |
| 2 | CSV 500행 → 리포트 3분 이내 | ❌ **실패 — 실측 268s** (배치 38.3s × 7웨이브, 동시성 8). 결정론 구간은 19ms, 전부 LLM 왕복이다 |
| 5 | estimates-only 고지 전 화면·리포트 노출 | ✅ (E2E 스모크로 확인) |
| 6 | RLS 계정 간 격리 | ✅ 정책 작성 완료. **실인스턴스 2계정 검증은 배포 후 `rls_checks.sql` 절차로 1회 수행** |
| 3·4 | Free 한도·Stripe | Phase 2 |

## 골든 테스트 (광고 집행 전 게이트)

계획서 [golden-test-plan-v1.md](golden-test-plan-v1.md) · 최신 결과 [test-results-v3.md](test-results-v3.md)

| 검증 | 결과 |
|---|---|
| §1 HTS 분류 | `claude-sonnet-4-6` **8.0/10 통과** (5회 8–8) · haiku 5.2/10 미달 → **sonnet 고정** |
| §2-1·2 세율 | 부분 통과 — base MFN 17,633행 USITC 공식 적재. **301·IEEPA 는 관리자 확정 대기** |
| §2-3 계산 정확도 | ✅ 통과 — 배부 보존·MPF 캡 3경로 |
| §2-4 원산지 스코핑 | ✅ 통과 |
| §6-2 500 SKU 3분 | ❌ **실패 — 268s** (k=1+캐싱 후. 이전 321s). 아래 참조 |
| §3 E2E | ⛔ 미집행 — UI 수동 수행 필요 |

**광고 집행은 아직 불가** — 남은 블로커는 §6-2(시간) · §2-1·2(301·IEEPA) · §3(E2E) 셋.

### 자동확정 폐기 → HTS 상태 2단계

골든 v3 에서 오답의 needs_review 격리율이 **0%** 였다. temperature 0 이면 k=3 투표가
94~100% 만장일치가 되고, (b)단계가 실제 라인만 보기로 주므로 "원장 실존"도 상시 참 —
자동확정 조건 두 개가 모두 상수라 게이트 역할을 못 했다.

그래서 `auto_confirmed` / `needs_review` 를 삭제하고 **2단계**로 바꿨다:

| 상태 | 뜻 |
|---|---|
| `pending` | 분류 전 (HTS 없음) |
| `suggested` | 모델 제안, **사람 미확인** → 리포트·CSV 에 `unreviewed` 표기 |
| `user_confirmed` | 사람이 확정 |

교차검증(haiku×sonnet)은 **리뷰 큐 정렬에만** 쓰고 자동확정 게이트로는 쓰지 않는다 —
두 모델이 일치해도 둘 다 틀릴 수 있다 (v3: BAG-01 은 양쪽 모두 5/5 오답).

### 리뷰 큐 정렬 ([reviewQueue.ts](src/lib/classify/reviewQueue.ts))

① 모델 불일치 → ② (a)단계 호 후보 2개 이상 → ③ duty 금액 큰 순.

`npm run bench` 가 상위 N건 커버리지를 함께 낸다. 벤치의 합성 카탈로그는 duty 분포가
평평해서 상위 20건이 20.3% 밖에 못 덮는다 — **실제 카탈로그의 쏠린 분포에서 재측정할 것**.

### 분류 파이프라인 v2 (2단계 선택형)

자유 생성 금지. `supabase/functions/classify/pipeline.ts` 하나가 Edge Function 과 골든 러너 양쪽의 원본이다.

1. **(a) 속성 → 호 후보** — 소재·용도·구성을 정리하고 4자리 호 1~3개
2. **(b) 실제 라인 중 선택** — 그 호의 USITC 실제 라인(코드+설명)만 보기로 제시, 그 안에서만 선택.
   보기 밖 코드면 실패 처리 후 재시도 1회
3. **temperature 0** + 정규화 해시 결과 캐시(`classification_cache`) + stage-B 프롬프트 캐싱
4. **자동확정 없음** — 확인 전에는 전부 `suggested`. k=1 (만장일치가 상수라 게이트가 못 됨)

효과 (v1 자유 생성 대비): 지어낸 통계 suffix **0건** (v1 은 후보 20개 중 19개가 원장 미해석),
보기 밖 코드 0건, haiku 3.2 → 5.2, sonnet 8.0.

### HTS 카탈로그

```bash
npm run hts:fetch    # USITC 공식 export → data/hts_lines.json (19,831 라인 / 1,227 호)
npm run hts:seed     # → Supabase hts_lines + rate_ledger base_mfn (종가세 17,633행)
```

`data/hts_lines.json` 은 8.6MB 라 gitignore 다 — `data/hts_lines.meta.json`(수집 메타)만 커밋한다.
스펙 §4 상 USITC 공식 데이터 적재는 허용 경로이고, **301·IEEPA 는 자동 수집 금지**라 이 스크립트가 건드리지 않는다.

### 비용 · 성능 (실측, 10 SKU 실호출 외삽)

`npm run bench -- --sample=10`:

| 항목 | k=3, 캐시 없음 | **k=1 + 프롬프트 캐싱** |
|---|---|---|
| SKU당 API 비용 | $0.0568 | **$0.0284** (상한) |
| 500 SKU | $28.39 | **$14.18** |
| 배치 wall-time | 45.9s | **38.3s** |
| §6-2 (기준 180s) | 321s ❌ | **268s** ❌ |

| 플랜 | 가격 | SKU | API 비용 | 마진 |
|---|---|---|---|---|
| Starter | $29 | 50 | $1.42 | 95.1% |
| Growth | $79 | 500 | $14.18 | 82.1% |
| Pro | $149 | 2000 | $56.72 | **61.9%** ⚠️ |

**k=1**: 자동확정을 없앤 순간 만장일치는 아무것도 게이트하지 않는다 — temperature 0 에서
94~100% 동일 답이므로 상수에 3배를 내고 있었다. sonnet 호출 4→2회, 정확도 손실 없음.

**프롬프트 캐싱**: stage-B 를 `catalog`(호별 보기 목록, 오름차순) + `questions`(상품별)로
쪼개고 catalog 에 `cache_control` 을 건다. 호가 겹치는 배치는 그 구간을 캐시에서 읽는다(0.1배).
위 측정은 배치 1개라 **쓰기만 하고 읽지 못했으므로 비용은 상한**이다 — 실제 500 SKU 실행에서는
호 중복도만큼 회수된다.

**§6-2 는 여전히 실패(268s)**. 다음 레버는 `MAX_LINES_PER_HEADING` 축소인데, 정답 라인이
잘릴 위험이 있어 60/30/20 으로 골든을 돌려 점수 곡선을 보고 자를 것.

### Section 301 · IEEPA 확정

```bash
npm run hts:ch99    # HTSUS Chapter 99 → supabase/seed/ch99_worksheet.md
```

공식 조항에서 세율을 뽑아 **관리자 확정용 워크시트**를 만든다. 자동 적재하지 않는 이유:

- **301 은 세율만 조항에 있고 적용 대상은 `U.S. note 20(x)` 열거 목록에 있다** — export 에 없다.
- 현재 시드의 4자리 301 행(`3924,CN,0.25`)은 **구조적으로 틀렸다**. 301 은 호 단위가 아니라
  **8자리 라인 단위**로 지정되고, 같은 호 안에 List 3(25%)·List 4A(7.5%)·미지정이 섞인다.
- IEEPA 는 프로그램이 겹친다 — 중국은 `9903.01.20/24`(펜타닐 +10%)와 `9903.02.xx`(상호관세)가 별도.

워크시트에서 확정한 값을 `hts_seed_50.csv` 에 옮기고 `npm run seed:rates` 로 적재한다.

### 실행

```bash
npm run golden                                      # 백엔드 자동 선택 (실 분류기면 5회 반복)
npm run golden -- --models=claude-haiku-4-5,claude-sonnet-4-6 --runs=5 --out=test-results-v3.md
npm run golden -- --backend=edge                    # 배포된 Edge Function (제품 경로)
npm run golden -- --backend=anthropic --model=X     # 배포 없이 로컬에서 동일 파이프라인
npm run golden -- --backend=mock                    # 결정론 기준선
```

`--runs=N` 은 캐시를 우회해 **모델 자체의** 재현성을 잰다. 사용자 체감 재현성은 캐시가 보장한다.

## 주의 (운영 전 필수)

- 시드 rate는 **테스트용 스냅샷**입니다. base MFN은 `npm run seed:rates -- --usitc <export.csv>` 로 USITC 공식 데이터를 적재하고, **Section 301·IEEPA는 관리자가 수기 입력**하세요 (시드의 SAMPLE 행은 예시값).
- MVP는 **종가세(ad valorem)만** 지원. 종량세/복합세 HTS는 시드 스크립트가 건너뜁니다.
- MPF min/max는 FY2025 값 — 매년 10/1 CBP 고시 확인 후 `fee_settings` 갱신.
- react-router 7.18.2의 npm audit 경고 1건은 RSC 모드 전용 이슈로 본 SPA에는 해당 없음 (패치판 출시 시 업그레이드).
