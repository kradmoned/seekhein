import { HttpError } from "./http"
import { readJsonBody } from "./json"

export type LabContext = { title: string | null; instructions: string | null; starter: string | null; tests: string | null; solution: string | null }
export type TutorContext = {
  conversation_id: string
  message: string
  lab_context?: LabContext
  current_code: string | null
  executed_code: string | null
  output_error: Record<string, unknown> | null
  validation_feedback: Record<string, unknown> | null
}
export type TutorAnswer = { answer: string; sources: unknown[] }
export class ChatError extends HttpError {
  constructor(status: number, public code: string, message: string, public retryAfter?: number, public upstreamStatus?: number, public outcomeUnknown = false) {
    super(status, message)
  }
}
export const tutorTimeoutMs = 45_000
export const chatLeaseSeconds = 120
export const maxMessageBytes = 8 * 1024
export const maxAnswerBytes = 32 * 1024

export function validText(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && Buffer.from(value, "utf8").toString("utf8") === value
}
export function tutorConfiguration() {
  try {
    const url = new URL(process.env.TUTOR_API_URL ?? "")
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error()
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (process.env.TUTOR_API_TOKEN) headers.Authorization = `Bearer ${process.env.TUTOR_API_TOKEN}`
    return { url, headers }
  } catch {
    throw new ChatError(503, "TUTOR_NOT_CONFIGURED", "The lab assistant is not configured")
  }
}
async function tutorRequest(path: string, method: "POST" | "DELETE", body?: string, turnId?: string) {
  const { url, headers } = tutorConfiguration()
  if (turnId) headers["Idempotency-Key"] = turnId
  const signal = AbortSignal.timeout(tutorTimeoutMs)
  try {
    const response = await fetch(new URL(path, url), { method, headers, body, signal, cache: "no-store", redirect: "error" })
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 401 || response.status === 403) throw new ChatError(503, "TUTOR_AUTH_FAILED", "The assistant service credentials need attention", undefined, response.status)
      if (response.status === 429) throw new ChatError(429, "TUTOR_BUSY", "The assistant is busy. Retry shortly.", 10, response.status)
      if (response.status === 503) throw new ChatError(503, "TUTOR_UNAVAILABLE", "The assistant is unavailable", undefined, response.status)
      // The contract guarantees no saved turn for these application failures.
      const knownFailure = [400, 422, 500].includes(response.status)
      throw new ChatError(502, "TUTOR_REQUEST_FAILED", "The assistant could not process the request", undefined, response.status, !knownFailure)
    }
    return await readJsonBody(response, 256 * 1024)
  } catch (error) {
    if (error instanceof ChatError) throw error
    if (signal.aborted) throw new ChatError(504, "TUTOR_TIMEOUT", "The assistant timed out. Recover this turn before continuing.", undefined, undefined, true)
    throw new ChatError(502, "TUTOR_INVALID_RESPONSE", "Unable to get a valid response from the assistant", undefined, undefined, true)
  }
}
function invalidReply(): never {
  throw new ChatError(502, "TUTOR_INVALID_RESPONSE", "Unable to get a valid response from the assistant", undefined, undefined, true)
}
export async function askTutor(context: TutorContext, turnId: string): Promise<TutorAnswer> {
  const body = JSON.stringify(context)
  if (Buffer.byteLength(body, "utf8") > 2 * 1024 * 1024) throw new ChatError(413, "TUTOR_CONTEXT_TOO_LARGE", "The assistant context is too large")
  const data = await tutorRequest("/api/v1/tutor", "POST", body, turnId)
  if (!data || typeof data !== "object" || Array.isArray(data)) return invalidReply()
  const result = data as Record<string, unknown>
  if (result.status !== "success" || result.conversation_id !== context.conversation_id ||
    !validText(result.answer) || !result.answer.trim() || Buffer.byteLength(result.answer, "utf8") > maxAnswerBytes ||
    !Array.isArray(result.sources)) return invalidReply()
  return { answer: result.answer, sources: result.sources }
}
export async function deleteTutorSession(conversationId: string): Promise<void> {
  const data = await tutorRequest(`/api/v1/sessions/${encodeURIComponent(conversationId)}`, "DELETE")
  if (!data || typeof data !== "object" || Array.isArray(data)) return invalidReply()
  const result = data as Record<string, unknown>
  if (result.status !== "success" || result.conversation_id !== conversationId || typeof result.deleted !== "boolean") return invalidReply()
}
