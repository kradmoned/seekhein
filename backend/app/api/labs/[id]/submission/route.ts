import { requireUser } from "../../../../../lib/auth"
import { pool } from "../../../../../lib/db"
import { errorResponse, HttpError, privateHeaders, uuidPattern } from "../../../../../lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser(req, "student")
  if (error) return error
  try {
    const { id } = await params
    if (!uuidPattern.test(id)) throw new HttpError(400, "Invalid lab ID")
    const result = await pool.query(
      `SELECT l.id AS lab_id, l.allow_resubmissions, l.max_submissions,
       (SELECT count(*)::int FROM public.submissions s
         WHERE s.lab_id = l.id AND s.student_id = $2 AND s.kind = 'final') AS accepted_submission_count, (
         SELECT jsonb_build_object('submission_id', s.id, 'submitted_at', s.created_at,
           'version', s.version, 'code_sha256', s.code_sha256,
           'execution', jsonb_build_object('status', s.status, 'results', s.results,
             'score', s.score, 'passed', s.passed, 'total', s.total))
         FROM public.submissions s WHERE s.lab_id = l.id AND s.student_id = $2 AND s.kind = 'final'
         ORDER BY s.version DESC LIMIT 1
       ) AS accepted_submission
       FROM public.labs l JOIN public.course_enrollments e ON e.course_id = l.course_id
       WHERE l.id = $1 AND e.student_id = $2`, [id, user.id],
    )
    const lab = result.rows[0]
    if (!lab) throw new HttpError(404, "Lab not found")
    const remaining = lab.max_submissions === null ? null : Math.max(0, lab.max_submissions - lab.accepted_submission_count)
    return Response.json({ ...lab, remaining_submissions: remaining, can_submit: remaining === null || remaining > 0 }, { headers: privateHeaders })
  } catch (error) {
    return errorResponse(error, "Unable to fetch submission status")
  }
}
