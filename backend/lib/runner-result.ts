export type TraceFrame = { line: number; function: string; code: string }
export type SyntaxErrorInfo = {
  error_type: string
  error_message?: string
  line: number
  code_line?: string
}
export type StudentTestResult = {
  index: number
  name: string
  display_name: string
  status: "passed" | "failed" | "timeout" | "not_run"
  passed: boolean
  duration_ms: number
  inputs?: string
  expected?: string
  actual?: string
  error_type?: string
  error_message?: string
  traceback?: TraceFrame[]
  stdout?: string
  stdout_truncated?: boolean
}
export type StudentRunResult = {
  status: "ok" | "syntax_error" | "runtime_error" | "timeout" | "oom"
  score: number
  ran: number
  passed: number
  failed: number
  total: number
  stdout: string
  stdout_truncated: boolean
  duration_ms: number
  tests: StudentTestResult[]
  syntax_error?: SyntaxErrorInfo
}

// Preserve every documented student-view field without rewriting diagnostics.
// Unknown fields from other runner views are not part of this API contract.
export function studentDiagnostics(data: Record<string, unknown>, invalid: () => never): StudentRunResult {
  function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid()
    return value as Record<string, unknown>
  }
  function fields(value: Record<string, unknown>, schema: Record<string, string>) {
    const result: Record<string, unknown> = {}
    for (const [name, specification] of Object.entries(schema)) {
      const optional = specification.endsWith("?")
      const type = optional ? specification.slice(0, -1) : specification
      const item = value[name]
      if (optional && item === undefined) continue
      if (type === "integer") {
        if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) return invalid()
      } else if (typeof item !== type) return invalid()
      result[name] = item
    }
    return result
  }
  const result = fields(data, {
    status: "string", score: "integer", ran: "integer", passed: "integer", failed: "integer", total: "integer",
    stdout: "string", stdout_truncated: "boolean", duration_ms: "integer",
  })
  if (!Array.isArray(data.tests)) return invalid()
  result.tests = data.tests.map((item) => {
    const value = object(item)
    const test = fields(value, {
      index: "integer", name: "string", display_name: "string", status: "string", passed: "boolean", duration_ms: "integer",
      inputs: "string?", expected: "string?", actual: "string?", error_type: "string?", error_message: "string?",
      stdout: "string?", stdout_truncated: "boolean?",
    })
    if ((test.index as number) < 1) return invalid()
    if (value.traceback !== undefined) {
      if (!Array.isArray(value.traceback)) return invalid()
      test.traceback = value.traceback.map((frame) => fields(object(frame), { line: "integer", function: "string", code: "string" }))
    }
    return test
  })
  if (data.syntax_error !== undefined) {
    result.syntax_error = fields(object(data.syntax_error), {
      error_type: "string", error_message: "string?", line: "integer", code_line: "string?",
    })
  }
  return result as StudentRunResult
}
