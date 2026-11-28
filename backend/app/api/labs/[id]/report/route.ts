import { requireUser } from "../../../../../lib/auth"
import { errorResponse, HttpError, privateHeaders, uuidPattern } from "../../../../../lib/http"
import { readLabReport } from "../../../../../lib/lab-report"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser(req, "teacher")
  if (error) return error
  try {
    const { id } = await params
    if (!uuidPattern.test(id)) throw new HttpError(400, "Invalid lab ID")
    return Response.json(await readLabReport(id, user.id), { headers: privateHeaders })
  } catch (error) {
    return errorResponse(error, "Unable to fetch lab report")
  }
}
