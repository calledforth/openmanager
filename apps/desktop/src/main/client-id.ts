import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

const CLIENT_ID_FILE = 'client-id.json'

interface ClientIdRecord {
  clientId: string
}

export function loadOrCreateClientId(userDataPath: string): string {
  const filePath = join(userDataPath, CLIENT_ID_FILE)

  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<ClientIdRecord>
    if (typeof parsed.clientId === 'string' && parsed.clientId.length > 0) {
      return parsed.clientId
    }
  } catch {
    // Fall through and create a new stable client id.
  }

  const clientId = randomUUID()
  mkdirSync(userDataPath, { recursive: true })
  writeFileSync(filePath, JSON.stringify({ clientId }, null, 2), 'utf8')
  return clientId
}
