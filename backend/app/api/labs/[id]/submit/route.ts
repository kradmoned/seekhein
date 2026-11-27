import { requireUser } from "../../../../../lib/auth"
import { readCode } from "../../../../../lib/code-request"
import { SubmissionError, submitFinal } from "../../../../../lib/final-submissions"
import { HttpError, privateHeaders, uuidPattern } from "../../../../../lib/http"
import { RunnerError } from "../../../../../lib/runner"

export const runtime = "nodejs"

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser(req, "student")
  if (error) return error
  try {
    const { id } = await params
    if (!uuidPattern.test(id)) throw new SubmissionError(400, "INVALID_LAB_ID", "Invalid lab ID")
    const key = req.headers.get("idempotency-key")
    if (!key || !uuidPattern.test(key)) throw new SubmissionError(400, "INVALID_IDEMPOTENCY_KEY", "A UUID Idempotency-Key header is required")
    const code = await readCode(req)
    if (code.includes("\0") || Buffer.from(code, "utf8").toString("utf8") !== code) {
      throw new HttpError(422, "Code must be valid Unicode without null characters")
    }
    const outcome = await submitFinal(id, user.id, key, code)
    return Response.json(outcome.body, { status: outcome.http_status, headers: privateHeaders })
  } catch (error) {
    if (error instanceof SubmissionError) {
      return Response.json({ error: error.message, code: error.code }, {
        status: error.status,
        headers: { ...privateHeaders, ...(error.code === "SUBMISSION_PROCESSING" ? { "Retry-After": "2" } : {}) },
      })
    }
    if (error instanceof RunnerError || error instanceof HttpError) {
      return Response.json({ error: error.message, code: error instanceof RunnerError ? "EXECUTION_SERVICE_ERROR" : "INVALID_REQUEST" }, { status: error.status, headers: privateHeaders })
    }
    console.error("Final submission failed")
    return Response.json({ error: "Unable to complete submission. Retry the same key and code.", code: "SUBMISSION_SAVE_FAILED" }, { status: 500, headers: privateHeaders })
  }
}
