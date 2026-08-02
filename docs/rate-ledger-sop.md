# 관세 원장 유지 SOP

주 2~3시간. 이 문서의 목적은 **원장 유지를 승계 가능한 자산으로 만드는 것**이다.
오너가 아니어도 이 절차만 따르면 원장을 최신으로 유지할 수 있어야 한다.

> 이 SOP 의 핵심은 §1 판별 원칙이다. 나머지는 그로부터 따라 나오는 절차다.

---

## §1 판별 원칙 — 관세표 텍스트는 시행 근거가 아니다

**2026-07-29 에 실제로 확인한 사실:**

USITC 공식 HTS Chapter 99 export 를 받아보면 아래가 **정상 조항처럼 보이는 형태로** 들어 있다:

| 조항 | 내용 | 실제 상태 |
|---|---|---|
| `9903.01.20` / `.24` | 중국 IEEPA +10% | **2026-02-20 연방대법원 무효, 02-24 종료** |
| `9903.02.26` | 인도 IEEPA +25% | 동일하게 무효 |
| `9903.02.69` | 베트남 IEEPA +20% | 동일하게 무효 |
| `9903.03.01` | Section 122 +10% | **2026-07-24 만료** |

조항 본문 어디에도 "무효" 나 "만료" 표시가 없다. 세율과 적용 대상이 그대로 적혀 있다.

**따라서 원장에 넣을 값을 관세표에서 바로 옮겨 적으면 안 된다.**
관세표는 *무엇이 존재하는가* 를 말하지 *지금 무엇이 적용되는가* 를 말하지 않는다.

### 교차확인 3단 (모든 세율 변경에 적용)

| 단계 | 확인처 | 답해야 할 질문 |
|---|---|---|
| 1. 권한 | 대법원·연방항소법원 판결, 대통령 EO | 이 관세를 부과할 **법적 권한이 살아 있는가** |
| 2. 시행 | CBP CSMS 공지 | CBP 가 **실제로 징수하고 있는가**, 발효·종료 시각은 |
| 3. 범위 | USTR Federal Register annex, HTSUS U.S. notes | **어떤 HTS 라인·국가**에 붙는가, 면제는 |

세 단계가 모두 확인돼야 원장에 넣는다. 하나라도 비면 `note` 에 무엇이 미확인인지 적는다.

**한 단계만 보면 틀린다:**
- 관세표만 → 무효 조항을 적용한다 (오늘 실제로 벌어질 뻔한 일)
- 판결만 → 대체 프로그램(Section 122 → 강제노동 301)을 놓친다
- 세율만 → 4자리 호 전체에 25% 를 매긴다 (301 은 8자리 라인 단위)

---


### 2층 — 분기 점검: 선언과 실제 대조

CI 의 스키마 검사(scripts/check-schema.ts)는 **마이그레이션 선언**을 본다. SQL Editor 로
직접 바꾼 것(Vault 시크릿·RLS 정책 등)은 마이그레이션에 없으므로 통과하고도 DB 는
다를 수 있다. getFees 가 "DB 를 읽는다"고 선언돼 있었지만 테이블이 비어 있던 것과
같은 구조다. 분기마다 실제 DB 를 한 번 조회한다.

SQL Editor 에서:

```sql
-- 1) 참조 테이블에 발효일·근거 컬럼이 실제로 있는가
select c.table_name,
       bool_or(c.column_name = 'effective_from') as has_from,
       bool_or(c.column_name = 'effective_to')   as has_to,
       bool_or(c.column_name = 'source')         as has_source
  from information_schema.columns c
 where c.table_schema = 'public'
   and c.table_name in ('rate_ledger','duty_programs','fee_settings','program_exclusions')
 group by c.table_name
 order by c.table_name;
-- 셋 중 하나라도 false 면 마이그레이션 선언과 DB 가 어긋난 것이다

-- 2) 참조 테이블이 비어 있지 않은가 (빈 테이블 = 조용한 폴백의 원인)
select 'rate_ledger' as t, count(*) from public.rate_ledger
union all select 'duty_programs', count(*) from public.duty_programs
union all select 'fee_settings',  count(*) from public.fee_settings;

-- 3) 열린 행이 키당 하나인가 (부분 유니크 인덱스가 막지만 확인은 별개)
select count(*) as open_fee_rows from public.fee_settings where effective_to is null;
```

