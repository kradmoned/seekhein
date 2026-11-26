export const integrityPolicy = {
  version: "2026-11-27",
  block_paste: true,
  block_drop: true,
  block_large_insert: true,
  large_insert_threshold: 80,
  flush_interval_ms: 5000,
  max_batch_items: 100,
  max_batch_bytes: 65536,
  paste_penalty: 10,
  paste_cap: 40,
  large_insert_penalty: 15,
  large_insert_cap: 30,
  focus_grace: 3,
  focus_penalty: 5,
  focus_cap: 20,
  fast_pass_seconds: 60,
  fast_pass_penalty: 20,
} as const

export const eventTypes = [
  "lab_opened", "paste_blocked", "large_insert", "tab_hidden",
  "tab_visible", "window_blur", "window_focus", "run", "chat_sent",
] as const
export type EventType = typeof eventTypes[number]

export type IntegrityEvent = {
  event_id: string
  session_id: string
  type: EventType
  payload: { chars?: number | null }
  client_ts: string | null
  received_at: string
}

type Flag = { type: string; evidence: string; at: string; penalty: number }

// The caller supplies events in received_at / database ID order. Client
// timestamps never determine scoring. This function has no I/O or clock reads.
export function scoreIntegrity(events: readonly IntegrityEvent[], firstPassAt: string | null) {
  const flags: Flag[] = []
  const penalties = { paste: 0, large_insert: 0, focus: 0, fast_pass: 0 }
  const sessions = new Map<string, { hidden: boolean; blurred: boolean }>()
  const seen = new Set<string>()
  let focusLosses = 0
  let firstOpened: string | null = null

  for (const event of events) {
    if (seen.has(event.event_id)) continue
    seen.add(event.event_id)
    if (event.type === "lab_opened" && firstOpened === null) firstOpened = event.received_at

    if (event.type === "paste_blocked") {
      const penalty = Math.min(integrityPolicy.paste_penalty, integrityPolicy.paste_cap - penalties.paste)
      penalties.paste += penalty
      flags.push({
        type: "paste_blocked",
        evidence: typeof event.payload.chars === "number"
          ? `Blocked paste or drop attempt involving ${event.payload.chars} characters`
          : "Blocked paste or drop attempt; character count unavailable",
        at: event.received_at, penalty,
      })
    }
    if (event.type === "large_insert") {
      const penalty = Math.min(integrityPolicy.large_insert_penalty, integrityPolicy.large_insert_cap - penalties.large_insert)
      penalties.large_insert += penalty
      flags.push({ type: "large_insert", evidence: `Blocked an editor change inserting ${event.payload.chars} characters`, at: event.received_at, penalty })
    }

    const state = sessions.get(event.session_id) ?? { hidden: false, blurred: false }
    const wasAway = state.hidden || state.blurred
    switch (event.type) {
      case "tab_hidden": state.hidden = true; break
      case "tab_visible": state.hidden = false; break
      case "window_blur": state.blurred = true; break
      case "window_focus": state.blurred = false; break
    }
    sessions.set(event.session_id, state)
    if (!wasAway && (state.hidden || state.blurred)) {
      focusLosses++
      const penalty = focusLosses > integrityPolicy.focus_grace
        ? Math.min(integrityPolicy.focus_penalty, integrityPolicy.focus_cap - penalties.focus)
        : 0
      penalties.focus += penalty
      flags.push({ type: "focus_loss", evidence: `Lab lost visibility or window focus (${focusLosses} recorded departures)`, at: event.received_at, penalty })
    }
  }

  if (firstOpened && firstPassAt) {
    const elapsed = Date.parse(firstPassAt) - Date.parse(firstOpened)
    if (elapsed >= 0 && elapsed < integrityPolicy.fast_pass_seconds * 1000) {
      penalties.fast_pass = integrityPolicy.fast_pass_penalty
      flags.push({ type: "fast_pass", evidence: `All tests passed ${Math.floor(elapsed / 1000)}s after the first lab-open event was received`, at: firstPassAt, penalty: penalties.fast_pass })
    }
  }
  flags.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const penalty = Object.values(penalties).reduce((sum, value) => sum + value, 0)
  const score = Math.max(0, 100 - penalty)
  return {
    score,
    penalty: 100 - score,
    penalties,
    badge: score >= 80 ? "green" : score >= 50 ? "amber" : "red",
    flags,
    focus_losses: focusLosses,
    telemetry_status: firstOpened ? "recorded" : events.length ? "missing_lab_opened" : "missing",
  }
}
