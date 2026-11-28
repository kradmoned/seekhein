import { BodyTooLargeError, readJsonBody } from "./json"
import { privateHeaders, uuidPattern } from "./http"
import { maxRequestBytes, maxSourceBytes } from "./runner"
import { ChatError, maxMessageBytes, validText } from "./tutor"

export type ChatInput = { message: string; current_code: string | null; attempt_id: string | null }
export function chatId(value: string): string {
  if (!uuidPattern.test(value)) throw new ChatError(400, "INVALID_ID", "A valid UUID is required")
  return value.toLowerCase()
}
export function messageKey(req: Request): string {
  const key = req.headers.get("idempotency-key")
  if (!key || !uuidPattern.test(key)) throw new ChatError(400, "INVALID_IDEMPOTENCY_KEY", "A UUID Idempotency-Key header is required")
  return key.toLowerCase()
}
export async function readChatInput(req: Request): Promise<ChatInput> {
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new ChatError(415, "INVALID_REQUEST", "Send application/json")
  let value: unknown
  try { value = await readJsonBody(req, maxRequestBytes) }
  catch (error) {
    throw new ChatError(error instanceof BodyTooLargeError ? 413 : 400, "INVALID_REQUEST", "Invalid or oversized JSON body")
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ChatError(422, "INVALID_REQUEST", "Send a message and current_code")
  const body = value as Record<string, unknown>
  if (Object.keys(body).some((key) => !["message", "current_code", "attempt_id"].includes(key)) ||
    !validText(body.message) || !body.message.trim() || !(body.current_code === null || validText(body.current_code)) ||
    !(body.attempt_id === undefined || body.attempt_id === null || (typeof body.attempt_id === "string" && uuidPattern.test(body.attempt_id)))) {
    throw new ChatError(422, "INVALID_REQUEST", "Send a nonempty message, current_code (string or null), and optional attempt_id UUID")
  }
  if (Buffer.byteLength(body.message, "utf8") > maxMessageBytes ||
    (body.current_code !== null && Buffer.byteLength(body.current_code, "utf8") > maxSourceBytes)) {
    throw new ChatError(413, "INVALID_REQUEST", "Message must be at most 8 KiB and current_code at most 64 KiB")
  }
  return { message: body.message, current_code: body.current_code, attempt_id: typeof body.attempt_id === "string" ? body.attempt_id.toLowerCase() : null }
}
export function chatErrorResponse(error: unknown) {
  if (error instanceof ChatError) return Response.json({ error: error.message, code: error.code }, {
    status: error.status, headers: { ...privateHeaders, ...(error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {}) },
  })
  console.error("Chat storage operation failed")
  return Response.json({ error: "Unable to save or retrieve chat. Retry the same request.", code: "CHAT_STORAGE_FAILED" }, { status: 500, headers: privateHeaders })
}
export function pageParameters(req: Request) {
  const params = new URL(req.url).searchParams
  const after = params.get("after") ?? "0"
  const limit = params.get("limit") ?? "20"
  if (!/^\d+$/.test(after) || !/^\d+$/.test(limit) || !Number.isSafeInteger(Number(after)) || Number(after) > 2147483647 || Number(limit) < 1 || Number(limit) > 50) {
    throw new ChatError(400, "INVALID_PAGE", "Use after >= 0 and a limit from 1 to 50")
  }
  return { after: Number(after), limit: Number(limit) }
}
