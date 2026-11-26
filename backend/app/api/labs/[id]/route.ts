import { requireUser } from "../../../../lib/auth"
import { pool } from "../../../../lib/db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Lab = {
  id: string
  title: string
  instructions: string
  starter: string
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { error } = await requireUser(req)
  if (error) return error

  const { id } = await params
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  if (!uuidPattern.test(id)) {
    return Response.json(
      { error: "Invalid lab ID" },
      { status: 400 },
    )
  }

  try {
    const result = await pool.query<Lab>(
      `SELECT id, title, instructions, starter
       FROM public.labs
       WHERE id = $1`,
      [id],
    )

    const lab = result.rows[0]

    if (!lab) {
      return Response.json(
        { error: "Lab not found" },
        { status: 404 },
      )
    }

    return Response.json(
      {
        id: lab.id,
        title: lab.title,
        instructions: lab.instructions,
        starter: lab.starter,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    )
  } catch (error) {
    console.error(
      "Lab fetch failed:",
      error instanceof Error ? error.message : "Unknown error",
    )

    return Response.json(
      { error: "Unable to fetch lab" },
      { status: 500 },
    )
  }
}
