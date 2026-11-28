import { requireUser } from "../../../../../lib/auth"
import { requireCourse } from "../../../../../lib/courses"
import { pool } from "../../../../../lib/db"
import { errorResponse, HttpError, privateHeaders, readObject } from "../../../../../lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Context = { params: Promise<{ id: string }> }

export async function GET(req: Request, { params }: Context) {
  const { user, error } = await requireUser(req, "teacher")
  if (error) return error

  try {
    const { id } = await params
    await requireCourse(id, user)
    const result = await pool.query(
      `SELECT p.id, p.email, p.full_name, e.enrolled_at
       FROM public.course_enrollments e
       JOIN public.profiles p ON p.id = e.student_id
       WHERE e.course_id = $1
       ORDER BY e.enrolled_at DESC, e.student_id DESC`,
      [id],
    )
    return Response.json(result.rows, { headers: privateHeaders })
  } catch (error) {
    return errorResponse(error, "Unable to fetch enrolled students")
  }
}

export async function POST(req: Request, { params }: Context) {
  const { user, error } = await requireUser(req, "teacher")
  if (error) return error

  try {
    const { id } = await params
    await requireCourse(id, user)
    const body = await readObject(req)
    if (
      typeof body.email !== "string" || body.email.trim().length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) ||
      Object.keys(body).some((key) => key !== "email")
    ) {
      throw new HttpError(422, "Send an object containing only a valid email address")
    }
    const students = await pool.query<{ id: string; role: string }>(
      `SELECT id, role FROM public.profiles WHERE lower(email) = lower($1) LIMIT 2`,
      [body.email.trim()],
    )
    if (students.rows.length > 1) {
      throw new HttpError(409, "Multiple profiles use this email. Contact your administrator.")
    }
    const student = students.rows[0]
    if (!student || student.role !== "student") {
      throw new HttpError(422, "No student account exists for this email")
    }
    // A unique key makes repeated and concurrent requests safe. The INSERT
    // also rechecks ownership and the target profile's role.
    await pool.query(
      `INSERT INTO public.course_enrollments (course_id, student_id)
       SELECT c.id, p.id FROM public.courses c
       JOIN public.profiles p ON p.id = $2 AND p.role = 'student'
       WHERE c.id = $1 AND c.teacher_id = $3
       ON CONFLICT (course_id, student_id) DO NOTHING`,
      [id, student.id, user.id],
    )
    const enrollment = await pool.query<{ course_id: string; student_id: string; enrolled_at: string }>(
      `SELECT e.course_id, e.student_id, e.enrolled_at
       FROM public.course_enrollments e
       JOIN public.courses c ON c.id = e.course_id
       JOIN public.profiles p ON p.id = e.student_id AND p.role = 'student'
       WHERE e.course_id = $1 AND e.student_id = $2 AND c.teacher_id = $3`,
      [id, student.id, user.id],
    )
    if (!enrollment.rows[0]) throw new HttpError(409, "Course or student changed. Refresh and try again.")
    return Response.json(enrollment.rows[0], { headers: privateHeaders })
  } catch (error) {
    return errorResponse(error, "Unable to enroll student")
  }
}
