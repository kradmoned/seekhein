export class BodyTooLargeError extends Error {}

// Bound memory use even when Content-Length is missing or incorrect.
export async function readJsonBody(
  message: Request | Response,
  maxBytes: number,
): Promise<unknown> {
  if (!message.body) throw new SyntaxError("Missing JSON body")

  const reader = message.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength

      if (size > maxBytes) {
        await reader.cancel()
        throw new BodyTooLargeError("JSON body is too large")
      }

      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks),
  )
  return JSON.parse(text)
}
