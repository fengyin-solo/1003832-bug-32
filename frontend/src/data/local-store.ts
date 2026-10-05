import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'field-archaeology-digital:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

// 事务写入：先在整库草稿副本上改，提交前逐张表比对——凡本次要写的表在事务期间被
// 别的标签页改过，就视为并发冲突直接抛错；落库本身失败（如配额满）同样抛错。
// 两种失败都不会动缓存和 localStorage，调用方据此把业务状态退回原状，不留半份记录。
export function transact(mutate: (draft: Record<string, EntryRow[]>) => void): void {
  const snapshot = allRows()
  const draft = clone(snapshot)
  mutate(draft)
  const touched = Object.keys(draft).filter(
    (key) => JSON.stringify(draft[key]) !== JSON.stringify(snapshot[key]),
  )
  if (touched.length === 0) {
    return
  }
  const fresh = readStorage()
  for (const key of touched) {
    if (JSON.stringify(fresh[key] ?? []) !== JSON.stringify(snapshot[key] ?? [])) {
      throw new Error('数据在写入期间被并发修改，本次提交已放弃')
    }
  }
  const merged: Record<string, EntryRow[]> = { ...fresh }
  for (const key of touched) {
    merged[key] = draft[key]
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
  }
  cache = merged
}

export function storageKey(): string {
  return STORAGE_KEY
}
