# 광고그룹: landed cost 의도

Google Ads 에 넣을 두 번째 광고그룹의 사양과 그 근거.

**코드가 아니라 계정 설정이다.** `docs/ads-negative-keywords.md` 와 같은 이유로 여기
적어 두고 사람이 Ads UI 에 넣는다.

---

## 왜 만드는가 — 첫 테스트는 엉뚱한 걸 쟀다

지난 캠페인 3일치: **노출 1,927 · 고유 검색어 127 · 클릭 63 (CTR 3.3%) · 전환 0.**
대상 밖 질의는 노출의 1.3% 뿐이었다.

즉 **수요는 측정됐다.** 사람들이 검색하고, 광고를 클릭한다.

문제는 무엇을 물었느냐다. 그 캠페인은 `hts code lookup` 의도의 사람을 데려와서
**무료 조회**를 보여주고 **"바뀌면 알려드릴게요" 이메일**을 요구했다.

| | |
|---|---|
| 측정한 것 | 정보를 얻은 사람이 미래 알림을 위해 이메일을 줄 것인가 |
| 측정 **안** 한 것 | 수입업자가 landed cost 와 마진에 돈을 낼 것인가 |

둘은 다른 일(job)이다. 조회는 USITC 가 무료로 제공하는 상품이고, 차별점은 landed
cost 쪽인데 **거기로는 광고 트래픽을 한 번도 보낸 적이 없다.**

이 광고그룹은 그 질문을 산다.

---

## 착지 페이지: `/sample-report`

`/hts` 가 아니다. landed cost 의도의 사람에게 무료 조회 화면을 보여주면 어긋난다.

`/sample-report` 를 고른 이유:

- 제목이 `Sample landed cost report` 다 — 검색 의도와 문구가 맞는다
- **이메일 없이** 관세 스택 → landed cost → 마진 → 권장가를 전부 보여준다
- 5개 SKU 예시가 실제 엔진 출력이다 (`npm run sample:build`, CI 가 드리프트를 막는다)
- CTA 폼이 이미 있다

### 먼저 고친 것

이 페이지는 **CTA 폼이 계측돼 있지 않았다.** `analytics.js` 는 로드되어 `page_view`
는 남았지만, 폼 제출·저장·실패는 `window.plausible` 만 부르고 `window.track` 은
부르지 않았다. 그리고 실패 시 버튼만 원복되고 **사용자에게 아무 메시지도 안 나갔다.**

지난번 실패가 정확히 이 모양이다 — 광고비는 나가는데 어디서 죽었는지 안 남는다.
`/hts` 와 블로그에서 이미 고친 결함이 하필 이 페이지에만 남아 있었다.

  sample_cta_submitted   폼 제출
  sample_saved           저장 성공  ← 이 광고그룹의 전환
  sample_failed          저장 실패 (사유 포함) + 화면 메시지

`scripts/check-build.ts` 의 `FUNNEL_PAGES` 에 등록했다. 이 셋 중 하나라도 빠지면
빌드가 실패한다.

---

## 최종 URL

```
https://www.landediq.app/sample-report?utm_source=google&utm_medium=cpc&utm_campaign=landed_cost&utm_term={keyword}
```

`{keyword}` 는 Ads 의 ValueTrack 이라 실제 검색어로 치환된다.

**UTM 없이 지나간 클릭은 소급이 안 된다.** 어떤 키워드가 데려왔는지 영원히 모른다.
등록 직후 클릭 몇 건 뒤 `supabase/funnel.sql` 2번으로 `(direct)` 가 아닌지 확인한다.

---

## 키워드 (구문검색)

예산이 작으므로 확장검색을 쓰지 않는다. 확장은 의도를 넓히는 대신 무엇을 샀는지
흐린다 — 지금 필요한 건 규모가 아니라 **깨끗한 답**이다.

```
"landed cost calculator"
"import cost calculator"
"total landed cost"
"landed cost china to usa"
"import duty calculator usa"
"customs duty calculator usa"
"calculate import duty from china"
"import tariff calculator"
```

| 키워드 | 의도 |
|---|---|
| `landed cost calculator` | **원가 결정** — 지불 의사가 가장 가까운 자리 |
| `import cost calculator` | 같은 의도, 다른 표현 |
| `total landed cost` | 개념을 알고 도구를 찾는 사람 |
| `landed cost china to usa` | 원산지가 명시된 실무 질의 |
| `import duty calculator usa` · `customs duty calculator usa` | 관세 중심이지만 US 수입이 확실 |
| `calculate import duty from china` | 301 이 걸리는 대표 경로 |
| `import tariff calculator` | 관세 중심 |

