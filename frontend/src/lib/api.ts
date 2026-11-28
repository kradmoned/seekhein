import { supabase } from "@/lib/supabase"

export class ApiError extends Error {
  status: number
  messages: string[]
  code?: string
  retryAfter?: number
  details?: unknown
  constructor(status: number, messages: string[], code?: string, retryAfter?: number, details?: unknown) {
    super(messages.join("\n"))
    this.name = "ApiError"
    this.details = details
    this.status = status; this.messages = messages; this.code = code; this.retryAfter = retryAfter
  }
}

export async function api<T>(path: string, options: RequestInit = {}, expectedUserId?: string): Promise<T> {
  const { data, error } = await supabase.auth.getSession()
  const session = data.session
  if (error || !session) {
    window.dispatchEvent(new Event("session-required"))
    throw new ApiError(401, ["Please sign in again."])
  }
  if (expectedUserId && session.user.id !== expectedUserId) throw new DOMException("Account changed", "AbortError")
  const headers = new Headers(options.headers)
  headers.set("Authorization", `Bearer ${session.access_token}`)
  let response: Response
  try {
    response = await fetch(path, { cache: 'no-store', ...options, headers })
    // Retry the identical body and idempotency key once after refreshing auth.
    if (response.status === 401) {
      const current = await supabase.auth.getSession()
      if (current.data.session?.user.id !== session.user.id) throw new DOMException('Account changed', 'AbortError')
      const refreshed = await supabase.auth.refreshSession()
      if (!refreshed.error && refreshed.data.session?.user.id === session.user.id) {
        headers.set('Authorization', `Bearer ${refreshed.data.session.access_token}`)
        response = await fetch(path, { cache: 'no-store', ...options, headers })
      }
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error
    throw new ApiError(0, ["Unable to reach the backend. Check your connection and try again."])
  }
  const body = response.status === 204 ? undefined : await response.json().catch(() => null)
  if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError")
  const current = await supabase.auth.getSession()
  if (current.data.session?.user.id !== session.user.id) throw new DOMException("Account changed", "AbortError")
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("session-required"))
    let messages: string[] = []
    if (Array.isArray(body?.errors)) messages = body.errors.filter((message: unknown): message is string => typeof message === 'string' && !!message)
    if (!messages.length && typeof body?.error === 'string') messages = [body.error]
    if (!messages.length) messages = [`Request failed (HTTP ${response.status}).`]
    const retry = response.headers.get('Retry-After')
    const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? Math.max(0, (Date.parse(retry) - Date.now()) / 1000) : undefined
    throw new ApiError(response.status, messages, typeof body?.code === 'string' ? body.code : undefined, Number.isFinite(seconds) ? seconds : undefined, body)
  }
  if (body === null) throw new ApiError(502, ["The backend returned an invalid response."])
  return body as T
}
