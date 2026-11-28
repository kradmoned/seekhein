import { HttpError, uuidPattern } from "./http"
import { eventTypes, integrityPolicy, type EventType } from "./integrity"

type InputEvent = {
  event_id: string
  session_id: string
  type: EventType
  payload: { chars?: number | null }
  client_ts: string | null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function validateEvents(body: unknown): InputEvent[] {
  if (!Array.isArray(body) || body.length > integrityPolicy.max_batch_items) {
    throw new HttpError(400, "Send an array of at most 100 events")
  }
  const events: InputEvent[] = []
  for (const item of body) {
    if (!isObject(item) || typeof item.type !== "string") {
      throw new HttpError(400, "Each event must be an object with a type")
    }
    // Unknown event types are deliberately ignored for forward compatibility.
    if (!eventTypes.includes(item.type as EventType)) continue
    if (
      typeof item.event_id !== "string" || !uuidPattern.test(item.event_id) ||
      typeof item.session_id !== "string" || !uuidPattern.test(item.session_id) ||
      Object.keys(item).some((key) => !["event_id", "session_id", "type", "payload", "ts"].includes(key))
    ) throw new HttpError(400, "Events require UUID event_id and session_id and only documented fields")

    const payload = item.payload ?? {}
    if (!isObject(payload)) throw new HttpError(400, "Event payload must be an object")
    const hasChars = item.type === "paste_blocked" || item.type === "large_insert"
    if (Object.keys(payload).some((key) => !hasChars || key !== "chars")) {
      throw new HttpError(400, "Unsupported event payload fields")
    }
    const chars = payload.chars ?? null
    if (hasChars && chars !== null && (typeof chars !== "number" || !Number.isSafeInteger(chars) || chars < 0 || chars > 10_000_000)) {
      throw new HttpError(400, "chars must be an integer from 0 to 10000000, or null")
    }
    if (item.type === "large_insert" && (typeof chars !== "number" || chars <= integrityPolicy.large_insert_threshold)) {
      throw new HttpError(400, "large_insert requires chars greater than 80")
    }
    let clientTs: string | null = null
    if (item.ts !== undefined && item.ts !== null) {
      if (typeof item.ts !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.ts)) {
        throw new HttpError(400, "ts must be a UTC ISO timestamp or null")
      }
      const parsed = new Date(item.ts)
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== item.ts) {
        throw new HttpError(400, "Invalid event timestamp")
      }
      clientTs = item.ts
    }
    events.push({
      event_id: item.event_id, session_id: item.session_id, type: item.type as EventType,
      payload: hasChars ? { chars: chars as number | null } : {}, client_ts: clientTs,
    })
  }
  return events
}
