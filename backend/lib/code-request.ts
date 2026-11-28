import { HttpError } from "./http"
import { BodyTooLargeError, readJsonBody } from "./json"
import { maxRequestBytes, maxSourceBytes } from "./runner"

async function readCodeBody(req: Request, allowSubmitAnyway: boolean): Promise<{ code: string; submit_anyway?: boolean }> {
  const contentType = req.headers.get("content-type")?.split(";")[0].trim().toLowerCase()
  if (contentType !== "application/json") {
    throw new HttpError(415, "Send code as application/json")
  }

  let body: unknown
  try {
    body = await readJsonBody(req, maxRequestBytes)
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      throw new HttpError(413, "Request body exceeds 512 KiB")
    }
    throw new HttpError(400, "Invalid JSON request body")
  }

  if (
    typeof body !== "object" || body === null || Array.isArray(body) ||
    !("code" in body) || typeof body.code !== "string" ||
    Object.keys(body).some((key) => key !== "code" && !(allowSubmitAnyway && key === "submit_anyway"))
  ) {
    throw new HttpError(422, allowSubmitAnyway ? "Send a code string and an optional submit_anyway boolean" : "Send an object containing only a code string")
  }
  if ("submit_anyway" in body && typeof body.submit_anyway !== "boolean") {
    throw new HttpError(422, "submit_anyway must be a boolean")
  }

  if (!body.code.trim()) {
    throw new HttpError(422, "Code must not be empty")
  }
  if (Buffer.byteLength(body.code, "utf8") > maxSourceBytes) {
    throw new HttpError(413, "Code must be at most 64 KiB")
  }

  return body as { code: string; submit_anyway?: boolean }
}

export async function readCode(req: Request): Promise<string> {
  return (await readCodeBody(req, false)).code
}

export async function readSubmission(req: Request): Promise<{ code: string; submit_anyway: boolean }> {
  const body = await readCodeBody(req, true)
  return { code: body.code, submit_anyway: body.submit_anyway ?? false }
}
