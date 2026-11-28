import type { RunResult } from './types'

export const draftKey = (userId: string, labId: string) => `seekhein:draft:${userId}:${labId}`
const memoryDrafts = new Map<string, string>()
export function readDraft(key: string, starter: string, storage: Pick<Storage, 'getItem'>): string {
  return memoryDrafts.get(key) ?? storage.getItem(key) ?? starter
}
export function writeDraft(key: string, code: string, storage: Pick<Storage, 'setItem'>) {
  memoryDrafts.set(key, code)
  storage.setItem(key, code)
}
export function validateCode(code: string): string {
  if (code.includes('\0')) return 'Code must not contain null characters.'
  if (!code.trim()) return 'Enter Python code before running.'
  if (new TextEncoder().encode(code).length > 65_536) return 'Code exceeds the 65,536-byte UTF-8 limit.'
  if (new TextEncoder().encode(JSON.stringify({ code })).length > 524_288) return 'The JSON request exceeds 524,288 bytes.'
  return ''
}
export const executionPassed = (result: RunResult | null) => result?.status === 'ok' && result.total > 0 && result.passed === result.total
