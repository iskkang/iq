/**
 * 분류 클라이언트 — 배치(10개) × 동시 4콜.
 * 500 SKU ≈ 50콜/동시4 → LLM 왕복 ~6-8초 기준 2분 내 (수용 기준 §6-2 설계 근거).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { mockClassifyBatch } from './mock'
import { sanitizeCandidates } from './types'
import type { ClassifyBatchResult, ClassifyItemInput } from './types'

const BATCH_SIZE = 10
const CONCURRENCY = 4

export type ClassifyBackend =
  | { kind: 'mock' }
  | { kind: 'edge'; supabase: SupabaseClient }

async function classifyBatch(
  backend: ClassifyBackend,
  batch: ClassifyItemInput[],
): Promise<ClassifyBatchResult> {
  if (backend.kind === 'mock') return mockClassifyBatch(batch)

  const { data, error } = await backend.supabase.functions.invoke('classify', {
    body: { items: batch },
  })
  if (error) throw new Error(`classify edge function 실패: ${error.message}`)
  const results = (data.results as Array<{ item_id: string; candidates: unknown }>).map((r) => ({
    item_id: r.item_id,
    candidates: sanitizeCandidates(r.candidates),
  }))
  return { results, meta: data.meta, raw_output: data.raw_output }
}

export async function classifyItems(
  backend: ClassifyBackend,
  items: ClassifyItemInput[],
  onProgress?: (done: number, total: number) => void,
): Promise<ClassifyBatchResult[]> {
  const batches: ClassifyItemInput[][] = []
  for (let i = 0; i < items.length; i += BATCH_SIZE) batches.push(items.slice(i, i + BATCH_SIZE))

  const out: ClassifyBatchResult[] = []
  let done = 0
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const wave = batches.slice(i, i + CONCURRENCY)
    const results = await Promise.all(wave.map((b) => classifyBatch(backend, b)))
    for (const r of results) {
      out.push(r)
      done += r.results.length
      onProgress?.(done, items.length)
    }
  }
  return out
}
