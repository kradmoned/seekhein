import { requireUser } from "../../../../../lib/auth"
import { pool } from "../../../../../lib/db"
import { courseAccessSql } from "../../../../../lib/courses"
import { readCode } from "../../../../../lib/code-request"
import { HttpError } from "../../../../../lib/http"
import {
  runCode,
  RunnerError,
} from "../../../../../lib/runner"

export const runtime = "nodejs"

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user, error } = await requireUser(req)
  if (error) return error

  const { id } = await params
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  if (!uuidPattern.test(id)) {
    return Response.json({ error: "Invalid lab ID" }, { status: 400 })
  }

  try {
    const code = await readCode(req)
    const result = await pool.query<{ tests: string }>(
      `SELECT l.tests FROM public.labs l
       JOIN public.courses c ON c.id = l.course_id
       WHERE ${courseAccessSql} AND l.id = $3`,
      [user.id, user.role, id],
    )
    const lab = result.rows[0]
    if (!lab) {
      return Response.json({ error: "Lab not found" }, { status: 404 })
    }

    const resultForStudent = await runCode(code, lab.tests)
    if (user.role === "student") {
      await pool.query(
        `INSERT INTO public.submissions
           (lab_id, student_id, code, status, results, score, passed, total)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
        [id, user.id, code, resultForStudent.status,
          JSON.stringify(resultForStudent.results), resultForStudent.score,
          resultForStudent.passed, resultForStudent.total],
      )
    }
    return Response.json(resultForStudent, {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch (error) {
    if (error instanceof RunnerError || error instanceof HttpError) {
      return Response.json({ error: error.message }, { status: error.status })
    }
    // Do not log submitted source, hidden tests, or database error details.
    console.error("Lab run failed")
    return Response.json({ error: "Unable to run the lab" }, { status: 500 })
  }
}
