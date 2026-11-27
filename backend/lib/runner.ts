import { readJsonBody } from "./json"
import { studentDiagnostics } from "./runner-result"

export const maxSourceBytes = 64 * 1024
export const maxRequestBytes = 512 * 1024
const maxResponseBytes = 1024 * 1024
// Includes the runner's default 10s queue wait and 6s execution deadline.
const runnerTimeoutMs = 30_000

export class RunnerError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalidResponse(): never {
  throw new RunnerError(502, "Code runner returned an invalid response")
}

function studentResult(data: unknown) {
  if (!isObject(data)) return invalidResponse()

  const statuses = [
    "ok", "syntax_error", "runtime_error", "timeout", "oom", "internal_error",
  ]

  if (typeof data.status !== "string" || !statuses.includes(data.status)) {
    return invalidResponse()
  }

  for (const field of ["score", "ran", "passed", "failed", "total"] as const) {
    const value = data[field]
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      return invalidResponse()
    }
  }

  if (!Array.isArray(data.tests) || data.tests.length !== data.total) {
    return invalidResponse()
  }

  let passed = 0
  let failed = 0
  const results = data.tests.map((test: unknown, index: number) => {
    if (!isObject(test) || typeof test.passed !== "boolean") {
      return invalidResponse()
    }

    if (
      typeof test.status !== "string" || !["passed", "failed", "timeout", "not_run"].includes(test.status) ||
      test.passed !== (test.status === "passed")
    ) {
      return invalidResponse()
    }

    if (test.passed) passed++
    if (test.status === "failed" || test.status === "timeout") failed++

    // Keep the existing results array for clients using the compact contract.
    // Full runner diagnostics are returned separately in tests/stdout/etc.
    return {
      name: `Test ${index + 1}`,
      passed: test.passed,
      error: test.passed ? null
        : test.status === "timeout" ? "Test timed out"
        : test.status === "not_run" ? "Test was not run"
        : "Test failed",
    }
  })

  const total = results.length
  const score = data.status === "ok" && total > 0
    ? Math.floor(passed * 100 / total)
    : 0

  if (
    data.passed !== passed || data.failed !== failed ||
    data.ran !== passed + failed || data.score !== score
  ) {
    return invalidResponse()
  }

  if (data.status === "internal_error") {
    throw new RunnerError(502, "Code runner could not execute the lab")
  }

  if (data.status === "ok" && total === 0) {
    throw new RunnerError(422, "This lab has no runnable unittest tests. Contact your teacher.")
  }

  return { ...studentDiagnostics(data, invalidResponse), results }
}

export async function runCode(code: string, tests: string) {
  if (Buffer.byteLength(code, "utf8") > maxSourceBytes) {
    throw new RunnerError(413, "Code must be at most 64 KiB")
  }
  if (Buffer.byteLength(tests, "utf8") > maxSourceBytes) {
    throw new RunnerError(422, "This lab exceeds the runner's test size limit. Contact your teacher.")
  }

  return studentResult((await requestRunner("/run?view=student", { code, tests })).data)
}

// Only server-chosen paths and source are sent. Browser credentials and raw
// infrastructure error bodies must never pass through this boundary.
export async function requestRunner(
  endpoint: "/run?view=student" | "/validate",
  payload: { code: string; tests: string } | { solution: string; tests: string },
) {
  let url: URL
  try {
    const base = new URL(process.env.RUNNER_URL ?? "")
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username || base.password || base.search || base.hash ||
      base.pathname !== "/"
    ) {
      throw new Error("Invalid runner origin")
    }
    url = new URL(endpoint, base)
  } catch {
    throw new RunnerError(503, "Code runner is not configured")
  }

  const body = JSON.stringify(payload)
  if (Buffer.byteLength(body, "utf8") > maxRequestBytes) {
    throw new RunnerError(413, "Combined code and tests exceed the runner request limit")
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (process.env.RUNNER_INTERNAL_KEY) {
    headers["X-Internal-Key"] = process.env.RUNNER_INTERNAL_KEY
  }

  const signal = AbortSignal.timeout(runnerTimeoutMs)
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal,
      cache: "no-store",
      redirect: "error",
    })

    if (response.status !== 200 && !(endpoint === "/validate" && response.status === 422)) {
      // Never forward upstream error bodies: they may contain test contents.
      await response.body?.cancel()
      if (response.status === 429) {
        throw new RunnerError(429, "Code runner is busy. Try again shortly.")
      }
      if (response.status === 503) {
        throw new RunnerError(503, "Code runner is unavailable")
      }
      if (endpoint === "/validate" && response.status === 413) {
        throw new RunnerError(413, "Lab source exceeds the code runner's request limit")
      }
      throw new RunnerError(502, "Code runner rejected the request")
    }

    return { httpStatus: response.status, data: await readJsonBody(response, maxResponseBytes) }
  } catch (error) {
    if (error instanceof RunnerError) throw error
    if (signal.aborted) {
      throw new RunnerError(504, "Code runner request timed out")
    }
    // Keep network errors, malformed JSON, and upstream details server-side.
    throw new RunnerError(502, "Unable to get a valid response from the code runner")
  }
}