### 요율을 갱신했으면 샘플 fixture 도 함께 갱신한다

```bash
npm run sample:check-inputs   # fixture 가 DB 현재값과 같은지 대조
npm run sample:build          # 다르면 갱신 (HTML·랜딩 표까지 함께 재생성)
```

CI 의 드리프트 가드는 자격증명이 없어 오프라인으로 돈다 — `sample-report.inputs.json`
에 적힌 그 시점 값으로 재생성해 손편집만 잡는다. **그 fixture 는 두 번째 출처가
아니다.** 수수료의 진실 출처는 여전히 DB 이고, 둘이 갈라지는 것은 위 명령이
감시한다. 요율 반영 절차와 분기 점검에서 반드시 한 번 돌릴 것.

### 새 참조 테이블을 추가할 때 — 0행을 실패로 볼 것인가

판정 기준은 "0행이 정상인가" 가 **아니다.** 0행이 숫자를 어느 방향으로 미는가다.

| 0행의 효과 | 처리 | 해당 |
|---|---|---|
| 관세를 **낮춘다** (과소계상) | 명시적 실패 | `rate_ledger` · `duty_programs` · `fee_settings` |
| 관세를 **높이거나 중립** | 정상 상태 | `program_exclusions` |

면제가 없으면 전액 부과 — 안전한 방향이다. 원장이 비면 duty 0 — 이 제품이
없애준다고 약속한 손해가 그대로 발생한다.

미검증 면제를 적용하지 않기로 한 것(`exclusionStatus` 의 `unverified`)과 같은
비대칭 원칙이다. 과대계상은 고객이 예산을 넉넉히 잡을 뿐이지만, 과소계상은
가격을 잘못 매겨 마진을 잃는다.

같은 규칙을 `src/lib/repo/errors.ts` 상단에도 적어뒀다 — 새 테이블을 붙이며
코드를 열었을 때도 보이도록.

### 반영 절차 — 갱신은 "직전 행 닫기 → 신규 insert" 한 트랜잭션

**규칙: 현행 행의 `effective_to` 는 평소 비워두고, 갱신은 반드시 한 트랜잭션에서
`직전 행 닫기 → 신규 insert` 순서로 한다.**

```sql
begin;
  -- 1) 직전 행을 먼저 닫는다
  update public.fee_settings
     set effective_to = DATE '2026-10-01'
   where effective_to is null;
  -- 2) 그 다음에 신규 행을 넣는다
  insert into public.fee_settings (mpf_rate, mpf_min_usd, mpf_max_usd, hmf_rate,
                                   effective_from, source)
  values (0.003464, ..., ..., 0.00125, DATE '2026-10-01', '<관보 인용>');
commit;
```

**이유가 둘이고 서로 다르다. 섞어 읽으면 틀린 결론이 나온다.**

| 막으려는 것 | 해결책 | 순서와의 관계 |
|---|---|---|
| **커버 공백** — 외부 조회가 "덮는 행 없음" 을 본다 | `begin/commit` 으로 감싼다 | **무관.** 원자성이 중간 상태를 감춘다 |
| **제약 위반 23505** — 열린 행이 순간적으로 둘이 된다 | `닫기 → 넣기` 순서 | **결정적.** 순서가 곧 성패다 |

#### 왜 `닫기 → 넣기` 인가 (실측)

부분 유니크 인덱스(`*_one_open`)가 `effective_to is null` 행을 키당 하나로 강제한다.
이 인덱스는 DEFERRABLE 이 아니다 — Postgres 는 unique **인덱스** 를 지연할 수 없고
`deferrable` 은 constraint 전용이다. 그래서 트랜잭션 안이라도 문장 단위로 즉시
검사되고, 신규를 먼저 넣으면 그 시점에 열린 행이 둘이 되어 위반이다:

```
신규 먼저  → 23505  duplicate key value violates unique constraint "fee_settings_one_open"
닫고 나서  → 204 → 201  성공
```

#### 그래서 트랜잭션이 선택이 아니라 **필수**가 됐다

제약이 순서를 `닫기 → 넣기` 로 강제하는데, 그 순서에는 **열린 행이 하나도 없는
실제 구간**이 생긴다. 트랜잭션 밖에서 두 문장을 실행하면 그 사이의 조회가
"기준일을 덮는 행 없음" 으로 떨어지고, A-2 이후 그것은 사용자 화면 오류가 된다.

