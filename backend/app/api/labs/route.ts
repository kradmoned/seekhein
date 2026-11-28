import { requireUser } from "../../../lib/auth"
import { pool } from "../../../lib/db"
import { courseAccessSql, requireCourse } from "../../../lib/courses"
import { errorResponse, HttpError, privateHeaders, uuidPattern } from "../../../lib/http"
import { allowsResubmissions, readUploadSubmissionLimit } from "../../../lib/submission-policy"
import { validateLab, validationSummary } from "../../../lib/lab-validation"
import { maxSourceBytes, RunnerError } from "../../../lib/runner"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const { user, error } = await requireUser(req)
  if (error) return error

  try {
    const courseId = new URL(req.url).searchParams.get("course_id")
    if (courseId !== null) await requireCourse(courseId, user)
    const result = await pool.query<{ id: string; title: string; course_id: string }>(
      `SELECT l.id, l.title, l.course_id
       FROM public.labs l JOIN public.courses c ON c.id = l.course_id
       WHERE ${courseAccessSql} AND ($3::uuid IS NULL OR l.course_id = $3)
       ORDER BY l.created_at DESC, l.id DESC`,
      [user.id, user.role, courseId],
    )

    return Response.json(
      result.rows.map(({ id, title, course_id }) => ({ id, title, course_id })),
      { headers: { "Cache-Control": "private, no-store" } },
    )
  } catch (error) {
    return errorResponse(error, "Unable to fetch labs")
  }
}

const fileFields = [
  "instructions",
  "starter",
  "tests",
  "solution",
] as const

type FileField = (typeof fileFields)[number]

const maxFileBytes = 1024 * 1024

export async function POST(req: Request) {
  const { user, error } = await requireUser(req, "teacher")
  if (error) return error

  const contentType = req.headers.get("content-type") ?? ""

  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return Response.json(
      { error: "Send the upload as multipart/form-data" },
      { status: 400 },
    )
  }

  let form: FormData

  try {
    form = await req.formData()
  } catch {
    return Response.json(
      { error: "Unable to read the upload" },
      { status: 400 },
    )
  }

  const validationErrors: string[] = []
  let oversized = false
  const titleValue = form.get("title")
  const title = typeof titleValue === "string" ? titleValue.trim() : ""
  const courseValues = form.getAll("course_id")
  const courseId = courseValues[0]

  if (courseValues.length !== 1 || typeof courseId !== "string" || !uuidPattern.test(courseId)) {
    return Response.json({ errors: ["A valid course_id is required."] }, { status: 422 })
  }
  try {
    await requireCourse(courseId, user)
  } catch (error) {
    return errorResponse(error, "Unable to access course")
  }

  if (!title) {
    validationErrors.push("A lab title is required.")
  }

  let maxSubmissions: number | null = 1
  try {
    maxSubmissions = readUploadSubmissionLimit(form)
  } catch (error) {
    if (!(error instanceof HttpError)) throw error
    validationErrors.push(error.message)
  }

  const files: Record<FileField, string> = {
    instructions: "",
    starter: "",
    tests: "",
    solution: "",
  }

  for (const field of fileFields) {
    const entries = form.getAll(field)
    const file = entries[0]

    if (entries.length !== 1 || !(file instanceof File)) {
      validationErrors.push(`Upload exactly one ${field} file.`)
      continue
    }

    const byteLimit = field === "instructions" ? maxFileBytes : maxSourceBytes
    if (file.size === 0 || file.size > byteLimit) {
      if (file.size > byteLimit) oversized = true
      validationErrors.push(
        `The ${field} file must be nonempty and at most ${field === "instructions" ? "1 MiB" : "64 KiB"}.`,
      )
      continue
    }

    try {
      // Preserve indentation and reject invalid UTF-8 text.
      const contents = new TextDecoder("utf-8", {
        fatal: true,
      }).decode(await file.arrayBuffer())

      if (!contents.trim()) {
        validationErrors.push(`The ${field} file contains only whitespace.`)
        continue
      }
      if (contents.includes("\0")) {
        validationErrors.push(`The ${field} file must not contain null characters.`)
        continue
      }

      files[field] = contents
    } catch {
      validationErrors.push(`The ${field} file must contain valid UTF-8 text.`)
    }
  }

  if (validationErrors.length > 0) {
    return Response.json(
      { errors: validationErrors },
      { status: oversized ? 413 : 422, headers: privateHeaders },
    )
  }

  try {
    const validation = await validateLab(files.solution, files.tests)
    if (!validation.valid) {
      return Response.json({
        code: "LAB_VALIDATION_FAILED", error: "The reference solution and tests did not pass lab validation.", validation,
      }, { status: 422, headers: privateHeaders })
    }
    const summary = validationSummary(validation)
    const result = await pool.query<{ id: string; validated_at: Date }>(
      `INSERT INTO public.labs (
         teacher_id,
         title,
         instructions,
         starter,
         tests,
         solution,
         course_id,
         allow_resubmissions,
         max_submissions,
         validated_at,
         validation_summary
       )
       SELECT $1, $2, $3, $4, $5, $6, c.id, $8, $9, statement_timestamp(), $10::jsonb
       FROM public.courses c WHERE c.id = $7 AND c.teacher_id = $1
       RETURNING id, validated_at`,
      [
        user.id,
        title,
        files.instructions,
        files.starter,
        files.tests,
        files.solution,
        courseId,
        allowsResubmissions(maxSubmissions),
        maxSubmissions,
        JSON.stringify(summary),
      ],
    )

    if (!result.rows[0]) {
      return Response.json({ error: "Course not found" }, { status: 404 })
    }
    return Response.json(
      { id: result.rows[0].id, validated_at: result.rows[0].validated_at, validation: summary },
      { status: 201, headers: privateHeaders },
    )
  } catch (error) {
    if (error instanceof RunnerError) {
      return Response.json({ code: "LAB_VALIDATION_SERVICE_ERROR", error: error.message }, {
        status: error.status, headers: { ...privateHeaders, ...(error.status === 429 ? { "Retry-After": "2" } : {}) },
      })
    }
    return errorResponse(error, "Unable to save the lab")
  }
}
