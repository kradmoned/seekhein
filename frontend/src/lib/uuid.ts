/** UUID v4, including on LAN HTTP where randomUUID is unavailable. */
export function randomUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  // getRandomValues is available outside secure contexts. Never use Math.random
  // for submission keys or telemetry identities.
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw Error('This browser cannot generate secure request IDs. Use a current browser.')
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