즉 안전장치를 넣은 결과로 트랜잭션이 load-bearing 이 됐다. 제약 도입 전에는
`begin/commit` 이 권장이었지만 지금은 빠뜨리면 실사용 장애다.

#### 닫는 걸 잊는 실수는 제약이 막는다

직전 행을 닫지 않고 신규를 넣으면 insert 자체가 실패하므로, 두 행이 조용히 열려
있는 상태는 원천적으로 불가능하다. 같은 인덱스가
`rate_ledger`(program_code, hts_code, origin_country — `nulls not distinct`) 와
`program_exclusions`(program_code, hts_code) 에도 있다. `duty_programs` 는
`code` 가 PK 라 프로그램당 행이 애초에 하나여서 두지 않았다 — 막는 게 없는
제약은 "검사되고 있다" 는 착각만 준다.

### 열린 항목 — 면제 우선순위 (471개 적재 시 검토)

현재 `exclusionStatus` 는 "확인된 면제가 하나라도 있으면 confirmed" 다. 그런데
confirmed 가 8자리 광범위 매칭이고 unverified 가 10자리 정밀 매칭이면, **덜
구체적인 행을 근거로 0% 를 적용**하게 된다 — 비대칭 원칙(의심스러우면 전액
부과)과 반대 방향이다.

현재 `program_exclusions` 는 0행이라 발생하지 않는다. 강제노동 301 의 471개
소호를 적재할 때 **실제로 그런 중첩이 있는지 먼저 확인할 것.** 없으면 현행 규칙
유지, 있으면 구체성 우선 → 그다음 검증 상태 순으로 바꾼다.

### 날짜가 박힌 점검 (놓치면 값이 조용히 낡는다)

| 날짜 | 무엇 | 근거 |
|---|---|---|
| **2026-10-01** | MPF 최소·최대 FY2027 조정 | 19 CFR 24.22·24.23 FAST Act 물가연동. 매년 10/1 시행 |
| 매년 10-01 | 이후 반복 | 종가율 0.3464%·HMF 0.125% 는 통상 불변, 최소·최대만 바뀐다 |

절차: 관보/CSMS 로 새 min·max 확인 → 한 트랜잭션에서 `fee_settings` 의 직전 행에
`effective_to` = 새 발효일을 채우고 신규 행 insert (순서는 위 "반영 절차" 참조)
→ `npm run sample:build` 로 fixture 갱신 → 골든 재실행.

**실전 사례.** FY2026 값을 기억에서 꺼내 넣었다가 한 사이클 지난 FY2025 값
(min $32.71 / max $634.62)을 현행처럼 적재했다. 실제는 90 FR 34665
(CBP Dec. 25-10) 로 min $33.58 / max $651.50 이었다. 고시 대조 없이 넣지 말 것.

## §2 주간 루틴 (2~3시간)

### 월요일 — 변경 감시 (45분)

0. **원장 드리프트 대조부터 한다** (1분)

   ```sh
   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npm run ledger:verify
   ```

   커밋된 `data/ledger.manifest.json` 과 DB 를 대조한다. **밖에서 무슨 일이
   있었는지를 먼저 확인하고 이번 주 감시를 시작하는 것**이 순서다 — 지난주에
   누가 SQL Editor 로 건드렸다면 그 위에 변경을 얹기 전에 알아야 한다.

   드리프트가 뜨면 §3 을 보고 원인을 규명한 뒤, 의도한 변경이었으면
   `npm run ledger:manifest` 로 갱신해 커밋한다.

1. **CBP CSMS** <https://content.govdelivery.com/accounts/USDHSCBP/bulletins> — 지난주 공지 훑기.
   관세 관련 키워드: `Section 301`, `Section 122`, `IEEPA`, `duty`, `9903`
2. **USTR** <https://ustr.gov/about/policy-offices/press-office/press-releases> — 신규 조치·면제 목록
3. **Federal Register** — `Section 301` 검색, 지난 7일

**변경 없음이면 여기서 끝.** 로그에 "변경 없음" 한 줄 남기고 종료.

