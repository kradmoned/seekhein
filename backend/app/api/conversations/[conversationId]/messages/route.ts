import { requireUser } from "../../../../../lib/auth"
import { listMessages, sendChatMessage } from "../../../../../lib/chat"
import { chatErrorResponse, chatId, messageKey, pageParameters, readChatInput } from "../../../../../lib/chat-request"
import { privateHeaders } from "../../../../../lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60
type Context = { params: Promise<{ conversationId: string }> }

export async function POST(req: Request, { params }: Context) {
  const { user, error } = await requireUser(req, "student")
  if (error) return error
  try {
    const id = chatId((await params).conversationId)
    const key = messageKey(req)
    const input = await readChatInput(req)
    return Response.json(await sendChatMessage(id, user.id, key, input), { headers: privateHeaders })
  } catch (error) { return chatErrorResponse(error) }
}
export async function GET(req: Request, { params }: Context) {
  const { user, error } = await requireUser(req, "student")
  if (error) return error
  try {
    const { after, limit } = pageParameters(req)
    return Response.json(await listMessages(chatId((await params).conversationId), user.id, after, limit), { headers: privateHeaders })
  } catch (error) { return chatErrorResponse(error) }
}
