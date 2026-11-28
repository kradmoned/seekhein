import { requireUser } from "../../../../../lib/auth"
import { createConversation, listConversations } from "../../../../../lib/chat"
import { chatErrorResponse, chatId, pageParameters } from "../../../../../lib/chat-request"
import { privateHeaders } from "../../../../../lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
type Context = { params: Promise<{ id: string }> }

export async function POST(req: Request, { params }: Context) {
  const { user, error } = await requireUser(req, "student")
  if (error) return error
  try {
    const conversation = await createConversation(chatId((await params).id), user.id)
    return Response.json(conversation, { status: 201, headers: privateHeaders })
  } catch (error) { return chatErrorResponse(error) }
}
export async function GET(req: Request, { params }: Context) {
  const { user, error } = await requireUser(req, "student")
  if (error) return error
  try {
    const { after, limit } = pageParameters(req)
    return Response.json(await listConversations(chatId((await params).id), user.id, after, limit), { headers: privateHeaders })
  } catch (error) { return chatErrorResponse(error) }
}
