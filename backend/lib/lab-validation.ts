import { maxSourceBytes, requestRunner, RunnerError } from "./runner"

type ExecutionStatus = "ok" | "syntax_error" | "runtime_error" | "timeout" | "oom"
type TestStatus = "passed" | "failed" | "timeout" | "not_run"

export type TeacherTestDiagnostic = {
  index: number
  name: string
  display_name: string
  status: TestStatus
  passed: boolean
  duration_ms: number
  inputs?: string
  expected?: string
  actual?: string
  error_type?: string
  error_message?: string
  full_traceback?: string
  stdout?: string
}

export type LabValidation = {
  valid: boolean
  summary: string
  status: ExecutionStatus
  duration_ms: number
  total_tests: number
  ran_tests: number
  passed_tests: number
  failed_tests: number
  tests: TeacherTestDiagnostic[]
  warnings: string[]
  stdout?: string
  syntax_error?: {
    source: "solution" | "tests"
    error_type: string
    error_message?: string
    line: number
    code_line?: string
  }
}

function invalid(): never {
  throw new RunnerError(502, "Code runner returned an invalid validation response")
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function text(value: unknown, limit: number): string {
  if (typeof value !== "string") return invalid()
  return value.slice(0, limit)
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid()
  return value
}
function optionalText(data: Record<string, unknown>, key: string, limit: number) {
  return data[key] === undefined ? {} : { [key]: text(data[key], limit) }
}

export async function validateLab(solution: string, tests: string): Promise<LabValidation> {
  if ([solution, tests].some((source) => Buffer.byteLength(source, "utf8") > maxSourceBytes)) {
    throw new RunnerError(413, "Solution and tests must each be at most 64 KiB")
  }
  const response = await requestRunner("/validate", { solution, tests })
  const data = object(response.data)
  if (data.status === "internal_error") {
    throw new RunnerError(502, "Code runner could not validate the lab")
  }
  if (typeof data.status !== "string" || !["ok", "syntax_error", "runtime_error", "timeout", "oom"].includes(data.status) || typeof data.valid !== "boolean") return invalid()
  const total = count(data.total_tests)
  const ran = count(data.ran_tests)
  const passed = count(data.passed_tests)
  const failed = count(data.failed_tests)
  if (!Array.isArray(data.tests) || data.tests.length !== total) return invalid()
  const diagnostics = data.tests.map((item): TeacherTestDiagnostic => {
    const test = object(item)
    if (typeof test.status !== "string" || !["passed", "failed", "timeout", "not_run"].includes(test.status) ||
        typeof test.passed !== "boolean" || test.passed !== (test.status === "passed")) return invalid()
    const index = count(test.index)
    if (index < 1) return invalid()
    return {
      index, name: text(test.name, 512), display_name: text(test.display_name, 120),
      status: test.status as TestStatus, passed: test.passed, duration_ms: count(test.duration_ms),
      ...optionalText(test, "inputs", 300), ...optionalText(test, "expected", 300),
      ...optionalText(test, "actual", 300), ...optionalText(test, "error_type", 128),
      ...optionalText(test, "error_message", 512), ...optionalText(test, "full_traceback", 2048),
      ...optionalText(test, "stdout", 4096),
    }
  })
  if (passed !== diagnostics.filter((test) => test.passed).length ||
      failed !== diagnostics.filter((test) => test.status === "failed" || test.status === "timeout").length ||
      ran !== passed + failed || (data.status !== "ok" && total !== 0)) return invalid()
  const valid = data.status === "ok" && total > 0 && passed === total && ran === total && failed === 0
  if (data.valid !== valid || (response.httpStatus === 200) !== valid) return invalid()
  if (data.warnings !== undefined && !Array.isArray(data.warnings)) return invalid()
  const warnings = (data.warnings as unknown[] | undefined)?.map((warning) => text(warning, 1024)).slice(0, 100) ?? []
  let syntaxError: LabValidation["syntax_error"]
  if (data.syntax_error !== undefined) {
    const syntax = object(data.syntax_error)
    if (syntax.source !== "solution" && syntax.source !== "tests") return invalid()
    syntaxError = {
      source: syntax.source, error_type: text(syntax.error_type, 128), line: count(syntax.line),
      ...optionalText(syntax, "error_message", 512), ...optionalText(syntax, "code_line", 200),
    }
  }
  return {
    valid, summary: text(data.summary, 2048), status: data.status as ExecutionStatus,
    duration_ms: count(data.duration_ms), total_tests: total, ran_tests: ran,
    passed_tests: passed, failed_tests: failed, tests: diagnostics, warnings,
    ...optionalText(data, "stdout", 16384), ...(syntaxError ? { syntax_error: syntaxError } : {}),
  }
}

// Persist only the audit summary. Full diagnostics are returned to the uploader
// and must never be mixed into student execution/report responses.
export function validationSummary(validation: LabValidation) {
  return {
    valid: validation.valid, status: validation.status, total_tests: validation.total_tests,
    passed_tests: validation.passed_tests, warnings: validation.warnings,
  }
}
