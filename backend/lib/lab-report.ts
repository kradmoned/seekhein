import { pool } from "./db"
import { HttpError } from "./http"
import { integrityPolicy, scoreIntegrity, type IntegrityEvent } from "./integrity"
import { acceptedSummary, type SubmissionSummary } from "./submission-summary"

export type StudentReport = {
  student_id: string
  email: string
  full_name: string | null
  enrolled: boolean
  events: IntegrityEvent[]
  submissions: (SubmissionSummary & { created_at: string })[]
}

export async function readLabReport(id: string, teacherId: string, studentId: string | null = null) {
  // A single statement gives the report one database snapshot and checks
  // ownership before any student activity can be selected.
  const result = await pool.query<{ id: string; title: string; allow_resubmissions: boolean; max_submissions: number | null; students: StudentReport[] }>(
    `SELECT l.id, l.title, l.allow_resubmissions, l.max_submissions, COALESCE((
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
             'id', s.id, 'kind', s.kind, 'version', s.version, 'code_sha256', s.code_sha256, 'submit_anyway', s.submit_anyway, 'results', s.results, 'status', s.status, 'score', s.score, 'passed', s.passed,
             'total', s.total, 'created_at', s.created_at
           ) ORDER BY s.created_at, s.id)
           FROM public.submissions s WHERE s.lab_id = l.id AND s.student_id = p.id
         ), '[]'::jsonb)
       )) FROM public.profiles p WHERE ($3::uuid IS NULL OR p.id = $3) AND p.id IN (
         SELECT ce.student_id FROM public.course_enrollments ce WHERE ce.course_id = l.course_id
         UNION SELECT e.student_id FROM public.integrity_events e WHERE e.lab_id = l.id
         UNION SELECT s.student_id FROM public.submissions s WHERE s.lab_id = l.id
       )
     ), '[]'::jsonb) AS students
     FROM public.labs l JOIN public.courses c ON c.id = l.course_id
     WHERE l.id = $1 AND c.teacher_id = $2`,
    [id, teacherId, studentId],
  )
  const lab = result.rows[0]
  if (!lab) throw new HttpError(404, "Lab not found")
  const students = lab.students.map((student) => {
    const firstPassAt = student.submissions.find((s) => s.status === "ok" && s.score === 100 && s.total > 0)?.created_at ?? null
    const finals = student.submissions.filter((s) => s.kind === "final")
    finals.sort((a, b) => (b.version ?? 0) - (a.version ?? 0))
    return {
      ...student,
      practice_attempt_count: student.submissions.filter((s) => s.kind === "practice").length,
      accepted_submission_count: finals.length,
      remaining_submissions: lab.max_submissions === null ? null : Math.max(0, lab.max_submissions - finals.length),
      accepted_submission: finals[0] ? acceptedSummary(finals[0]) : null,
      first_pass_at: firstPassAt,
      integrity_scope: "current_lab" as const,
      integrity: scoreIntegrity(student.events, firstPassAt),
    }
  })
  students.sort((a, b) => a.integrity.score - b.integrity.score || a.student_id.localeCompare(b.student_id))
  return { lab_id: lab.id, title: lab.title, allow_resubmissions: lab.allow_resubmissions, max_submissions: lab.max_submissions, integrity_policy: integrityPolicy, chat_available: false, students }
}
