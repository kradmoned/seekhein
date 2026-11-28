import type { RunResult } from './types'

export type SubmissionReview = { submit_anyway?: boolean; submission_status?: 'passed' | 'pending_review' }
export type AcceptedSubmission = SubmissionReview & { submission_id: string; submitted_at: string; version: number; code_sha256: string; execution: RunResult }
export type SubmissionStatus = { lab_id: string; allow_resubmissions: boolean; max_submissions: number | null; accepted_submission_count: number; remaining_submissions: number | null; can_submit: boolean; accepted_submission: AcceptedSubmission | null }
export type SubmitResult = ({ accepted: true; submission_id: string; submitted_at: string; execution: RunResult } | { accepted: false; submission_id: null; submitted_at: null; execution: RunResult }) & { submit_anyway?: boolean; submission_status?: 'passed' | 'pending_review' | null }
export type SubmittedCode = AcceptedSubmission & { lab_id: string; student_id: string; code: string }
export type IntegritySummary = { score: number; penalty: number; penalties: { paste: number; large_insert: number; focus: number; fast_pass: number }; badge: 'green' | 'amber' | 'red'; flags: Array<{ type: string; evidence: string; at: string; penalty: number }>; focus_losses: number; telemetry_status: 'recorded' | 'missing_lab_opened' | 'missing' }
export type StudentCourseReport = { course_id: string; student: { id: string; email: string; full_name: string | null }; labs: Array<{ lab_id: string; title: string; allow_resubmissions: boolean; max_submissions: number | null; accepted_submission_count: number; remaining_submissions: number | null; practice_attempt_count: number; accepted_submission: AcceptedSubmission | null; integrity_scope: 'current_lab'; integrity: IntegritySummary }> }
export type LabReport = { lab_id: string; title: string; max_submissions: number | null; allow_resubmissions: boolean; students: Array<{ student_id: string; email: string; full_name: string | null; enrolled: boolean; first_pass_at: string | null; practice_attempt_count: number; accepted_submission_count: number; remaining_submissions: number | null; accepted_submission: AcceptedSubmission | null; integrity_scope: 'current_lab'; integrity: IntegritySummary; events: Array<{ event_id: string; session_id: string; type: string; payload: { chars?: number | null }; client_ts: string | null; received_at: string }>; submissions: Array<{ id: string; status: string; score: number; passed: number; total: number; created_at: string; kind: 'practice' | 'final'; submit_anyway?: boolean; version: number | null; code_sha256: string | null }> }> }

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid response from server.')
  return value as Record<string, unknown>
}
export function check(condition: unknown): asserts condition { if (!condition) throw Error('Invalid response from server.') }
const text = (v: unknown) => typeof v === 'string'
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0
const date = (v: unknown) => text(v) && Number.isFinite(Date.parse(v as string))
export const validLimit = (v: unknown): v is number | null => v === null || Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 2147483647
export function parseLimit(value: string): number | null {
  if (value === 'unlimited') return null
  if (!/^[1-9]\d*$/.test(value) || !validLimit(Number(value))) throw Error('Choose a positive whole number up to 2,147,483,647 or Unlimited.')
  return Number(value)
}
export function execution(value: unknown): RunResult {
  const v = object(value)
  check(['ok', 'syntax_error', 'runtime_error', 'timeout', 'oom'].includes(v.status as string) && typeof v.score === 'number' && Number.isFinite(v.score) && v.score >= 0 && v.score <= 100 && count(v.passed) && count(v.total) && (v.passed as number) <= (v.total as number) && Array.isArray(v.results))
  v.results.forEach(item => { const r = object(item); check(text(r.name) && typeof r.passed === 'boolean' && (r.error === null || text(r.error))) })
  // Historical records are compact; a partially detailed response is invalid.
  if (['tests', 'ran', 'failed', 'stdout', 'stdout_truncated', 'duration_ms', 'syntax_error'].some(key => key in v)) {
    const duration = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0
    const optionalText = (o: Record<string, unknown>, keys: string[]) => keys.every(key => !(key in o) || text(o[key]))
    check(count(v.ran) && count(v.failed) && text(v.stdout) && typeof v.stdout_truncated === 'boolean' && duration(v.duration_ms) && Array.isArray(v.tests))
    let passed = 0, failed = 0
    v.tests.forEach(item => {
      const t = object(item)
      check(count(t.index) && text(t.name) && text(t.display_name) && ['passed', 'failed', 'timeout', 'not_run'].includes(t.status as string) && typeof t.passed === 'boolean' && t.passed === (t.status === 'passed') && duration(t.duration_ms))
      check(optionalText(t, ['inputs', 'expected', 'actual', 'error_type', 'error_message', 'stdout']) && (!('stdout_truncated' in t) || typeof t.stdout_truncated === 'boolean'))
      if ('traceback' in t) {
        check(Array.isArray(t.traceback))
        t.traceback.forEach(item => { const frame = object(item); check(count(frame.line) && text(frame.function) && text(frame.code)) })
      }
      if (t.passed) passed++
      if (t.status === 'failed' || t.status === 'timeout') failed++
    })
    check(v.tests.length === v.total && v.results.length === v.total && passed === v.passed && failed === v.failed && v.ran === passed + failed)
    check(v.score === (v.status === 'ok' && (v.total as number) > 0 ? Math.floor(passed * 100 / (v.total as number)) : 0))
    if ('syntax_error' in v) {
      const syntax = object(v.syntax_error)
      check(text(syntax.error_type) && count(syntax.line) && optionalText(syntax, ['error_message', 'code_line']))
    }
  }
  return v as RunResult
}
export function reviewLabel(value: SubmissionReview): string {
  return value.submission_status === 'pending_review' ? 'Pending teacher review' : 'Tests passed'
}
function reviewMetadata(v: Record<string, unknown>, saved: boolean) {
  if (!('submit_anyway' in v) && !('submission_status' in v)) return // Historical responses.
  check(typeof v.submit_anyway === 'boolean')
  const result = execution(v.execution)
  const passed = result.status === 'ok' && result.total > 0 && result.passed === result.total
  check(saved ? v.submission_status === (passed ? 'passed' : 'pending_review') && (passed || v.submit_anyway === true) : v.submission_status === null)
}
function accepted(value: unknown): AcceptedSubmission {
  const v = object(value)
  check(text(v.submission_id) && date(v.submitted_at) && count(v.version) && (v.version as number) > 0 && typeof v.code_sha256 === 'string' && /^[a-f0-9]{64}$/.test(v.code_sha256))
  execution(v.execution)
  reviewMetadata(v, true)
  return v as AcceptedSubmission
}
function submissionHistory(v: Record<string, unknown>) {
  check(count(v.accepted_submission_count) && (v.remaining_submissions === null || count(v.remaining_submissions)))
  check(v.accepted_submission === null || accepted(v.accepted_submission))
}
function allowance(v: Record<string, unknown>) {
  check(validLimit(v.max_submissions) && typeof v.allow_resubmissions === 'boolean')
  submissionHistory(v)
}
export function submissionStatus(value: unknown): SubmissionStatus {
  const v = object(value); allowance(v)
  check(text(v.lab_id) && typeof v.can_submit === 'boolean')
  return v as SubmissionStatus
}
export function submitResult(value: unknown): SubmitResult {
  const v = object(value); execution(v.execution)
  check(v.accepted === true ? text(v.submission_id) && date(v.submitted_at) : v.accepted === false && v.submission_id === null && v.submitted_at === null)
  reviewMetadata(v, v.accepted === true)
  return v as SubmitResult
}
export function submittedCode(value: unknown): SubmittedCode {
  const v = object(value); accepted(v); check(text(v.lab_id) && text(v.student_id) && text(v.code)); return v as SubmittedCode
}
function integrity(value: unknown) {
  const v = object(value); const p = object(v.penalties)
  check(count(v.score) && (v.score as number) <= 100 && count(v.penalty) && count(v.focus_losses) && ['green', 'amber', 'red'].includes(v.badge as string) && ['recorded', 'missing_lab_opened', 'missing'].includes(v.telemetry_status as string) && Array.isArray(v.flags))
  check(['paste', 'large_insert', 'focus', 'fast_pass'].every(k => count(p[k])))
  v.flags.forEach(item => { const f = object(item); check(text(f.type) && text(f.evidence) && date(f.at) && count(f.penalty)) })
}
export function studentReport(value: unknown): StudentCourseReport {
  const v = object(value); const s = object(v.student)
  check(text(v.course_id) && text(s.id) && text(s.email) && (s.full_name === null || text(s.full_name)) && Array.isArray(v.labs))
  v.labs.forEach(item => { const l = object(item); allowance(l); integrity(l.integrity); check(text(l.lab_id) && text(l.title) && count(l.practice_attempt_count) && l.integrity_scope === 'current_lab') })
  return v as StudentCourseReport
}
export function labReport(value: unknown): LabReport {
  const v = object(value); check(text(v.lab_id) && text(v.title) && validLimit(v.max_submissions) && typeof v.allow_resubmissions === 'boolean' && Array.isArray(v.students))
  v.students.forEach(item => {
    const s = object(item); submissionHistory(s); integrity(s.integrity)
    check(text(s.student_id) && text(s.email) && (s.full_name === null || text(s.full_name)) && typeof s.enrolled === 'boolean' && (s.first_pass_at === null || date(s.first_pass_at)) && count(s.practice_attempt_count) && s.integrity_scope === 'current_lab' && Array.isArray(s.events) && Array.isArray(s.submissions))
    s.events.forEach(item => { const e = object(item); const p = object(e.payload); check(text(e.event_id) && text(e.session_id) && text(e.type) && date(e.received_at) && (e.client_ts === null || date(e.client_ts)) && (p.chars === undefined || p.chars === null || count(p.chars))) })
    s.submissions.forEach(item => { const e = object(item); check((e.submit_anyway === undefined || typeof e.submit_anyway === 'boolean') && text(e.id) && text(e.status) && typeof e.score === 'number' && Number.isFinite(e.score) && count(e.passed) && count(e.total) && date(e.created_at) && (e.kind === 'practice' ? e.version === null && e.code_sha256 === null : e.kind === 'final' && count(e.version) && (e.version as number) > 0 && text(e.code_sha256))) })
  })
  return v as LabReport
}
