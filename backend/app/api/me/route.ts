import { requireUser } from "../../../lib/auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const { user, error } = await requireUser(req)
  if (error) return error

  return Response.json(
    {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
    },
    {
      headers: {
        "Cache-Control": "private, no-store",
      },
    },
  )
}