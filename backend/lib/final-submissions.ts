import { createHash } from "node:crypto"
import { pool } from "./db"
import { HttpError } from "./http"
import { runCode } from "./runner"

export class SubmissionError extends HttpError {
  constructor(status: number, public code: string, message: string) {
    super(status, message)
  }
}

type Outcome = { http_status: number; body: Record<string, unknown> }

export async function submitFinal(labId: string, studentId: string, key: string, code: string): Promise<Outcome> {
  labId = labId.toLowerCase()
  studentId = studentId.toLowerCase()
  // Access is checked even on replay; a key never grants access by itself.
  const access = await pool.query(
    `SELECT l.id FROM public.labs l JOIN public.course_enrollments e ON e.course_id = l.course_id
     WHERE l.id = $1 AND e.student_id = $2`, [labId, studentId],
  )
  if (!access.rows[0]) throw new SubmissionError(404, "LAB_NOT_FOUND", "Lab not found")
  await pool.query(
    `INSERT INTO public.submission_requests (lab_id, student_id, idempotency_key, code)
     VALUES ($1, $2, $3, $4) ON CONFLICT (lab_id, student_id, idempotency_key) DO NOTHING`,
    [labId, studentId, key, code],
  )
  const requests = await pool.query<{ id: string; code: string }>(
    `SELECT id, code FROM public.submission_requests WHERE lab_id = $1 AND student_id = $2 AND idempotency_key = $3`,
    [labId, studentId, key],
  )
  const request = requests.rows[0]
  if (request.code !== code) throw new SubmissionError(409, "IDEMPOTENCY_KEY_REUSED", "This key was already used with different code")
  const replay = await pool.query<Outcome>(
    "SELECT http_status, body FROM public.submission_outcomes WHERE request_id = $1", [request.id],
  )
  if (replay.rows[0]) return replay.rows[0]

  const client = await pool.connect()
  let destroyConnection = false
  try {
    await client.query("BEGIN")
    // Serialize all final submissions for a student/lab, including different
    // keys. The transaction releases this lock on commit, rollback or crash.
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired", [`${studentId}:${labId}`],
    )
    if (!lock.rows[0].acquired) throw new SubmissionError(409, "SUBMISSION_PROCESSING", "A submission for this lab is processing. Retry the same key.")
    const completed = await client.query<Outcome>(
      "SELECT http_status, body FROM public.submission_outcomes WHERE request_id = $1", [request.id],
    )
    if (completed.rows[0]) {
      await client.query("COMMIT")
      return completed.rows[0]
    }
    // Keep tests, policy and enrollment stable through verification and saving.
    const labs = await client.query<{ tests: string; max_submissions: number | null }>(
      `SELECT l.tests, l.max_submissions FROM public.labs l
       JOIN public.course_enrollments e ON e.course_id = l.course_id
       WHERE l.id = $1 AND e.student_id = $2 FOR SHARE OF l, e`, [labId, studentId],
    )
    const lab = labs.rows[0]
    if (!lab) throw new SubmissionError(404, "LAB_NOT_FOUND", "Lab not found")
    const prior = await client.query<{ accepted_count: number }>(
      "SELECT count(*)::int AS accepted_count FROM public.submissions WHERE lab_id = $1 AND student_id = $2 AND kind = 'final'",
      [labId, studentId],
    )
    let outcome: Outcome
    if (lab.max_submissions !== null && prior.rows[0].accepted_count >= lab.max_submissions) {
      outcome = { http_status: 409, body: {
        code: lab.max_submissions === 1 ? "FINAL_SUBMISSION_LOCKED" : "SUBMISSION_LIMIT_REACHED",
        error: "The accepted submission limit for this lab has been reached",
      } }
    } else {
      const execution = await runCode(code, lab.tests)
      const accepted = execution.status === "ok" && execution.total > 0 && execution.passed === execution.total
      let submissionId: string | null = null
      let submittedAt: string | null = null
      if (accepted) {
        const saved = await client.query<{ id: string; created_at: Date }>(
          `INSERT INTO public.submissions
             (lab_id, student_id, code, status, results, score, passed, total, kind, request_id, code_sha256)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, 'final', $9, $10)
           RETURNING id, created_at`,
          [labId, studentId, code, execution.status, JSON.stringify(execution.results), execution.score,
            execution.passed, execution.total, request.id, createHash("sha256").update(code, "utf8").digest("hex")],
        )
        submissionId = saved.rows[0].id
        submittedAt = saved.rows[0].created_at.toISOString()
      }
      outcome = { http_status: 200, body: { accepted, submission_id: submissionId, submitted_at: submittedAt, execution } }
    }
    await client.query(
      "INSERT INTO public.submission_outcomes (request_id, http_status, body) VALUES ($1, $2, $3::jsonb)",
      [request.id, outcome.http_status, JSON.stringify(outcome.body)],
    )
    // An accepted row and its replayable outcome commit together.
    await client.query("COMMIT")
    return outcome
  } catch (error) {
    try { await client.query("ROLLBACK") } catch { destroyConnection = true }
    throw error
  } finally {
    client.release(destroyConnection)
  }
}
