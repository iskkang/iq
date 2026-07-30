# LandedIQ — Phase 1 (코어)

[![check](https://github.com/iskkang/iq/actions/workflows/check.yml/badge.svg)](https://github.com/iskkang/iq/actions/workflows/check.yml)

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
| `npm run test` | 단위 테스트 123건 (§4 계산식 + 골든 10건 + CSV 파싱 + 301 원산지 스코핑 + 분류 파이프라인) |
| `npm run golden` | 골든 테스트 실행 (`golden-test-products.csv` → `test-results.md`) |
| `npm run check` | **커밋 전 이것만 돌리면 된다** (push 하면 CI 가 같은 걸 자동 실행) — tsc(src) + tsc(scripts·tests) + deno check(Edge) + vitest + oxlint |
| `npm run bench` | §6-2 벤치마크 (`--sample=N` 비용, `--concurrency=N` 웨이브 실측) |

> **push 전 자동 실행**은 `npm install` 이 postinstall 로 켜준다. 수동으로 켜려면
> `git config core.hooksPath .githooks`.
> 산문으로만 남은 규칙은 어겨진다 — 실제로 연속 두 커밋에서 어겨 CI 를 깨뜨렸다.
> 긴급 시 `git push --no-verify` 로 우회할 수 있고, CI 가 뒤에서 다시 잡는다.
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
| §검증1 판정 규칙 | **3회 이상 실행의 최솟값**으로 판정한다. temperature 0 이어도 회차 간 편차가 있어(같은 코드로 7.0/8.0) 평균은 운 좋은 회차가 나쁜 회차를 가린다 |
| §2-3 계산 정확도 | ✅ 통과 — 배부 보존·MPF 캡 3경로 |
| §2-4 원산지 스코핑 | ✅ 통과 |
| §6-2 500 SKU 3분 | 🔁 **기준 교체 완료** — 180초 폐기. 비동기 큐(pg_cron)로 전환해 "첫 결과 60초 / 완료 10분" 으로 재정의 |
| §3 E2E | ⛔ 미집행 — UI 수동 수행 필요 |

**광고 집행 블로커**: §3(E2E 수동 수행) · 중국 레거시 301 8자리 목록 · 푸터 사업자 정보(심사 요건).
샘플·랜딩은 베트남 원산지로 옮겨 현재 원장만으로 완결이므로 표시 오류는 없다.

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
| 500 SKU 완료 (기준 10분) | 321s ✅ | **268s** ✅ |

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

**동시성 실측** (`npm run bench -- --concurrency=16`) — 배치 16개를 실제로 동시에 친다:

| | 배치 1개 | 동시 16 |
|---|---|---|
| 웨이브 wall-time | 38.3s | **50.0s** (+31%) |
| 웨이브 수 | 7 | 4 |
| 외삽 | 268s | **200s** ❌ |

배치 1개를 재고 상수로 나누면 4×38.3=153s 로 **PASS 라고 잘못 나온다**. 부하에서 웨이브가
길어지므로 반드시 실측해야 한다. 16/16 성공, 레이트리밋 없음.

### 성능 기준 — 180초를 버리고 비동기로

**옛 기준(§6-2: 500 SKU 를 180초 안에)은 폐기했다.** 동시성 16 실측이 200초였고, 더 밀어붙이면
`MAX_LINES_PER_HEADING` 을 줄여 정확도를 깎는 수밖에 없었다. 정확도를 파는 대신 기다림의
성질을 바꿨다 — 사용자는 500건이 다 끝나기를 기다릴 필요가 없다.

| 새 기준 | 값 | 근거 |
|---|---|---|
| 첫 결과가 화면에 | **60초** | 크론 디스패치 ≤10s + 첫 배치(10건) 20~30s + 폴링 2s |
| 500 SKU 전량 완료 | **10분** | 실측 외삽 268s — 예산의 45% |

작업은 `classification_jobs` 큐에 들어가고 pg_cron 워커가 처리한다. 브라우저를 닫아도
계속 돌고, 결과는 아이템 단위로 저장되므로 도착하는 대로 표에 나타난다.
설치·운용은 [docs/async-worker-setup.md](docs/async-worker-setup.md).

### 조용한 실패를 없애는 장치

이 저장소가 반복해서 겪은 실패는 전부 같은 모양이었다 — **틀린 상태가 정상처럼 보인다.**
원장에 행이 없으면 duty 0, 빈 명령이 "타입체크 통과", 배포본에만 살아 있던 `userB`,
정답 6자리 아래 아무 라인이나 집기. 그리고 이 제품이 파는 문제 자체가 그것이다:
무효가 된 조항이 관세표에서는 정상 조항처럼 보인다.

그래서 조용히 틀리는 자리를 하나씩 시끄럽게 바꿨다.

| 자리 | 예전 (조용한 실패) | 지금 |
|---|---|---|
| 프로덕션 env 누락 | 인메모리 데모로 전환 → 새로고침에 데이터 소실 | `main.tsx` 가 화면을 띄우지 않고 원인을 표시 |
| 빌드 시 `%VITE_*%` 미치환 | 랜딩 폼이 없는 호스트로 POST → 이메일 소실 | `npm run build` 가 실패 (`scripts/check-build.ts`) |
| 랜딩 표를 손으로 수정 | 제품 수치와 조용히 어긋남 | CI 드리프트 가드가 실패 |
| Vault 이름·값 불일치 | 크론은 도는데 401·404 누적 | `ops.worker_selftest()` 가 상태 코드로 진단 |
| 워커 키 플레이스홀더 | 저장은 되고 호출만 실패 | `ops.set_worker_service_key()` 가 저장 전 거부 |
| 봇 가입 | 전환율 지표 오염 | honeypot 필드 + 이메일 unique(대소문자 무시) |
| 배포본과 로컬 분기 | `userB` 처럼 배포본에만 버그 | `--backend=edge` 대조 (최근 실측 10/10 동일) |

### 검사 범위 — 왜 `npm run check` 가 생겼나

한동안 **`scripts/` 와 `supabase/functions/` 가 어떤 검사에도 걸리지 않았다.**
`tsconfig.app` 은 `src` 만, `tsconfig.node` 는 `vite.config.ts` **한 파일만** 본다.
tsx 는 타입을 지우고 실행하고, oxlint 는 정의되지 않은 변수를 잡지 않는다.

결과는 두 가지로 나타났다:

- 배포된 분류기의 재시도 경로가 정의되지 않은 변수(`userB`)를 참조한 채 살아남았다.
  `deno check` 는 이걸 `TS2304` 로 즉시 잡는다 — 검사를 안 돌렸을 뿐이다.
- `golden-run.ts` 의 타입 오류가 3분짜리 LLM 실행 뒤 런타임에서야 터졌다.
  한 번 도는 데 실제 API 비용이 드는 스크립트라 재시도 한 번이 그대로 시간이 된다.

`npm run check` 가 네 계층을 한 번에 본다. 40초 걸린다.

| 계층 | 도구 | 대상 |
|---|---|---|
| 앱 | `tsc -b` | `src/` |
| 스크립트·테스트 | `tsc -p tsconfig.scripts.json` | `scripts/`, `tests/`, `supabase/seed/` |
| Edge Function | `deno check` | `supabase/functions/` (Deno 런타임이라 tsc 로는 못 본다) |
| 동작·스타일 | `vitest`, `oxlint` | 전체 |

### 관세 프로그램 (발효일 기반)

레이어 enum(`base_mfn`/`section301`/`ieepa_reciprocal`)을 버리고 `duty_programs` 테이블로
일반화했다. 2026년 5개월에 체계가 세 번 바뀌었고 — IEEPA(대법원 무효, 02-24 종료) →
Section 122(07-24 만료) → 강제노동 301 — 마이그레이션 없이 프로그램을 추가·종료할 수 있어야 한다.

**결정적 근거**: USITC 공식 HTS Chapter 99 에는 **무효화된 IEEPA 조항이 그대로 남아 있고
만료된 Section 122 도 들어 있다.** 관세표 텍스트는 "지금 시행 중"의 근거가 못 된다.

프로그램 속성 세 가지:

| 속성 | 값 | 왜 필요한가 |
|---|---|---|
| `effective_from/to` | 날짜 | IEEPA 는 `effective_to=2026-02-24` 라 그 이후 계산에서 **데이터만으로** 빠진다 |
| `scope_type` | `all` / `country` / `hts_list` / `country_and_hts` | 중국 301 은 8자리 라인 목록, 강제노동 301 은 국가+면제, 122 는 전면. 이걸 안 두면 "4자리 호 전체에 25%" 같은 구조적 오류를 다시 낸다 |
| `rate_type` | `additive` / `top_up_to_total` | EU·대만 "합계 10%", 일본·한국·스위스 "합계 12.5%" 는 상한 보정형이다. `Σ layers` 로는 이 원산지에서 틀린 숫자가 나온다 |

`top_up_to_total` 은 가산분을 먼저 합산한 뒤 **목표에 못 미치는 차액만** 더한다
(일본 + MFN 4.9% → 301 은 7.6%, 합계 12.5%). 면제(`program_exclusions`)는 해당 프로그램만
0 으로 만들고 리포트에 사유를 남긴다.

**엔진은 단일 경로다.** 구 레이어 폴백(`lookupLayerRate`/`lookupDutyLayers`/`expectedLayers`)은
삭제했다 — 두 경로가 공존하면 골든이 제품이 실제로 쓰는 경로를 재지 못한다
(`pipeline.ts` 를 한 벌로 유지하는 것과 같은 이유). `computeShipment` 는 `ProgramContext` 를
필수로 받는다.

[programs.ts](src/lib/calc/programs.ts) · [migration 0004](supabase/migrations/0004_duty_programs.sql) ·
테스트 [calc.programs.test.ts](tests/calc.programs.test.ts)

### 원장 유지 SOP

[docs/rate-ledger-sop.md](docs/rate-ledger-sop.md) — 주 2~3시간, 승계 가능하도록 문서화.

핵심은 §1 판별 원칙: **관세표 텍스트는 시행 근거가 아니다.** 오늘 USITC 공식 export 에서
무효화된 IEEPA 조항과 만료된 Section 122 가 정상 조항 형태로 그대로 나왔다. 그래서
① 권한(판결·EO) ② 시행(CBP CSMS) ③ 범위(USTR annex·U.S. notes) 3단 교차확인을 거쳐야
원장에 넣는다.

### Section 301 확정

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
