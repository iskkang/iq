/**
 * 분류 클라이언트 — 배치(10개) × 동시 4콜.
 * 500 SKU ≈ 50콜/동시4 → LLM 왕복 ~6-8초 기준 2분 내 (수용 기준 §6-2 설계 근거).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { mockClassifyBatch } from './mock'
import { sanitizeCandidates } from './types'
import type { ClassifyBatchResult, ClassifyItemInput, ClassifyItemResult } from './types'

const BATCH_SIZE = 10
/**
 * v2 파이프라인은 배치당 LLM 호출이 1회 → 2단계 × k=3 = 최대 6회로 늘었다.
 * 두 단계는 순차이지만 3표는 동시 실행되므로 배치 wall-time 은 대략 2배.
 * §6-2(500 SKU 3분) 를 유지하려면 배치 동시성을 4 → 8 로 올려야 한다.
 *   50배치 ÷ 8 = 7웨이브 × (2단계 × 8s) ≈ 112s < 180s
 */
const CONCURRENCY = 8

export type ClassifyBackend =
  | { kind: 'mock' }
  | { kind: 'edge'; supabase: SupabaseClient; noCache?: boolean }

async function classifyBatch(
  backend: ClassifyBackend,
  batch: ClassifyItemInput[],
): Promise<ClassifyBatchResult> {
  if (backend.kind === 'mock') return mockClassifyBatch(batch)

  const { data, error } = await backend.supabase.functions.invoke('classify', {
    body: { items: batch, no_cache: backend.noCache ?? false },
  })
  if (error) throw new Error(`classify edge function failed: ${error.message}`)
  if (data?.error) throw new Error(`classify edge function: ${data.error}`)
  const results = (data.results as ClassifyItemResult[]).map((r) => ({
    item_id: r.item_id,
    candidates: sanitizeCandidates(r.candidates),
    attributes: r.attributes ?? null,
    headings: r.headings ?? [],
    consensus: r.consensus ?? null,
    cached: r.cached ?? false,
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
