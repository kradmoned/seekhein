import { requireUser } from "../../../lib/auth"
import { pool } from "../../../lib/db"

export const runtime = "nodejs"

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
  const titleValue = form.get("title")
  const title = typeof titleValue === "string" ? titleValue.trim() : ""

  if (!title) {
    validationErrors.push("A lab title is required.")
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

    if (file.size === 0 || file.size > maxFileBytes) {
      validationErrors.push(
        `The ${field} file must be nonempty and at most 1 MiB.`,
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

      files[field] = contents
    } catch {
      validationErrors.push(`The ${field} file must contain valid UTF-8 text.`)
    }
  }

  if (validationErrors.length > 0) {
    return Response.json(
      { errors: validationErrors },
      { status: 422 },
    )
  }

  try {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO public.labs (
         teacher_id,
         title,
         instructions,
         starter,
         tests,
         solution
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        user.id,
        title,
        files.instructions,
        files.starter,
        files.tests,
        files.solution,
      ],
    )

    return Response.json(
      { id: result.rows[0].id },
      { status: 201 },
    )
  } catch (error) {
    console.error(
      "Lab upload failed:",
      error instanceof Error ? error.message : "Unknown error",
    )

    return Response.json(
      { error: "Unable to save the lab" },
      { status: 500 },
    )
  }
}