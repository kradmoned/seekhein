import { requireUser } from "../../../../../lib/auth"
import { pool } from "../../../../../lib/db"
import { errorResponse, HttpError, privateHeaders, uuidPattern } from "../../../../../lib/http"
import { integrityPolicy, scoreIntegrity, type IntegrityEvent } from "../../../../../lib/integrity"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type StudentReport = {
  student_id: string
  email: string
  full_name: string | null
  enrolled: boolean
  events: IntegrityEvent[]
  submissions: { id: string; status: string; score: number; passed: number; total: number; created_at: string }[]
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser(req, "teacher")
  if (error) return error
  try {
    const { id } = await params
    if (!uuidPattern.test(id)) throw new HttpError(400, "Invalid lab ID")
    // A single statement gives the report one database snapshot and checks
    // ownership before any student activity can be selected.
    const result = await pool.query<{ id: string; title: string; students: StudentReport[] }>(
      `SELECT l.id, l.title, COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'student_id', p.id, 'email', p.email, 'full_name', p.full_name,
           'enrolled', EXISTS (SELECT 1 FROM public.course_enrollments ce WHERE ce.course_id = l.course_id AND ce.student_id = p.id),
           'events', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'event_id', e.event_id, 'session_id', e.session_id, 'type', e.type,
               'payload', e.payload, 'client_ts', e.client_ts, 'received_at', e.received_at
             ) ORDER BY e.received_at, e.id)
             FROM public.integrity_events e WHERE e.lab_id = l.id AND e.student_id = p.id
           ), '[]'::jsonb),
           'submissions', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'id', s.id, 'status', s.status, 'score', s.score, 'passed', s.passed,
               'total', s.total, 'created_at', s.created_at
             ) ORDER BY s.created_at, s.id)
             FROM public.submissions s WHERE s.lab_id = l.id AND s.student_id = p.id
           ), '[]'::jsonb)
         )) FROM public.profiles p WHERE p.id IN (
           SELECT ce.student_id FROM public.course_enrollments ce WHERE ce.course_id = l.course_id
           UNION SELECT e.student_id FROM public.integrity_events e WHERE e.lab_id = l.id
           UNION SELECT s.student_id FROM public.submissions s WHERE s.lab_id = l.id
         )
       ), '[]'::jsonb) AS students
       FROM public.labs l JOIN public.courses c ON c.id = l.course_id
       WHERE l.id = $1 AND c.teacher_id = $2`,
      [id, user.id],
    )
    const lab = result.rows[0]
    if (!lab) throw new HttpError(404, "Lab not found")
    const students = lab.students.map((student) => {
      const firstPassAt = student.submissions.find((s) => s.status === "ok" && s.score === 100 && s.total > 0)?.created_at ?? null
      return { ...student, first_pass_at: firstPassAt, integrity: scoreIntegrity(student.events, firstPassAt) }
    })
    students.sort((a, b) => a.integrity.score - b.integrity.score || a.student_id.localeCompare(b.student_id))
    return Response.json({ lab_id: lab.id, title: lab.title, integrity_policy: integrityPolicy, chat_available: false, students }, { headers: privateHeaders })
  } catch (error) {
    return errorResponse(error, "Unable to fetch lab report")
  }
}
