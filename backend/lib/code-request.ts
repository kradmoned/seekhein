import { HttpError } from "./http"
import { BodyTooLargeError, readJsonBody } from "./json"
import { maxRequestBytes, maxSourceBytes } from "./runner"

export async function readCode(req: Request): Promise<string> {
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
    Object.keys(body).some((key) => key !== "code")
  ) {
    throw new HttpError(422, "Send an object containing only a code string")
  }

  if (!body.code.trim()) {
    throw new HttpError(422, "Code must not be empty")
  }
  if (Buffer.byteLength(body.code, "utf8") > maxSourceBytes) {
    throw new HttpError(413, "Code must be at most 64 KiB")
  }

  return body.code
}
