import type { runCode } from "./runner"

export type SubmissionSummary = {
  id: string
  kind: "practice" | "final"
  version: number | null
  code_sha256: string | null
  status: string
  score: number
  passed: number
  total: number
  results: Awaited<ReturnType<typeof runCode>>["results"]
  execution_output?: Awaited<ReturnType<typeof runCode>> | null
  submit_anyway: boolean
  created_at: string | Date
}

export function acceptedSummary(row: SubmissionSummary) {
  return {
    submission_id: row.id,
    submitted_at: row.created_at,
    version: row.version,
    code_sha256: row.code_sha256,
    submit_anyway: row.submit_anyway,
    submission_status: row.status === "ok" && row.total > 0 && row.passed === row.total ? "passed" : "pending_review",
    execution: row.execution_output ?? { status: row.status, results: row.results, score: row.score, passed: row.passed, total: row.total },
  }
}
