import { requireUser } from "../../../../../lib/auth"
import { pool } from "../../../../../lib/db"
import { BodyTooLargeError, readJsonBody } from "../../../../../lib/json"
import {
  maxRequestBytes,
  maxSourceBytes,
  runCode,
  RunnerError,
} from "../../../../../lib/runner"

export const runtime = "nodejs"

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { error } = await requireUser(req)
  if (error) return error

  const { id } = await params
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  if (!uuidPattern.test(id)) {
    return Response.json({ error: "Invalid lab ID" }, { status: 400 })
  }

  const contentType = req.headers.get("content-type")?.split(";")[0].trim().toLowerCase()
  if (contentType !== "application/json") {
    return Response.json({ error: "Send code as application/json" }, { status: 415 })
  }

  let body: unknown
  try {
    body = await readJsonBody(req, maxRequestBytes)
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return Response.json({ error: "Request body exceeds 512 KiB" }, { status: 413 })
    }
    return Response.json({ error: "Invalid JSON request body" }, { status: 400 })
  }

  if (
    typeof body !== "object" || body === null || Array.isArray(body) ||
    !("code" in body) || typeof body.code !== "string" ||
    Object.keys(body).some((key) => key !== "code")
  ) {
    return Response.json({ error: "Send an object containing only a code string" }, { status: 422 })
  }

  if (!body.code.trim()) {
    return Response.json({ error: "Code must not be empty" }, { status: 422 })
  }
  if (Buffer.byteLength(body.code, "utf8") > maxSourceBytes) {
    return Response.json({ error: "Code must be at most 64 KiB" }, { status: 413 })
  }

  try {
    const result = await pool.query<{ tests: string }>(
      `SELECT tests FROM public.labs WHERE id = $1`,
      [id],
    )
    const lab = result.rows[0]
    if (!lab) {
      return Response.json({ error: "Lab not found" }, { status: 404 })
    }

    const resultForStudent = await runCode(body.code, lab.tests)
    return Response.json(resultForStudent, {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch (error) {
    if (error instanceof RunnerError) {
      return Response.json({ error: error.message }, { status: error.status })
    }
    // Do not log submitted source, hidden tests, or database error details.
    console.error("Lab run failed")
    return Response.json({ error: "Unable to run the lab" }, { status: 500 })
  }
}
