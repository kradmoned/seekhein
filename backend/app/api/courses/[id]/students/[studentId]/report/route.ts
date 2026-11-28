import { requireUser } from "../../../../../../../lib/auth"
import { pool } from "../../../../../../../lib/db"
import { errorResponse, HttpError, privateHeaders, uuidPattern } from "../../../../../../../lib/http"
import { readLabReport } from "../../../../../../../lib/lab-report"
import { scoreIntegrity } from "../../../../../../../lib/integrity"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request, { params }: { params: Promise<{ id: string; studentId: string }> }) {
  const { user, error } = await requireUser(req, "teacher")
  if (error) return error
  try {
    const { id, studentId } = await params
    if (!uuidPattern.test(id) || !uuidPattern.test(studentId)) throw new HttpError(400, "Invalid course or student ID")
    const result = await pool.query(
      `SELECT p.id, p.email, p.full_name FROM public.profiles p
       JOIN public.courses c ON c.id = $1 AND c.teacher_id = $3
       WHERE p.id = $2 AND (
         EXISTS (SELECT 1 FROM public.course_enrollments e WHERE e.course_id = c.id AND e.student_id = p.id)
         OR EXISTS (SELECT 1 FROM public.submissions s JOIN public.labs l ON l.id = s.lab_id WHERE l.course_id = c.id AND s.student_id = p.id)
         OR EXISTS (SELECT 1 FROM public.integrity_events e JOIN public.labs l ON l.id = e.lab_id WHERE l.course_id = c.id AND e.student_id = p.id)
       )`, [id, studentId, user.id],
    )
    const student = result.rows[0]
    if (!student) throw new HttpError(404, "Course or student not found")
    const labs = await pool.query<{ id: string }>(
      `SELECT l.id FROM public.labs l JOIN public.courses c ON c.id = l.course_id
       WHERE c.id = $1 AND c.teacher_id = $2 ORDER BY l.created_at DESC, l.id DESC`, [id, user.id],
    )
    const reports = await Promise.all(labs.rows.map(async (lab) => {
      const report = await readLabReport(lab.id, user.id, studentId)
      const activity = report.students[0]
      // The student may be historical and have no activity in this particular lab.
      return {
        lab_id: report.lab_id, title: report.title, allow_resubmissions: report.allow_resubmissions,
        max_submissions: report.max_submissions,
        accepted_submission_count: activity?.accepted_submission_count ?? 0,
        remaining_submissions: activity ? activity.remaining_submissions : report.max_submissions,
        practice_attempt_count: activity?.practice_attempt_count ?? 0,
        accepted_submission: activity?.accepted_submission ?? null,
        integrity_scope: "current_lab",
        integrity: activity?.integrity ?? scoreIntegrity([], null),
      }
    }))
    return Response.json({ course_id: id, student, labs: reports }, { headers: privateHeaders })
  } catch (error) {
    return errorResponse(error, "Unable to fetch student report")
  }
}
