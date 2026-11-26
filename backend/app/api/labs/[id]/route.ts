import { requireUser } from "../../../../lib/auth"
import { pool } from "../../../../lib/db"
import { courseAccessSql } from "../../../../lib/courses"
import { integrityPolicy } from "../../../../lib/integrity"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Lab = {
  id: string
  title: string
  instructions: string
  starter: string
  course_id: string
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user, error } = await requireUser(req)
  if (error) return error

  const { id } = await params
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  if (!uuidPattern.test(id)) {
    return Response.json(
      { error: "Invalid lab ID" },
      { status: 400 },
    )
  }

  try {
    const result = await pool.query<Lab>(
      `SELECT l.id, l.title, l.instructions, l.starter, l.course_id
       FROM public.labs l JOIN public.courses c ON c.id = l.course_id
       WHERE ${courseAccessSql} AND l.id = $3`,
      [user.id, user.role, id],
    )

    const lab = result.rows[0]

    if (!lab) {
      return Response.json(
        { error: "Lab not found" },
        { status: 404 },
      )
    }

    return Response.json(
      {
        id: lab.id,
        title: lab.title,
        instructions: lab.instructions,
        starter: lab.starter,
        course_id: lab.course_id,
        integrity_policy: integrityPolicy,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    )
  } catch (error) {
    console.error(
      "Lab fetch failed:",
      error instanceof Error ? error.message : "Unknown error",
    )

    return Response.json(
      { error: "Unable to fetch lab" },
      { status: 500 },
    )
  }
}
