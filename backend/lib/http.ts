import { BodyTooLargeError, readJsonBody } from "./json"

export const privateHeaders = { "Cache-Control": "private, no-store" }
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export async function readObject(req: Request): Promise<Record<string, unknown>> {
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Send the request as application/json")
  }

  let body: unknown
  try {
    body = await readJsonBody(req, 16 * 1024)
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      throw new HttpError(413, "Request body exceeds 16 KiB")
    }
    throw new HttpError(400, "Invalid JSON request body")
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(422, "Send a JSON object")
  }
  return body as Record<string, unknown>
}

export function errorResponse(error: unknown, message: string) {
  if (error instanceof HttpError) {
    return Response.json({ error: error.message }, { status: error.status, headers: privateHeaders })
  }
  console.error(message)
  return Response.json({ error: message }, { status: 500, headers: privateHeaders })
}
