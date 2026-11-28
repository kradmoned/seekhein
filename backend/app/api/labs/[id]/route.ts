import { requireUser } from "../../../../lib/auth"
import { pool } from "../../../../lib/db"
import { courseAccessSql } from "../../../../lib/courses"
import { integrityPolicy } from "../../../../lib/integrity"
import { errorResponse, HttpError, privateHeaders, readObject, uuidPattern } from "../../../../lib/http"
import { allowsResubmissions, validateSubmissionLimit } from "../../../../lib/submission-policy"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Lab = {
  id: string
  title: string
  instructions: string
  starter: string
  allow_resubmissions: boolean
  max_submissions: number | null
  course_id: string
  validated_at: string | null
  validation_summary: Record<string, unknown> | null
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
      `SELECT l.id, l.title, l.instructions, l.starter, l.course_id, l.allow_resubmissions, l.max_submissions,
         l.validated_at, l.validation_summary
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
        allow_resubmissions: lab.allow_resubmissions,
        max_submissions: lab.max_submissions,
        integrity_policy: integrityPolicy,
        ...(user.role === "teacher" ? { validated_at: lab.validated_at, validation: lab.validation_summary } : {}),
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

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser(req, "teacher")
  if (error) return error
  try {
    const { id } = await params
    if (!uuidPattern.test(id)) throw new HttpError(400, "Invalid lab ID")
    const body = await readObject(req)
    if (Object.keys(body).length !== 1 || !("max_submissions" in body)) {
      throw new HttpError(422, "Send only max_submissions")
    }
    const limit = validateSubmissionLimit(body.max_submissions)
    const result = await pool.query(
      `UPDATE public.labs l SET max_submissions = $3, allow_resubmissions = $4
       FROM public.courses c WHERE l.id = $1 AND l.course_id = c.id AND c.teacher_id = $2
       RETURNING l.id, l.max_submissions, l.allow_resubmissions`,
      [id, user.id, limit, allowsResubmissions(limit)],
    )
    if (!result.rows[0]) throw new HttpError(404, "Lab not found")
    return Response.json(result.rows[0], { headers: privateHeaders })
  } catch (error) {
    return errorResponse(error, "Unable to update submission limit")
  }
}