> **왜 대조가 필요한가.** 0021(중복)·0022(아카이브 불변)는 DB 제약이라 그 경로를
> 통과할 때만 막는다. SQL Editor 는 이 저장소에서 실제로 쓰이는 경로이고, 0022 에는
> 의도적인 탈출구(`set local app.allow_archive_edit = 'on'`)도 있다. 그 길로 원장이
> 달라지면 아무것도 알려주지 않는다. 매니페스트는 그 위의 탐지 계층이다.
>
> 대조는 매니페스트에 박힌 `as_of` 를 기준일로 쓴다. 오늘 날짜를 쓰면 아무도
> 건드리지 않아도 만료가 진행돼 거짓 드리프트가 뜨고, **거짓 경보를 내는 탐지기는
> 곧 꺼진다.**

### 변경이 있으면 — 판별 (60~90분)

§1 의 3단 교차확인을 수행하고 아래를 채운다:

```
프로그램:        (신규 코드 또는 기존 코드)
권한:            Section 301 / 122 / EO / ...
발효:            YYYY-MM-DD HH:MM ET
종료:            YYYY-MM-DD 또는 미정
적용 범위:       all / country / hts_list / country_and_hts
가산 방식:       additive / top_up_to_total
세율:            
면제:            (있으면 HTS 목록 출처)
1차 출처:        (CSMS 번호 / FR 인용 / HTSUS 조항)
미확인 항목:     
```

### 반영 (30분)

1. `supabase/seed/duty_programs.csv` — 프로그램 추가 또는 `effective_to` 기입
2. `supabase/seed/hts_seed_50.csv` — 세율 행 추가 (`program_code` 필수)
3. `source` 컬럼에 1차 출처 인용, `note` 에 미확인 항목
4. `npm run test` — 골든이 통과하는지
5. `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npm run seed:rates`
6. `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npm run ledger:manifest` — 매니페스트 갱신.
   **`git diff data/ledger.manifest.json` 이 이번 변경의 요약이다.** 프로그램별 행수와
   해시가 어떻게 움직였는지 보고, 의도한 것만 바뀌었는지 눈으로 확인한 뒤 커밋한다.
   의도하지 않은 프로그램이 함께 움직였다면 여기서 멈춘다
7. 커밋 (메시지에 1차 출처 인용, 매니페스트 diff 포함)

> **종료된 프로그램은 삭제하지 않는다.** `effective_to` 만 채운다. 과거 선적을
> 그 시점 세율로 다시 계산할 수 있어야 하고, 감사 추적이 남아야 한다.

---

## §3 자주 틀리는 지점

**1. 4자리 호에 301 을 매기는 것**
Section 301 은 **8자리 HTS 라인 단위**로 지정된다. 같은 호 안에 List 3(25%)·
List 4A(7.5%)·미지정이 섞여 있다. 적용 대상은 `U.S. note 20(x)` 의 열거 목록에 있고
이건 HTS export 에 **포함되지 않는다** — USTR annex 를 따로 봐야 한다.

**2. 프로그램 이름이 같다고 같은 프로그램으로 취급하는 것**
2026년에 "Section 301" 이 두 개다:
- 중국 301 (2018, Lists 1-4A) — 중국산 8자리 라인
- 강제노동 301 (2026-07-24) — 60개 경제권 국가 단위

둘은 `program_code` 가 다르다. 뭉뚱그리면 "301 은 중국 전용" 같은 검사가 오탐한다.

**3. 상한 보정형을 가산으로 넣는 것**
"EU 는 MFN+301 합계 10%" 는 301 이 10% 라는 뜻이 **아니다**. MFN 이 9.8% 면 301 은
0.2% 다. `rate_type: top_up_to_total` 로 넣고 `ad_valorem_rate` 에 **목표 합계**를 적는다.

**4. 미확인을 0 으로 넣는 것**
원장에 행이 없으면 엔진이 "not confirmed — duty may be understated" 경고를 낸다.
**0% 행을 넣어 그 경고를 끄지 말 것.** 0% 는 "면제 확인됨" 일 때만 쓰고,
모르는 건 행을 비워둬 경고가 뜨게 한다.

---

## §4 분기 점검 (분기 1회, 2시간)

- [ ] `npm run hts:fetch && npm run hts:seed` — USITC base MFN 재적재 (연 1회 이상 개정됨)
- [ ] `npm run hts:ch99` — Chapter 99 워크시트 재생성, 신규 조항 확인
- [ ] MPF min/max 확인 — 매년 10/1 CBP 고시로 조정 (`fee_settings`)
- [ ] `duty_programs` 전체 훑기 — 만료됐는데 `effective_to` 가 비어 있는 프로그램 없는지
- [ ] 골든 10건 재실행 (`npm run golden -- --runs=1`)

