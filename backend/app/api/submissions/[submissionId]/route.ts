import { requireUser } from "../../../../lib/auth"
import { pool } from "../../../../lib/db"
import { errorResponse, HttpError, privateHeaders, uuidPattern } from "../../../../lib/http"
import { acceptedSummary, type SubmissionSummary } from "../../../../lib/submission-summary"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request, { params }: { params: Promise<{ submissionId: string }> }) {
  const { user, error } = await requireUser(req, "teacher")
  if (error) return error
  try {
    const { submissionId } = await params
    if (!uuidPattern.test(submissionId)) throw new HttpError(400, "Invalid submission ID")
    const result = await pool.query<SubmissionSummary & { lab_id: string; student_id: string; code: string }>(
      `SELECT s.id, s.lab_id, s.student_id, s.code, s.kind, s.version, s.code_sha256,
         s.status, s.results, s.score, s.passed, s.total, s.created_at
       FROM public.submissions s JOIN public.labs l ON l.id = s.lab_id
       JOIN public.courses c ON c.id = l.course_id
       WHERE s.id = $1 AND s.kind = 'final' AND c.teacher_id = $2`, [submissionId, user.id],
    )
    const submission = result.rows[0]
    if (!submission) throw new HttpError(404, "Submission not found")
    return Response.json({ ...acceptedSummary(submission), lab_id: submission.lab_id, student_id: submission.student_id, code: submission.code }, { headers: privateHeaders })
  } catch (error) {
    return errorResponse(error, "Unable to fetch submitted code")
  }
}