첫 네 개가 이 광고그룹의 핵심이다. 뒤 네 개는 landed cost 어휘를 안 쓰는 사람을
잡되, 성과가 갈리면 앞뒤를 분리한다.

---

## 제외 키워드 (이 광고그룹)

계정 수준 제외(`docs/ads-negative-keywords.md`)에 더해 넣는다.

```
excel
template
formula
spreadsheet
"what is"
definition
meaning
course
tutorial
job
salary
```

| 묶음 | 막는 것 |
|---|---|
| `excel` `template` `formula` `spreadsheet` | 직접 계산하려는 사람 — 도구를 살 의사가 없다 |
| `"what is"` `definition` `meaning` | 용어를 배우려는 사람 |
| `course` `tutorial` | 학습 의도 |
| `job` `salary` | 직무 검색 |

목적지가 미국이 아닌 질의(`canada` · `england` 등)는 이미 계정 수준에 있다.

---

## 광고 문안 (반응형 검색 광고)

글자수는 검증했다 — 헤드라인 30자, 설명 90자 이내다.

### 헤드라인

```
True landed cost per SKU
Duty, freight, fees in one
See the full duty stack
MFN plus Section 301
Landed cost calculator
Import duty, layer by layer
Know your margin after duty
Official USITC tariff data
Effective-date aware rates
No silent zeroes
Sample report, no email
Built by freight operators
```

### 설명

```
Base duty, Section 301 and fees separated by HTS line. See a full sample report first.
Turn a duty rate into landed cost, true margin and the price you need per SKU.
Official USITC data, effective-date aware. Unresolved coverage is flagged, not guessed.
Free during validation. See the sample report before giving an email address.
```

문안이 사이트가 실제로 하는 말과 같다 — `No silent zeroes` · `Effective-date aware`
는 `/methodology` 와 랜딩에 그대로 있는 문구다. 광고와 착지가 다른 말을 하면 품질
평가점수가 깎이고, 그보다 먼저 사용자가 떠난다.

**`Sample report, no email` 은 사실이어야 한다.** 지금 사실이다 — 리포트 전체가
이메일 없이 보인다. 이 문구를 남기려면 그 상태를 유지해야 한다.

---

## 전환

Ads 전환은 이미 붙어 있다 — `public/ads.js` 의 `sample` 라벨, 폼 저장 성공 시
`window.trackConversion('sample')`.

우리 쪽 판정은 `sample_saved` 로 한다. Ads 전환과 별개로 세는 이유는, Ads 는
클릭에 귀속된 전환만 보여주는데 우리는 **어디서 죽었는지**를 봐야 하기 때문이다.

---

## 규모와 멈추는 조건

지난 캠페인 CPC 는 대략 ₩2,139 (₩134,729 / 63클릭) 였다.

전환율 0% 와 5% 를 구별하려면 **60~100 클릭**이 필요하다. 63클릭 0전환으로는
아무 결론도 못 냈다 — 전환율이 진짜 3% 여도 63클릭에서 0건이 나올 확률이 14.7%
이고 95% 신뢰 상한은 4.8% 였다.

  목표      80~100 클릭
  예상 비용 ₩170,000 ~ ₩215,000

**중간에 멈출 조건**

| 관측 | 판단 |
|---|---|
| 클릭 20건에 `sample_cta_submitted` 0 | 착지 페이지가 의도와 안 맞는다 — 문구·레이아웃부터 |
| `sample_failed` 가 성공보다 많다 | 저장 경로 고장 — **즉시 멈추고 고친다** |
| `page_view` 는 있는데 스크롤이 안 됨 | 첫 화면에서 이탈 — 히어로가 답을 안 준다 |

**끝까지 갔을 때**

| 결과 | 다음 |
|---|---|
| 전환 ≥ 3건 | 의도가 맞다. 예산을 늘리고 키워드를 넓힌다 |
| 전환 0, 제출은 있음 | 폼 이후가 문제 — 제안(무료 베타)이 약하다 |
| 제출도 0 | landed cost 의도도 이 제안으로는 안 팔린다. **광고가 아니라 고객 대화로 전환** |

마지막 줄이 중요하다. 두 번째 테스트도 0 이면 문제는 키워드가 아니라 제안이고,
그건 트래픽을 더 사서 알아낼 수 없다.

---

## 읽는 쿼리

`supabase/funnel.sql` 을 쓴다. 이 광고그룹만 보려면 2번 쿼리에서:

```sql
where a.campaign = 'landed_cost'
```

내부 방문은 이미 제외된다 (`/?internal=1` 로 표시한 브라우저).
