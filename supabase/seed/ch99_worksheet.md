# Section 301 · IEEPA 확정 워크시트

출처: USITC HTS **Chapter 99, Subchapter III** 공식 export (`https://hts.usitc.gov/reststop/exportList`).
생성: `npm run hts:ch99` ([scripts/fetch-ch99.ts](../../scripts/fetch-ch99.ts))

> ⚠️ **이 문서는 자동으로 원장에 들어가지 않는다.** 스펙 §4 대로 301·IEEPA 는 관리자가 수기 입력한다.
>
> ⛔ **더 중요한 경고: 아래 IEEPA 조항(9903.01/.02)은 전부 무효다.**
> 2026-02-20 연방대법원 6-3 판결로 IEEPA 관세 부과 권한이 부정됐고 02-24 종료됐다.
> Section 122(9903.03)도 2026-07-24 만료됐다. **그런데 공식 관세표에는 그대로 남아 있다.**
> 이 워크시트를 세율 사전으로 쓰되, **시행 여부의 근거로는 절대 쓰지 말 것** —
> 판별 절차는 [rate-ledger-sop.md](../../docs/rate-ledger-sop.md) §1 참조.

## 왜 자동 적재가 불가능한가

**1. 301 은 세율은 조항에, 적용 대상은 note 에 있다.**
`9903.88.01` 은 "+25%"라고만 말하고, 어떤 8자리 HTS 가 List 1 인지는 `U.S. note 20(a)` 의
열거 목록에 있다. 그 note 본문은 이 export 에 포함되지 않는다 — 세율은 알아도 **대상을 모른다**.

**2. 현재 시드의 4자리 301 행은 구조적으로 틀렸다.**
`3924,CN,section301,0.25` 처럼 호(4자리) 전체에 25%를 매겼는데, 301 은 호 단위가 아니라
**8자리 라인 단위**로 지정된다. 같은 호 안에서도 List 3(25%)·List 4A(7.5%)·미지정이 섞인다.

**3. IEEPA 는 프로그램이 겹친다.**
중국은 `9903.01.20`/`9903.01.24`(펜타닐 IEEPA, +10%)와 `9903.02.xx`(상호관세)가 별도로 있고,
조항마다 발효일·경유화물 예외가 다르다. 어느 조합이 적용되는지는 사람이 판단한다.

## Section 301 — 조항별 추가세율

| 조항 | 추가세율 | 적용 대상 정의 | 비고 |
|---|---|---|---|
| `9903.88.01` | **+25.0%** | U.S. note 20(a) | China |
| `9903.88.02` | **+25.0%** | U.S. note 20(c) | China |
| `9903.88.03` | **+25.0%** | U.S. note 20(e) | China |
| `9903.88.04` | **+25.0%** | U.S. note 20(g) | China |
| `9903.88.09` | **+10.0%** | U.S. note 20(l) | China |
| `9903.88.15` | **+7.5%** | U.S. note 20(r) | China |
| `9903.88.16` | **+15.0%** | U.S. note 20(t) | China |

확정 절차: 각 SKU 의 **8자리** HTS 를 위 note 의 열거 목록에서 찾아 해당 조항의 세율을 적는다.
note 원문: <https://hts.usitc.gov/> → Chapter 99 → Subchapter III → U.S. Notes.

## IEEPA — 국가별 상호관세 (9903.02.xx)

원장 구조와 1:1로 맞는다 (`hts_code=*`, `origin_country=XX`).

