import { requireUser } from "../../../../../../../lib/auth"
import { recoverChatTurn } from "../../../../../../../lib/chat"
import { chatErrorResponse, chatId } from "../../../../../../../lib/chat-request"
import { privateHeaders } from "../../../../../../../lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60
export async function POST(req: Request, { params }: { params: Promise<{ conversationId: string; turnId: string }> }) {
  const { user, error } = await requireUser(req, "student")
  if (error) return error
  try {
    const { conversationId, turnId } = await params
    return Response.json(await recoverChatTurn(chatId(conversationId), user.id, chatId(turnId)), { headers: privateHeaders })
  } catch (error) { return chatErrorResponse(error) }
}
