import { IS_DEMO, SUPABASE_ANON_KEY, SUPABASE_URL } from '../env'
import { createDemoRepo } from './demo'
import { createSupabaseRepo } from './supabase'
import type { Repo } from './types'

let repo: Repo | null = null

export function getRepo(): Repo {
  if (!repo) {
    repo = IS_DEMO
      ? createDemoRepo()
      : createSupabaseRepo(SUPABASE_URL as string, SUPABASE_ANON_KEY as string)
  }
  return repo
}

export type { Repo }
