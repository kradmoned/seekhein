import type { FeedbackTone } from "@/lib/feedback"
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { submissionStatus, submitResult, type SubmissionStatus } from '@/lib/submission-contract'
import { beginSubmission, pendingSubmissions, resolveSubmission, terminalSubmissionError, type PendingSubmission } from '@/lib/pending-submissions'
import { validateCode } from '@/lib/workspace'
import type { RunResult } from '@/lib/types'

export function useSubmissions(userId: string, labId: string, enabled: boolean) {
  const [status, setStatus] = useState<SubmissionStatus | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [statusError, setStatusError] = useState('')
  const [feedback, setFeedback] = useState<{ message: string; tone: FeedbackTone; title: string } | null>(null)
  const message = feedback?.message ?? ''
  function setMessage(message: string, tone: FeedbackTone = 'info', title = 'Submission update') {
    setFeedback(message ? { message, tone, title } : null)
  }
  const [storageError, setStorageError] = useState('')
  const [pending, setPending] = useState<PendingSubmission[]>([])
  const [busy, setBusy] = useState(false)
  const active = useRef(false)
  const lock = useRef(false)
  const statusController = useRef<AbortController | null>(null)
  const sendController = useRef<AbortController | null>(null)
  const readPending = useCallback(() => {
    try { setPending(pendingSubmissions(userId, labId)); setStorageError('') }
    catch (error) { setStorageError(`Submission recovery storage is unavailable: ${error instanceof Error ? error.message : 'Check browser storage.'} New submissions are paused.`) }
  }, [userId, labId])
  const refresh = useCallback(async () => {
    statusController.current?.abort()
    const controller = new AbortController(); statusController.current = controller
    setLoading(true); setStatusError('')
    try {
      const next = submissionStatus(await api<unknown>(`/api/labs/${encodeURIComponent(labId)}/submission`, { signal: controller.signal }))
      if (!controller.signal.aborted && active.current) setStatus(next)
    } catch (error) {
      if (!controller.signal.aborted && active.current) setStatusError(error instanceof Error ? error.message : 'Unable to load submission status.')
    } finally { if (!controller.signal.aborted && active.current) setLoading(false) }
  }, [labId])
  useEffect(() => {
    active.current = true
    if (enabled) { void refresh(); readPending() }
    const storage = (event: StorageEvent) => {
      if (!enabled || (event.key !== null && !event.key.startsWith(`final-submission:${userId}:${labId}:`))) return
      readPending()
      if (event.newValue === null) void refresh()
    }
    window.addEventListener('storage', storage)
    return () => { active.current = false; statusController.current?.abort(); sendController.current?.abort(); window.removeEventListener('storage', storage) }
  }, [enabled, refresh, readPending, userId, labId])

  async function send(saved: PendingSubmission, onResult: (execution: RunResult, code: string, attemptId?: string | null) => void) {
    const controller = new AbortController(); sendController.current = controller
    try {
      let value: unknown
      for (let attempt = 0; ; attempt++) {
        try {
          value = await api<unknown>(`/api/labs/${encodeURIComponent(labId)}/submit`, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': saved.key }, body: JSON.stringify({ code: saved.code, submit_anyway: saved.submit_anyway ?? false }) }, userId)
          break
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'SUBMISSION_PROCESSING' || attempt >= 2) throw error
          if (active.current) setMessage('A submission is processing. Retrying this saved action…')
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
            const timer = window.setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve() }, Math.max(2 ** (attempt + 1), error.retryAfter ?? 2) * 1000)
            if (controller.signal.aborted) abort(); else controller.signal.addEventListener('abort', abort, { once: true })
          })
        }
      }
      const result = submitResult(value)
      if (!active.current || controller.signal.aborted) return
      onResult(result.execution, saved.code, result.submission_id)
      setMessage(result.accepted ? 'This version is saved and uses one submission slot.' : 'This attempt was not saved and used no submission slot. Fix your code or use Submit anyway to hand in unfinished work.', result.accepted ? 'success' : 'warning', result.accepted ? result.submission_status === 'pending_review' ? 'Submitted — pending teacher review' : 'Submitted — tests passed' : 'Check your test results')
      try { resolveSubmission(userId, labId, saved.key); readPending() }
      catch { setStorageError('The outcome is known, but its recovery record could not be removed. Replaying it is safe.') }
      await refresh()
    } catch (error) {
      if (!active.current || controller.signal.aborted) return
      if (error instanceof ApiError && terminalSubmissionError(error)) {
        try { resolveSubmission(userId, labId, saved.key); readPending() } catch { setStorageError('Could not remove the completed recovery record.') }
        setMessage(error.message, 'warning', ['FINAL_SUBMISSION_LOCKED', 'SUBMISSION_LIMIT_REACHED'].includes(error.code || '') ? 'Submission allowance reached' : 'Submission could not be sent')
        await refresh()
      } else {
        setMessage(`${error instanceof Error ? error.message : 'Delivery is uncertain.'} The original code, key, and submission mode are saved. Use Recover pending submission to resolve this action.`, 'warning', 'Submission needs recovery')
      }
    } finally { lock.current = false; if (active.current) setBusy(false) }
  }
  async function submit(code: string, flush: () => Promise<void>, onResult: (execution: RunResult, code: string, attemptId?: string | null) => void, submitAnyway = false) {
    if (!enabled || lock.current || loading || statusError || storageError || pending.length > 0 || !status?.can_submit) return
    const invalid = validateCode(code)
    if (invalid) { setMessage(invalid, 'warning', 'Check your code'); return }
    lock.current = true; setBusy(true); setMessage('')
    let saved: PendingSubmission
    try { saved = beginSubmission(userId, labId, code, submitAnyway); readPending() }
    catch { lock.current = false; setBusy(false); setStorageError('Cannot save this action for recovery. Free browser storage or enable it before submitting. Nothing was sent.'); return }
    try { await flush() } catch { /* Submission remains recoverable even when telemetry fails. */ }
    if (!active.current) { lock.current = false; return }
    await send(saved, onResult)
  }
  function recover(saved: PendingSubmission, onResult: (execution: RunResult, code: string, attemptId?: string | null) => void) {
    if (!enabled || lock.current) return
    lock.current = true; setBusy(true); setMessage('Recovering the original saved code…')
    void send(saved, onResult)
  }
  return { status, loading, statusError, message, messageTone: feedback?.tone ?? 'info', messageTitle: feedback?.title ?? 'Submission update', storageError, pending, busy, refresh, readPending, submit, recover }
}
