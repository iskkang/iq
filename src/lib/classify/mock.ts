/**
 * Mock 분류기 — API 키 없는 데모/개발/벤치마크용. 결정론적.
 * 실 서비스에서는 Supabase Edge Function(classify)이 Anthropic API를 호출한다.
 */
import type { ClassifyBatchResult, ClassifyConsensus, ClassifyItemInput, HtsCandidate } from './types'

/** 미매칭 상품용 후보 풀 (시드 원장의 10자리 코드 일부 — mock 전용, rate 조회와 무관) */
const DEFAULT_POOL = [
  '3926909985', '4202991000', '4419909100', '6307909891', '6913905000',
  '7013492000', '7117199000', '7323999080', '8205513030', '9403608081',
]

const KEYWORD_MAP: Array<[RegExp, string[]]> = [
  [/mug|ceramic|stoneware|cup/i, ['6912004810', '6911108010', '6913905000']],
  [/porcelain/i, ['6911108010', '6912004810']],
  [/t-?shirt|\btees?\b/i, ['6109100004', '6109901007', '6110202079']],
  [/hoodie|sweater|pullover|sweatshirt/i, ['6110202079', '6110303059']],
  [/pants|trouser|jeans/i, ['6203424511', '6204628011']],
  [/backpack|\bbags?\b|handbag|tote|pouch/i, ['4202923120', '4202228100', '4202923131']],
  [/towel|terry/i, ['6302600020', '6302319040']],
  [/sheet|bedding|linen|duvet/i, ['6302319040', '6307909891']],
  [/pillow|cushion/i, ['9404902000', '6307909891']],
  [/shoe|sneaker|footwear|boot/i, ['6404119050', '6404199060', '6402993165']],
  [/glass|tumbler/i, ['7013492000', '7009921000']],
  [/mirror/i, ['7009921000']],
  [/jewel|necklace|earring|bracelet/i, ['7117199000']],
  [/stainless|steel.*(kitchen|pan|pot)|cookware/i, ['7323930060', '7323999080', '7615107125']],
  [/aluminum|aluminium/i, ['7615107125', '7323999080']],
  [/tool|wrench|plier|screwdriver/i, ['8205513030']],
  [/\bfans?\b/i, ['8414519090']],
  [/blender|mixer|juicer/i, ['8509400025']],
  [/coffee|kettle/i, ['8516710020']],
  [/router|wifi|network|modem/i, ['8517620090']],
  [/headphone|earbud|earphone|headset/i, ['8518302000', '8518220000']],
  [/speaker/i, ['8518220000', '8518302000']],
  [/cable|charger|cord|usb/i, ['8544429090', '8517620090']],
  [/auto|car part/i, ['8708998180']],
  [/bicycle|bike/i, ['8712001550']],
  [/furniture|desk|table|chair|shelf/i, ['9403608081', '9403200050']],
  [/toy|puzzle|doll|game/i, ['9503000073']],
  [/christmas|ornament|holiday/i, ['9505102500', '3926400090']],
  [/wood|bamboo/i, ['4419909100', '4420908000']],
  [/notebook|journal|planner/i, ['4820102020']],
  [/box|carton|packaging/i, ['4819100040']],
  [/print|poster|art/i, ['4911912040']],
  [/plastic.*(kitchen|table)|tableware/i, ['3924104000', '3924905650']],
  [/plastic/i, ['3926909985', '3924905650', '3924104000']],
]

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function mockClassifyBatch(items: ClassifyItemInput[]): ClassifyBatchResult {
  const results = items.map((item) => {
    const text = `${item.product_name} ${item.description_or_material}`
    const matched = KEYWORD_MAP.find(([re]) => re.test(text))
    const h = hash(`${item.id}|${text}`)

    let codes: string[]
    let base: number
    if (matched) {
      codes = matched[1]
      base = 0.72 + (h % 21) / 100 // 0.72~0.92 — 키워드 매칭 시 고신뢰
    } else {
      // 미매칭: 결정론적으로 뽑되 저신뢰 → needs_review 경로 시연
      const i = h % DEFAULT_POOL.length
      codes = [DEFAULT_POOL[i], DEFAULT_POOL[(i + 3) % DEFAULT_POOL.length], DEFAULT_POOL[(i + 7) % DEFAULT_POOL.length]]
      base = 0.45 + (h % 20) / 100 // 0.45~0.64 — 저신뢰
    }

    const candidates: HtsCandidate[] = codes.slice(0, 3).map((code, rank) => ({
      hts_code: code,
      confidence: Math.max(0.05, Math.round((base - rank * 0.17) * 100) / 100),
      rationale:
        rank === 0
          ? `[MOCK] Top candidate based on '${item.product_name || item.description_or_material}' text match`
          : `[MOCK] Alternative candidate ${rank + 1}`,
    }))

    // v2 판정 형태를 맞춘다. mock 은 결정론이라 k=3 은 항상 만장일치이므로
    // 키워드 매칭 성공(고신뢰) 여부를 만장일치 대용으로 쓴다.
    // in_ledger 는 mock 이 원장을 못 보므로 true 로 두고, 실제 판정은
    // 원장을 볼 수 있는 edge 백엔드에서만 의미를 갖는다.
    const top = candidates[0].hts_code
    const unanimous = !!matched
    const consensus: ClassifyConsensus = {
      code: unanimous ? top : null,
      unanimous,
      votes: [unanimous ? top : null, unanimous ? top : null, unanimous ? top : null],
      in_ledger: true,
      out_of_options: 0,
      status: unanimous ? 'auto_confirmed' : 'needs_review',
      reason: unanimous ? '[MOCK] 키워드 매칭 — 만장일치 취급' : '[MOCK] 키워드 미매칭 — 리뷰 필요',
    }
    return { item_id: item.id, candidates, attributes: null, headings: [top.slice(0, 4)], consensus }
  })

  return {
    results,
    meta: { model: 'mock-classifier', prompt_version: 'mock-v2', temperature: 0, votes: 3 },
    raw_output: { mock: true, count: items.length },
  }
}
