import { HttpError } from "./http"
import { readJsonBody } from "./json"

export type TutorContext = {
  conversation_id: string
  message: string
  recent_messages: Array<{ role: "user" | "assistant"; content: string }>
  current_code: string | null
  executed_code: string | null
  output_error: Record<string, unknown> | null
  validation_feedback: Record<string, unknown> | null
}
export type TutorAnswer = { answer: string; sources: unknown[] }
export class ChatError extends HttpError {
  constructor(status: number, public code: string, message: string, public retryAfter?: number, public upstreamStatus?: number) {
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
    // Optional gateway authentication. Leave unset if the deployed tutor has none.
    if (process.env.TUTOR_API_TOKEN) headers.Authorization = `Bearer ${process.env.TUTOR_API_TOKEN}`
    return { url: new URL("/api/v1/tutor", url), headers }
  } catch {
    throw new ChatError(503, "TUTOR_NOT_CONFIGURED", "The lab assistant is not configured")
  }
}
export async function askTutor(context: TutorContext): Promise<TutorAnswer> {
  const { url, headers } = tutorConfiguration()
  const body = JSON.stringify(context)
  if (Buffer.byteLength(body, "utf8") > 2 * 1024 * 1024) throw new ChatError(413, "TUTOR_CONTEXT_TOO_LARGE", "The assistant context is too large")
  const signal = AbortSignal.timeout(tutorTimeoutMs)
  try {
    const response = await fetch(url, { method: "POST", headers, body, signal, cache: "no-store", redirect: "error" })
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 429) throw new ChatError(429, "TUTOR_BUSY", "The assistant is busy. Retry shortly.", 10, response.status)
      if (response.status === 503) throw new ChatError(503, "TUTOR_UNAVAILABLE", "The assistant is unavailable", undefined, response.status)
      throw new ChatError(502, "TUTOR_REQUEST_FAILED", "The assistant could not process the request", undefined, response.status)
    }
    const data = await readJsonBody(response, 256 * 1024)
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error()
    const result = data as Record<string, unknown>
    if (result.status !== "success" || result.conversation_id !== context.conversation_id ||
      !validText(result.answer) || !result.answer.trim() || Buffer.byteLength(result.answer, "utf8") > maxAnswerBytes ||
      !Array.isArray(result.sources)) throw new Error()
    return { answer: result.answer, sources: result.sources }
  } catch (error) {
    if (error instanceof ChatError) throw error
    if (signal.aborted) throw new ChatError(504, "TUTOR_TIMEOUT", "The assistant timed out. Retry this message.")
    throw new ChatError(502, "TUTOR_INVALID_RESPONSE", "Unable to get a valid answer from the assistant")
  }
}
