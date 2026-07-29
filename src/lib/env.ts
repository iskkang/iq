/** Supabase env 없으면 자동 DEMO 모드 (인메모리, 키 불필요) */
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const IS_DEMO = !SUPABASE_URL || !SUPABASE_ANON_KEY

/**
 * 프로덕션에서 데모로 떨어지면 **화면을 띄우지 않는다.**
 *
 * env 가 빠지면 앱은 인메모리 저장소로 조용히 전환된다. 사용자는 아무 경고 없이
 * 선적을 만들고 분류를 돌린 다음, 새로고침에 전부 잃는다. 그게 이 저장소가
 * 반복해서 겪은 실패 방식이다 — 원장에 행이 없으면 duty 0, 빈 타입체크가 "통과",
 * 무효 조항이 정상 조항처럼 보이는 관세표. 조용히 틀리느니 시끄럽게 멈추는 게 낫다.
 *
 * 개발 모드는 예외다 — 로컬에서 키 없이 UI 를 보는 건 정상 작업이다.
 */
export const CONFIG_ERROR: string | null =
  import.meta.env.PROD && IS_DEMO
    ? 'VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 가 빌드에 주입되지 않았습니다.'
    : null
