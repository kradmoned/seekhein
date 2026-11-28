import { randomUuid } from './uuid.ts'
export type PendingSubmission = { key: string; code: string; submit_anyway?: boolean }
export const pendingPrefix = (userId: string, labId: string) => `final-submission:${userId}:${labId}:`
export const pendingStorageKey = (userId: string, labId: string, key: string) => `${pendingPrefix(userId, labId)}${key}`
export function beginSubmission(userId: string, labId: string, code: string, submitAnyway = false, storage: Storage = localStorage): PendingSubmission {
  const pending = { key: randomUuid(), code, submit_anyway: submitAnyway }
  const key = pendingStorageKey(userId, labId, pending.key)
  const serialized = JSON.stringify(pending)
  storage.setItem(key, serialized)
  if (storage.getItem(key) !== serialized) throw Error('Could not preserve this submission for recovery.')
  return pending
}
export function pendingSubmissions(userId: string, labId: string, storage: Storage = localStorage): PendingSubmission[] {
  const result: PendingSubmission[] = []
  const prefix = pendingPrefix(userId, labId)
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (!key?.startsWith(prefix)) continue
    const item = JSON.parse(storage.getItem(key) || 'null')
    if (!item || typeof item.code !== 'string' || typeof item.key !== 'string' || ('submit_anyway' in item && typeof item.submit_anyway !== 'boolean') || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(item.key) || key !== prefix + item.key) throw Error('A saved submission is unreadable. Preserve browser data and contact support.')
    result.push({ key: item.key, code: item.code, submit_anyway: item.submit_anyway ?? false })
  }
  return result
}
export function resolveSubmission(userId: string, labId: string, key: string, storage: Storage = localStorage) {
  storage.removeItem(pendingStorageKey(userId, labId, key))
}
export async function codeDigest(code: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw Error('Editor comparison requires HTTPS or localhost.')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
export function terminalSubmissionError(error: { status: number; code?: string }) {
  return ['FINAL_SUBMISSION_LOCKED', 'SUBMISSION_LIMIT_REACHED', 'INVALID_REQUEST', 'INVALID_LAB_ID', 'INVALID_IDEMPOTENCY_KEY'].includes(error.code || '')
}
