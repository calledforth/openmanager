import { BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

type TelemetrySource = 'main' | 'renderer'
type TelemetryKind = 'query' | 'mutation' | 'subscription' | 'trace'
type TelemetryPhase = 'start' | 'success' | 'error' | 'subscribe' | 'update' | 'unsubscribe' | 'mark'

export interface ConvexTelemetryEvent {
  id: string
  timestamp: number
  source: TelemetrySource
  kind: TelemetryKind
  phase: TelemetryPhase
  name: string
  durationMs?: number
  requestBytes?: number
  responseBytes?: number
  sessionExternalId?: string
  workspacePath?: string
  messageExternalId?: string
  traceId?: string
  details?: string
}

interface TelemetryState {
  filePath: string
  events: ConvexTelemetryEvent[]
  flushTimer: ReturnType<typeof setTimeout> | null
}

const MAX_EVENTS = 5000
const TELEMETRY_FILE = 'convex-telemetry-log.json'

let state: TelemetryState | null = null

function ensureState(): TelemetryState {
  if (!state) {
    throw new Error('Convex telemetry has not been initialized')
  }
  return state
}

function flushSoon(): void {
  const current = ensureState()
  if (current.flushTimer) return
  current.flushTimer = setTimeout(() => {
    current.flushTimer = null
    writeFileSync(
      current.filePath,
      JSON.stringify(
        {
          updatedAt: Date.now(),
          events: current.events,
        },
        null,
        2,
      ),
      'utf8',
    )
  }, 200)
}

export function initConvexTelemetry(userDataPath: string): void {
  mkdirSync(userDataPath, { recursive: true })
  const filePath = join(userDataPath, TELEMETRY_FILE)
  let events: ConvexTelemetryEvent[] = []

  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as { events?: ConvexTelemetryEvent[] }
    if (Array.isArray(parsed.events)) {
      events = parsed.events.slice(-MAX_EVENTS)
    }
  } catch {
    // No existing telemetry file yet.
  }

  state = {
    filePath,
    events,
    flushTimer: null,
  }
}

export function estimateConvexPayloadBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value ?? null)).length
  } catch {
    return 0
  }
}

export function extractConvexTelemetryContext(args: unknown): Partial<ConvexTelemetryEvent> {
  if (!args || typeof args !== 'object') return {}
  const record = args as Record<string, unknown>
  const context: Partial<ConvexTelemetryEvent> = {}

  if (typeof record.sessionExternalId === 'string') {
    context.sessionExternalId = record.sessionExternalId
  }
  if (typeof record.workspacePath === 'string') {
    context.workspacePath = record.workspacePath
  }
  if (typeof record.messageExternalId === 'string') {
    context.messageExternalId = record.messageExternalId
  } else if (typeof record.externalId === 'string' && !record.externalId.startsWith('perm_')) {
    context.messageExternalId = record.externalId
  }

  if (typeof record.payload === 'string') {
    try {
      const parsed = JSON.parse(record.payload) as Record<string, unknown>
      if (!context.sessionExternalId && typeof parsed.sessionExternalId === 'string') {
        context.sessionExternalId = parsed.sessionExternalId
      }
      if (!context.workspacePath && typeof parsed.workspacePath === 'string') {
        context.workspacePath = parsed.workspacePath
      }
    } catch {
      // Ignore payload parse failure.
    }
  }

  return context
}

export function recordConvexTelemetry(
  event: Omit<ConvexTelemetryEvent, 'id' | 'timestamp'>,
): ConvexTelemetryEvent {
  const current = ensureState()
  const next: ConvexTelemetryEvent = {
    id: randomUUID(),
    timestamp: Date.now(),
    ...event,
  }
  current.events.push(next)
  if (current.events.length > MAX_EVENTS) {
    current.events = current.events.slice(-MAX_EVENTS)
  }
  flushSoon()

  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('telemetry:update', next)
  }

  return next
}

export function getConvexTelemetrySnapshot() {
  const current = ensureState()
  return {
    filePath: current.filePath,
    events: current.events,
  }
}

export function clearConvexTelemetry(): void {
  const current = ensureState()
  current.events = []
  flushSoon()
}