---

## §5 인수인계 체크리스트

새 담당자가 아래를 스스로 할 수 있으면 승계 완료:

- [ ] §1 의 3단 교차확인을 설명할 수 있다 — **왜** 관세표만 보면 안 되는지 포함
- [ ] CSMS 공지 하나를 읽고 위 판별 양식을 채울 수 있다
- [ ] `duty_programs.csv` 에 프로그램을 추가하고 골든을 통과시킬 수 있다
- [ ] 종료된 프로그램을 삭제가 아니라 `effective_to` 로 처리하는 이유를 안다
- [ ] §3 의 네 가지 함정을 각각 예시로 설명할 수 있다

### 커밋 전 네 질문 — 이게 실제로 오류를 잡는다

CI·제약·테스트는 **이미 아는 실패 방식**만 막는다. 지금까지 잡힌 오류를 되짚어
보면 장치가 아니라 "정말 확인했는가" 를 되묻는 과정에서 드러났다. 그 역할이
사람 머릿속에만 있으면 담당자가 바뀌는 순간 사라진다. 그래서 질문 자체를 남긴다.

**원장·절차·문서를 건드린 커밋을 올리기 전에 스스로 묻는다:**

1. **이 세율을 1차 출처와 대조했는가, 아니면 기억에서 왔는가?**
2. **이 절차를 실제로 돌려봤는가, 아니면 그럴 것이라고 추론했는가?**
3. **선언(스키마·README·주석)과 동작(실제 코드 경로)이 일치하는지 확인했는가?**
4. **이 변경이 새로운 전제조건을 요구하는가?** (트랜잭션·자격증명·데이터 존재·네트워크)
   요구한다면 **네 실행 환경 전부**에서 충족되는지 확인했는가:
   **로컬 / GitHub Actions / Vercel 빌드 / pg_cron 워커**

하나라도 "아니오" 면 그 부분은 커밋하지 말고 확인부터 한다. 확인이 불가능하면
`UNVERIFIED` 로 표시하고 넘어간다 — 확인한 것처럼 적는 것이 가장 나쁘다.

> **4번을 환경 목록으로 적는 이유.** "모든 환경에서 되는지 확인" 이라고 쓰면
> 다음 사람이 로컬만 보고 넘어간다. 실제로 두 번 그랬다 — 부분 유니크 인덱스는
> 트랜잭션을, DB 수수료는 자격증명을 새로 요구했고 **둘 다 로컬에서는 충족되고
> 다른 환경에서는 안 됐다.** 장치를 추가할 때 그 장치가 만드는 새 의존을 세는
> 습관이 없으면, 안전장치가 다른 안전장치를 깨뜨린다.

<details><summary>실제로 걸린 사례</summary>

| 오류 | 걸리는 질문 |
|---|---|
| 빈 타입체크를 "통과" 로 보고 | 3 — 명령이 그 파일을 실제로 보는지 확인 안 함 |
| FY2025 MPF 값을 현행처럼 적재 | 1 — 기억에서 꺼내 관보 대조 안 함 |
| 트랜잭션 문장 순서를 SOP 에 기록 (두 번, 두 번 다 반대) | 2 — 돌려보지 않고 추론 |
| `isExcluded` 가 `effective_to` 를 안 읽음 | 3 — 컬럼은 추가했는데 판정 로직 미확인 |
| `getFees` 가 DB 를 읽지만 테이블이 비어 상수로 폴백 | 3 — 선언은 DB, 동작은 상수 |

</details>

---

## 부록 — 2026년 타임라인 (판별 사례)

| 날짜 | 사건 | 원장 반영 |
|---|---|---|
| 2025-04-09 | IEEPA 상호관세 시행 | `ieepa-reciprocal` effective_from |
| 2026-02-20 | 대법원 6-3 (Roberts): IEEPA 는 관세 권한 없음 | — (판결일, 종료일 아님) |
| 2026-02-24 | IEEPA 종료 / Section 122 시행 (10%, 전면) | IEEPA `effective_to`, `122` effective_from |
| 2026-07-24 | 122 만료 (150일 상한) / 강제노동 301 시행 | `122` effective_to, `301-forced-labor` effective_from |

**5개월에 세 번.** 이 빈도가 원장 유지를 해자로 만드는 동시에 영구 운영비로 만든다.
그래서 이 SOP 가 존재한다.
