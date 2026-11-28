import { requireUser } from "../../../lib/auth"
import { courseAccessSql } from "../../../lib/courses"
import { pool } from "../../../lib/db"
import { errorResponse, HttpError, privateHeaders, readObject } from "../../../lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const { user, error } = await requireUser(req)
  if (error) return error

  try {
    const result = await pool.query(
      `SELECT c.id, c.title, c.description, c.created_at,
         (SELECT count(*)::int FROM public.labs l WHERE l.course_id = c.id) AS lab_count,
         CASE WHEN $2 = 'teacher' THEN
           (SELECT count(*)::int FROM public.course_enrollments e WHERE e.course_id = c.id)
         END AS student_count
       FROM public.courses c
       WHERE ${courseAccessSql}
       ORDER BY c.created_at DESC, c.id DESC`,
      [user.id, user.role],
    )
    const courses = result.rows.map((course) => ({
      id: course.id,
      title: course.title,
      description: course.description,
      created_at: course.created_at,
      lab_count: course.lab_count,
      ...(user.role === "teacher" ? { student_count: course.student_count } : {}),
    }))
    return Response.json(courses, { headers: privateHeaders })
  } catch (error) {
    return errorResponse(error, "Unable to fetch courses")
  }
}

export async function POST(req: Request) {
  const { user, error } = await requireUser(req, "teacher")
  if (error) return error

  try {
    const body = await readObject(req)
    if (
      typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 200 ||
      (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 5000)) ||
      Object.keys(body).some((key) => key !== "title" && key !== "description")
    ) {
      throw new HttpError(422, "Send a title of 1–200 characters and an optional description of at most 5000 characters")
    }
    const result = await pool.query<{ id: string }>(
      `INSERT INTO public.courses (teacher_id, title, description)
       VALUES ($1, $2, $3) RETURNING id`,
      [user.id, body.title.trim(), body.description ?? ""],
    )
    return Response.json({ id: result.rows[0].id }, { status: 201, headers: privateHeaders })
  } catch (error) {
    return errorResponse(error, "Unable to create course")
  }
}
