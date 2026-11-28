export type Profile = {
  id: string
  email: string
  full_name: string | null
  role: "student" | "teacher"
}

export type LabSummary = {
  id: string
  title: string
}

export type LabDetail = LabSummary & {
  instructions: string
  starter: string
  max_submissions: number | null
  allow_resubmissions: boolean
  validated_at?: string | null
  validation?: import('./lab-validation').ValidationSummary | null
  integrity_policy: import("./integrity").IntegrityPolicy
}

export type ExecutionSummary = {
  status: "ok" | "syntax_error" | "runtime_error" | "timeout" | "oom"
  results: Array<{
    name: string
    passed: boolean
    error: string | null
  }>
  score: number
  passed: number
  total: number
}

export type ExecutionTest = {
  index: number
  name: string
  display_name: string
  status: 'passed' | 'failed' | 'timeout' | 'not_run'
  passed: boolean
  duration_ms: number
  inputs?: string
  expected?: string
  actual?: string
  error_type?: string
  error_message?: string
  traceback?: Array<{ line: number; function: string; code: string }>
  stdout?: string
  stdout_truncated?: boolean
}
export type ExecutionResult = ExecutionSummary & {
  ran: number
  failed: number
  stdout: string
  stdout_truncated: boolean
  duration_ms: number
  tests: ExecutionTest[]
  syntax_error?: { error_type: string; error_message?: string; line: number; code_line?: string }
}
export type RunResult = ExecutionSummary | ExecutionResult
