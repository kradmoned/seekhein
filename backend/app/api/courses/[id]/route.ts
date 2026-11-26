import { requireUser } from "../../../../lib/auth"
import { requireCourse } from "../../../../lib/courses"
import { pool } from "../../../../lib/db"
import { errorResponse, privateHeaders } from "../../../../lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser(req)
  if (error) return error

  try {
    const { id } = await params
    const course = await requireCourse(id, user)
    const labs = await pool.query<{ id: string; title: string }>(
      `SELECT id, title FROM public.labs WHERE course_id = $1
       ORDER BY created_at DESC, id DESC`,
      [course.id],
    )
    return Response.json({ ...course, labs: labs.rows }, { headers: privateHeaders })
  } catch (error) {
    return errorResponse(error, "Unable to fetch course")
  }
}
