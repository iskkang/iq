/** Supabase env 없으면 자동 DEMO 모드 (인메모리, 키 불필요) */
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const IS_DEMO = !SUPABASE_URL || !SUPABASE_ANON_KEY