| 조항 | 국가 | 추가세율 |
|---|---|---|
| `9903.02.01` | any country determined by U.S. Customs and Border Protection to have been transshipped to evade applicable duties under section 2 of Executive Order [Insert EO number] | **+40%** |
| `9903.02.02` | Afghanistan | **+15%** |
| `9903.02.03` | Algeria | **+30%** |
| `9903.02.04` | Angola | **+15%** |
| `9903.02.05` | Bangladesh | **+20%** |
| `9903.02.06` | Bolivia | **+15%** |
| `9903.02.07` | Bosnia and Herzegovina | **+30%** |
| `9903.02.08` | Botswana | **+15%** |
| `9903.02.09` | Brazil | **+10%** |
| `9903.02.10` | Brunei | **+25%** |
| `9903.02.11` | Cambodia | **+19%** |
| `9903.02.12` | Cameroon | **+15%** |
| `9903.02.13` | Chad | **+15%** |
| `9903.02.14` | Costa Rica | **+15%** |
| `9903.02.15` | Côte d’Ivoire | **+15%** |
| `9903.02.16` | Democratic Republic of the Congo | **+15%** |
| `9903.02.17` | Ecuador | **+15%** |
| `9903.02.18` | Equatorial Guinea | **+15%** |
| `9903.02.21` | Falkland Islands | **+10%** |
| `9903.02.22` | Fiji | **+15%** |
| `9903.02.23` | Ghana | **+15%** |
| `9903.02.24` | Guyana | **+15%** |
| `9903.02.25` | Iceland | **+15%** |
| `9903.02.26` | India | **+25%** |
| `9903.02.27` | Indonesia | **+19%** |
| `9903.02.28` | Iraq | **+35%** |
| `9903.02.29` | Israel | **+15%** |
| `9903.02.30` | Japan | **+15%** |
| `9903.02.31` | Jordan | **+15%** |
| `9903.02.32` | Kazakhstan | **+25%** |
| `9903.02.33` | Laos | **+40%** |
| `9903.02.34` | Lesotho | **+15%** |
| `9903.02.35` | Libya | **+30%** |
| `9903.02.36` | Liechtenstein | **+15%** |
| `9903.02.37` | Madagascar | **+15%** |
| `9903.02.38` | Malawi | **+15%** |
| `9903.02.39` | Malaysia | **+19%** |
| `9903.02.40` | Mauritius | **+15%** |
| `9903.02.41` | Moldova | **+25%** |
| `9903.02.42` | Mozambique | **+15%** |
| `9903.02.43` | Myanmar (Burma) | **+40%** |
| `9903.02.44` | Namibia | **+15%** |
| `9903.02.45` | Nauru | **+15%** |
| `9903.02.46` | New Zealand | **+15%** |
| `9903.02.47` | Nicaragua | **+18%** |
| `9903.02.48` | Nigeria | **+15%** |
| `9903.02.49` | North Macedonia | **+15%** |
| `9903.02.50` | Norway | **+15%** |
| `9903.02.51` | Pakistan | **+19%** |
| `9903.02.52` | Papua New Guinea | **+15%** |
| `9903.02.53` | the Philippines | **+19%** |
| `9903.02.54` | Serbia | **+35%** |
| `9903.02.55` | South Africa | **+30%** |
| `9903.02.56` | South Korea | **+15%** |
| `9903.02.57` | Sri Lanka | **+20%** |
| `9903.02.58` | Switzerland | **+39%** |
| `9903.02.59` | Syria | **+41%** |
| `9903.02.60` | Taiwan | **+20%** |
| `9903.02.61` | Thailand | **+19%** |
| `9903.02.62` | Trinidad and Tobago | **+15%** |
| `9903.02.63` | Tunisia | **+25%** |
| `9903.02.64` | Turkey | **+15%** |
| `9903.02.65` | Uganda | **+15%** |
| `9903.02.66` | the United Kingdom | **+10%** |
| `9903.02.67` | Vanuatu | **+15%** |
| `9903.02.68` | Venezuela | **+15%** |
| `9903.02.69` | Vietnam | **+20%** |
| `9903.02.70` | Zambia | **+15%** |
| `9903.02.71` | Zimbabwe | **+15%** |

## IEEPA — 기타 프로그램 (9903.01.xx)

| 조항 | 추가세율 | 적용 대상 |
|---|---|---|
| `9903.01.01` | +25% | Except for products described in headings 9903.01.02, 9903.01.03, 9903.01.04 and 9903.01.05 articles the produ |
| `9903.01.05` | +10% | Potash that is a product of Mexico, as provided for in U.S. note 2(c) to this subchapter |
| `9903.01.10` | +35% | Except for products described in headings 9903.01.11, 9903.01.12, 9903.01.13, 9903.01.14 or 9903.01.15, articl |
| `9903.01.13` | +10% | Crude oil, natural gas, lease condensates, natural gas liquids, refined petroleum products, uranium, coal, bio |
| `9903.01.15` | +10% | Potash that is a product of Canada, as provided for in U.S. note 2(I) to this subchapter |
| `9903.01.16` | +40% | Except for products described in 9903.01.11, 9903.01.12, and 9903.01.14, articles the product of Canada as pro |
| `9903.01.20` | +10% | Except for products described in headings 9903.01.21, 9903.01.22, or 9903.01.23 articles the product of China  |
| `9903.01.24` | +10% | Except for products described in headings 9903.01.21, 9903.01.22, 9903.01.23, articles the product of China an |
| `9903.01.25` | +10% | Articles the product of any country, except for products described in headings 9903.01.26–9903.01.33, 9903.02. |
| `9903.01.43` | +11% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.44` | +13% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.45` | +14% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.46` | +15% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.47` | +16% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.48` | +17% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.49` | +18% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.50` | +20% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.51` | +21% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.52` | +22% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.53` | +24% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.54` | +25% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.55` | +26% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.56` | +27% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.57` | +28% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.58` | +29% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.59` | +30% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.60` | +31% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.61` | +32% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.62` | +33% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.63` | +34% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.64` | +35% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.65` | +36% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.66` | +37% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.67` | +38% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.68` | +39% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.69` | +40% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.70` | +41% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.71` | +44% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.72` | +46% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.73` | +47% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.74` | +48% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.75` | +49% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.76` | +50% | Except for goods loaded onto a vessel at the port of loading and in transit on the final mode of transit befor |
| `9903.01.77` | +40% | Except for products described in headings 9903.01.78-9903.01.83 and 9903.01.90, articles the product of Brazil |
| `9903.01.84` | +25% | Except for products described in headings 9903.01.85-9903.01.89, articles the product of India that are entere |

---

## 확정한 값 적재

`supabase/seed/hts_seed_50.csv` 의 301·IEEPA 행을 위 값으로 교체하고:

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run seed:rates
```

`source` 컬럼에 조항 번호를 적어 감사 추적을 남길 것 (예: `HTSUS 9903.88.03`).
