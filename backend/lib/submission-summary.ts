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
  created_at: string | Date
}

export function acceptedSummary(row: SubmissionSummary) {
  return {
    submission_id: row.id,
    submitted_at: row.created_at,
    version: row.version,
    code_sha256: row.code_sha256,
    execution: { status: row.status, results: row.results, score: row.score, passed: row.passed, total: row.total },
  }
}
