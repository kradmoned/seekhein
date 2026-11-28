import { randomUuid } from './uuid.ts'
import { api, ApiError } from './api'
import type { Emit, IntegrityEvent, IntegrityPolicy } from './integrity'

// One storage entry per event prevents tabs from overwriting each other's queues.
export function createTelemetry(userId: string, labId: string, policy: IntegrityPolicy, notify: (message: string) => void) {
  const prefix = `lab-telemetry:${userId}:${labId}:`
  const sessionId = randomUuid()
  const memory = new Map<string, IntegrityEvent>()
  let active = true, stopped = false, failures = 0, retryAt = 0
  let inFlight: Promise<void> | null = null
  function message(value: string) { if (active) notify(value) }
  const emit: Emit = (type, payload = {}) => {
    if (stopped) return
    const event: IntegrityEvent = { event_id: randomUuid(), session_id: sessionId, type, payload, ts: new Date().toISOString() }
    memory.set(event.event_id, event)
    try { localStorage.setItem(prefix + event.event_id, JSON.stringify(event)) } catch { message('Activity cannot be saved in this browser. Keep this page open while delivery is retried.') }
  }
  function queued() {
    const events = new Map(memory)
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (!key?.startsWith(prefix)) continue
        const event = JSON.parse(localStorage.getItem(key) || 'null') as IntegrityEvent
        if (!event || key !== prefix + event.event_id || typeof event.ts !== 'string' || typeof event.session_id !== 'string') throw Error('Invalid saved activity')
        events.set(event.event_id, event)
      }
    } catch { message('Some saved activity could not be read. Keep browser data and contact your teacher.') }
    // Stable sorting preserves callback order for equal timestamps.
    return [...events.values()].sort((a, b) => a.ts.localeCompare(b.ts))
  }
  function flush(departure = false): Promise<void> {
    if (inFlight) return inFlight
    if (stopped || Date.now() < retryAt) return Promise.resolve()
    const batch = queued().slice(0, Math.min(100, policy.max_batch_items))
    const ceiling = Math.min(policy.max_batch_bytes, departure ? 60 * 1024 : 65_536)
    while (batch.length && new TextEncoder().encode(JSON.stringify(batch)).length > ceiling) batch.pop()
    if (!batch.length) return Promise.resolve()
    inFlight = (async () => {
      const controller = new AbortController()
      const timeout = window.setTimeout(() => controller.abort(), 5000)
      try {
        await api<void>(`/api/labs/${encodeURIComponent(labId)}/events`, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch), keepalive: departure }, userId)
        for (const event of batch) { localStorage.removeItem(prefix + event.event_id); memory.delete(event.event_id) }
        failures = 0; retryAt = 0
        message(queued().length ? 'Activity delivery pending.' : '')
      } catch (error) {
        failures++
        retryAt = Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(failures - 1, 5))
        if (error instanceof ApiError && [400, 403, 404, 415].includes(error.status)) stopped = true
        message(stopped ? 'Activity delivery stopped. Refresh access or contact your teacher; saved events are retained.' : 'Activity delivery pending. It will retry automatically; keep this page open when possible.')
      } finally { clearTimeout(timeout); inFlight = null }
    })()
    return inFlight
  }
  const visibility = () => { emit(document.hidden ? 'tab_hidden' : 'tab_visible'); if (document.hidden) void flush(true) }
  const blur = () => emit('window_blur')
  const focus = () => emit('window_focus')
  const departure = () => { void flush(true) }
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('blur', blur); window.addEventListener('focus', focus); window.addEventListener('pagehide', departure)
  emit('lab_opened')
  if (document.hidden) emit('tab_hidden')
  if (!document.hasFocus()) emit('window_blur')
  void flush()
  const timer = window.setInterval(() => { void flush() }, Math.max(1000, policy.flush_interval_ms))
  return { emit, flush, dispose() {
    active = false
    clearInterval(timer); document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('blur', blur); window.removeEventListener('focus', focus); window.removeEventListener('pagehide', departure)
    void flush(true)
  } }
}
