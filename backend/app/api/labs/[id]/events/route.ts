import { requireUser } from "../../../../../lib/auth"
import { courseAccessSql } from "../../../../../lib/courses"
import { pool } from "../../../../../lib/db"
import { errorResponse, HttpError, privateHeaders, uuidPattern } from "../../../../../lib/http"
import { integrityPolicy } from "../../../../../lib/integrity"
import { validateEvents } from "../../../../../lib/integrity-events"
import { BodyTooLargeError, readJsonBody } from "../../../../../lib/json"

export const runtime = "nodejs"

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser(req, "student")
  if (error) return error
  try {
    const { id } = await params
    if (!uuidPattern.test(id)) throw new HttpError(400, "Invalid lab ID")
    if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      throw new HttpError(415, "Send the request as application/json")
    }
    let body: unknown
    try {
      body = await readJsonBody(req, integrityPolicy.max_batch_bytes)
    } catch (error) {
      throw new HttpError(400, error instanceof BodyTooLargeError ? "Event batch exceeds 64 KiB" : "Invalid JSON request body")
    }
    const events = validateEvents(body)
    // One statement checks access and inserts the entire batch. Retry conflicts
    // leave the original event, payload and receipt time intact.
    const result = await pool.query<{ allowed: boolean }>(
      `WITH accessible_lab AS (
         SELECT l.id FROM public.labs l JOIN public.courses c ON c.id = l.course_id
         WHERE ${courseAccessSql} AND l.id = $3
       ), inserted AS (
         INSERT INTO public.integrity_events
           (lab_id, student_id, event_id, session_id, type, payload, client_ts)
         SELECT l.id, $1, (e.item->>'event_id')::uuid, (e.item->>'session_id')::uuid,
           e.item->>'type', e.item->'payload', (e.item->>'client_ts')::timestamptz
         FROM accessible_lab l CROSS JOIN jsonb_array_elements($4::jsonb)
           WITH ORDINALITY AS e(item, position)
         ORDER BY e.position
         ON CONFLICT (lab_id, student_id, event_id) DO NOTHING
         RETURNING id
       )
       SELECT EXISTS (SELECT 1 FROM accessible_lab) AS allowed`,
      [user.id, user.role, id, JSON.stringify(events)],
    )
    if (!result.rows[0].allowed) throw new HttpError(404, "Lab not found")
    return new Response(null, { status: 204, headers: privateHeaders })
  } catch (error) {
    return errorResponse(error, "Unable to save integrity events")
  }
}
