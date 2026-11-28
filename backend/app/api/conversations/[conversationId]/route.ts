import { requireUser } from "../../../../lib/auth"
import { deleteConversation } from "../../../../lib/chat"
import { chatErrorResponse, chatId } from "../../../../lib/chat-request"
import { privateHeaders } from "../../../../lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60
export async function DELETE(req: Request, { params }: { params: Promise<{ conversationId: string }> }) {
  const { user, error } = await requireUser(req, "student")
  if (error) return error
  try {
    return Response.json(await deleteConversation(chatId((await params).conversationId), user.id), { headers: privateHeaders })
  } catch (error) { return chatErrorResponse(error) }
}
