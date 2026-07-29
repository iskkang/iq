# LandedIQ MVP — Claude Code 빌드 스펙 v1

제품 전체(계산기 본체 + 결제)를 만들기 위한 문서. 랜딩 3장은 별도 문서(landed-cost-smoke-test-v1.md) 기준으로 이미 진행.

## 0. 제품 한 줄 정의

미국 중소 수입셀러가 상품 CSV를 올리면 → HTS 후보 추정 → 관세·수수료·운임을 배부해 → SKU별 landed cost·실제 마진·권장 판매가를 리포트로 주는 웹앱.

## 1. 원칙 (전 기능 공통 제약)

1. **계산은 코드가, 분류만 LLM이** — 관세 계산식은 결정론적 코드. LLM은 HTS 후보 추정에만 사용.
2. **Estimates only** — 모든 화면·리포트·이메일에 "관세 추정치이며 통관·법률 자문이 아님, 최종 HTS 분류 책임은 수입자(importer of record)" 고지 고정 노출.
3. **Human-in-the-loop** — LLM 분류 confidence가 낮으면 자동 확정하지 않고 관리자 리뷰 큐로 보낸다.
4. **관세율은 원장 테이블로** — 코드에 하드코딩 금지. 발효일(effective date)이 있는 rate 테이블을 관리자가 갱신하는 구조. 2025~26년처럼 세율이 수시로 바뀌는 환경이 전제.

## 2. MVP 범위

### 포함

- 이메일 가입/로그인 (Supabase Auth)
- 워크스페이스 1개/계정
- 입력: CSV 업로드(컬럼: sku, product_name, description_or_material, unit_cost_usd, origin_country, units_per_shipment) + 단건 수동 입력
- 선적 단위 입력: 총 운임 USD, 보험료 USD, 운송모드(ocean/air), 배부 기준(가액 or 중량 — 중량 없으면 가액)
- HTS 추정: 상품명·소재·설명 기반 LLM이 HTS 후보 2~3개 + confidence + 근거 1줄 반환(JSON). 사용자가 1개 확정
- 관세 계산(§4 수식) → SKU별 결과 테이블
- 리포트: 화면 테이블 + CSV 다운로드 + PDF 다운로드 (컬럼: SKU / Unit cost / HTS / Duty % 내역 / Duty $ / Fees / Freight per unit / Landed cost / Current price / True margin / Recommended price)
- 권장 판매가: landed_cost ÷ (1 − target_margin − channel_fee%) — target_margin·channel_fee(예: Amazon 15%)는 사용자 입력
- Stripe Checkout + Customer Portal: Free(SKU 3개 1회) / Starter $29(월 50 SKU) / Growth $79(월 500 SKU) / Pro $149(무제한). 연간 = 10개월 가격. 월 SKU 사용량 카운트·제한
- 관리자 화면(운영자 전용): 리뷰 큐(저신뢰 HTS 확정/수정), rate 테이블 CRUD, 사용자·사용량 조회

### 제외 (요청 있어도 만들지 말 것)

- EU 관세(2단계), Shopify 앱스토어 네이티브 앱(2단계 — 웹앱 먼저), 실시간 화물추적, 선사/관세청 API 연동, AD/CVD(반덤핑·상계관세) 계산, HTS 법적 확정, 환율 자동화(USD 고정), QuickBooks 연동, 챗봇, 다국어

## 3. 스택 (제약)

React + Vite + TypeScript + Tailwind / Supabase(Auth·Postgres·Storage·RLS) / LLM API(분류용) / Stripe / Vercel 배포. 세부 파일 구조·테이블 설계는 Claude Code가 결정하되, §4의 rate 원장 개념과 RLS(고객 데이터 격리)는 필수.

## 4. 관세 계산 명세 (핵심 — 그대로 구현)

SKU별:

```
duty_rate_total = base_mfn_rate + section301_rate + ieepa_reciprocal_rate   # 각 레이어는 rate 원장에서 HTS×원산지×발효일로 조회, 없으면 0
duty_usd        = unit_cost × duty_rate_total
freight_unit    = (총운임+보험) × 배부비중(가액 기준: 해당 SKU 가액/선적 총가액)
mpf_unit        = min·max 캡 적용한 MPF(선적 단위 0.3464%)를 가액 비중으로 배부   # min/max 금액은 연도별 조정되므로 설정값
hmf_unit        = ocean일 때만 가액 0.125% 배부
landed_cost     = unit_cost + duty_usd + freight_unit + mpf_unit + hmf_unit
true_margin     = (current_price − landed_cost − current_price×channel_fee%) / current_price
```

- rate 원장 초기 데이터: USITC HTS 공식 데이터(hts.usitc.gov, JSON/CSV 제공)에서 base MFN 시드. Section 301·IEEPA 레이어는 관리자가 수기 입력(자동 스크래핑 금지)
- 리포트에 적용된 레이어 내역(예: MFN 6.5% + 301 25% + IEEPA 10%)과 rate 기준일을 반드시 표기

## 5. HTS 분류 요건

- 프롬프트 출력: `[{hts_code(10자리), confidence(0~1), rationale(1문장)}] × 2~3`
- confidence < 0.7 → "Needs review" 상태로 리뷰 큐 이동, 리포트에는 잠정 표시
- 사용자가 HTS 직접 입력·수정 가능 (그 경우 confidence 무시)
- 분류 이력 저장(모델·프롬프트 버전 포함) — 클레임 대응용

## 6. 수용 기준 (완료 정의)

1. 골든 테스트: 실제 상품 10건(SKU·소재·원산지·단가를 내가 제공)에 대해 duty 계산이 수기 계산과 일치
2. CSV 500행 업로드 → 리포트까지 3분 이내
3. Free 계정이 4번째 SKU 분석 시도 시 결제 유도 화면
4. Stripe 테스트모드에서 가입→결제→한도상향→해지 전 과정 통과
5. 모든 리포트·화면에 estimates-only 고지 노출
6. 다른 계정의 데이터가 API·화면 어디서도 보이지 않음(RLS)

## 7. 빌드 순서

- Phase 1 (코어): 가입 → CSV 업로드 → HTS 추정 → 계산 → 화면 리포트 + CSV 다운로드
- Phase 2 (수익화): Stripe·사용량 제한 → PDF 리포트 → 관리자 리뷰 큐·rate 원장 화면
- Phase 1 완료 시점에 MTL 실서류로 골든 테스트부터 통과시킬 것. 통과 전 Phase 2 착수 금지.
