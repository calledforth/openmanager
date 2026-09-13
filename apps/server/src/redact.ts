/**
 * Strip provider keys and raw client credentials from structured logs and
 * audit records (threat model D10). Comparison is on names and on well-known
 * secret shapes; a value that is only a hash or a UUID is left alone.
 */
const SECRET_KEY =
  /^(authorization|token|credential|password|secret|apikey|api[_-]?key|bearer|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?token)$/i
const EMBEDDED_SECRET =
  /omc1\.[A-Za-z0-9_-]{20,}|Bearer\s+\S+|sk-(?:ant-)?[A-Za-z0-9_-]{8,}/g

export const REDACTED = '[redacted]'

function redactString(value: string): string {
  return value.replaceAll(EMBEDDED_SECRET, REDACTED)
}

/** Return a copy of `value` with secrets replaced by `[redacted]`. */
export function redactSecrets<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as T
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item)) as T
  if (value !== null && typeof value === 'object') {
    const redacted: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      redacted[key] = SECRET_KEY.test(key) ? REDACTED : redactSecrets(entry)
    }
    return redacted as T
  }
  return value
}

/** True when a serialized record still contains a credential or provider key. */
export function containsSecret(value: unknown): boolean {
  if (value === undefined || value === null) return false
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return /omc1\.[A-Za-z0-9_-]{20,}|Bearer\s+\S+|sk-(?:ant-)?[A-Za-z0-9_-]{8,}/.test(text)
}
