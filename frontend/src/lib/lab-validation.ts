import { check, object } from './submission-contract.ts'
export type ValidationSummary = { valid: true; status: 'ok'; total_tests: number; passed_tests: number; warnings: string[] }
export type UploadSuccess = { id: string; validated_at: string; validation: ValidationSummary }
export type TeacherDiagnostic = { index: number; name: string; display_name: string; status: 'passed' | 'failed' | 'timeout' | 'not_run'; passed: boolean; duration_ms: number; inputs?: string; expected?: string; actual?: string; error_type?: string; error_message?: string; full_traceback?: string; stdout?: string }
export type LabValidation = { valid: boolean; summary: string; status: string; duration_ms: number; total_tests: number; ran_tests: number; passed_tests: number; failed_tests: number; tests: TeacherDiagnostic[]; warnings: string[]; stdout?: string; syntax_error?: { source: 'solution' | 'tests'; error_type: string; error_message?: string; line: number; code_line?: string } }
const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0
const duration = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0
const strings = (v: unknown) => Array.isArray(v) && v.every(item => typeof item === 'string')
function optionalText(v: Record<string, unknown>, keys: string[]) { check(keys.every(key => !(key in v) || typeof v[key] === 'string')) }
export function uploadSuccess(value: unknown): UploadSuccess {
  const v = object(value), summary = object(v.validation)
  check(typeof v.id === 'string' && typeof v.validated_at === 'string' && Number.isFinite(Date.parse(v.validated_at)))
  check(summary.valid === true && summary.status === 'ok' && count(summary.total_tests) && (summary.total_tests as number) > 0 && summary.passed_tests === summary.total_tests && strings(summary.warnings))
  return v as UploadSuccess
}
export function labValidation(value: unknown): LabValidation {
  const v = object(value)
  check(typeof v.valid === 'boolean' && typeof v.summary === 'string' && ['ok', 'syntax_error', 'runtime_error', 'timeout', 'oom'].includes(v.status as string) && duration(v.duration_ms) && strings(v.warnings) && Array.isArray(v.tests))
  check(['total_tests', 'ran_tests', 'passed_tests', 'failed_tests'].every(key => count(v[key])))
  check(v.tests.length === v.total_tests && v.ran_tests === (v.passed_tests as number) + (v.failed_tests as number))
  v.tests.forEach(item => {
    const t = object(item)
    check(count(t.index) && typeof t.name === 'string' && typeof t.display_name === 'string' && ['passed', 'failed', 'timeout', 'not_run'].includes(t.status as string) && t.passed === (t.status === 'passed') && duration(t.duration_ms))
    optionalText(t, ['inputs', 'expected', 'actual', 'error_type', 'error_message', 'full_traceback', 'stdout'])
  })
  optionalText(v, ['stdout'])
  if ('syntax_error' in v) {
    const e = object(v.syntax_error)
    check(['solution', 'tests'].includes(e.source as string) && typeof e.error_type === 'string' && count(e.line))
    optionalText(e, ['error_message', 'code_line'])
  }
  return v as LabValidation
}
