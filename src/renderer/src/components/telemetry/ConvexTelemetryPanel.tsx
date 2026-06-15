import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useAppUi } from '../../providers/app-ui-provider'

/** App-wide stacks from globals.css (self-hosted; CSP-safe). */
const fontMono =
  'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
const fontSans = 'var(--font-sans), ui-sans-serif, system-ui, sans-serif'

// ---------------------------------------------------------------------------
// Keyframe injection (no remote fonts)
// ---------------------------------------------------------------------------
const STYLE_ID = 'convex-telemetry-global-styles'
function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = `
    @keyframes ctLeftBorderPulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.15; }
    }
    @keyframes ctStatusPulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%      { opacity: 0.35; transform: scale(0.75); }
    }
    @keyframes ctFadeSlide {
      from { opacity: 0; transform: translateX(6px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    .ct-row:hover { background: var(--basis-surface-hover) !important; }
    .ct-btn:hover { border-color: var(--basis-border) !important; color: var(--basis-text) !important; }
    .ct-btn:active { transform: translateY(0.5px); }
    .ct-softFocus:focus-visible { outline: 2px solid color-mix(in srgb, var(--basis-text-muted) 45%, transparent); outline-offset: 2px; }
    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-track { background: var(--basis-canvas-bg); }
    ::-webkit-scrollbar-thumb { background: var(--basis-scrollbar-thumb); border-radius: 2px; }
  `
  document.head.appendChild(el)
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------
interface TelemetryEvent {
  id: string
  timestamp: number
  source: 'main' | 'renderer'
  kind: 'query' | 'mutation' | 'subscription' | 'trace'
  phase: 'start' | 'success' | 'error' | 'subscribe' | 'update' | 'unsubscribe' | 'mark'
  name: string
  durationMs?: number
  requestBytes?: number
  responseBytes?: number
  sessionExternalId?: string
  workspacePath?: string
  messageExternalId?: string
  details?: string
}

interface MergedEntry {
  key: string
  type: 'mutation' | 'query' | 'subscription' | 'mark'
  status: 'pending' | 'success' | 'error' | 'active' | 'done'
  name: string
  updateCount: number
  durationMs?: number
  requestBytes?: number
  responseBytes?: number
  sessionExternalId?: string
  messageExternalId?: string
  timestamp: number
  details?: string
  rawEvents: TelemetryEvent[]
}

// ---------------------------------------------------------------------------
// Color palette
// ---------------------------------------------------------------------------
const C = {
  bg: 'var(--basis-canvas-bg)',
  bg2: 'var(--basis-surface)',
  bg3: 'var(--basis-surface-elevated)',
  border: 'var(--basis-border-muted)',
  border2: 'var(--basis-border)',
  text: 'var(--basis-text)',
  muted: 'var(--basis-text-muted)',
  dim: 'var(--basis-text-faint)',
  success: '#22c55e',
  error: '#ef4444',
  pending: '#3b82f6',
  active: '#a855f7',
  marker: '#f59e0b',
  mutation: '#3b82f6',
  query: '#22c55e',
  subscription: '#a855f7',
}

const TYPE_COLOR: Record<MergedEntry['type'], string> = {
  mutation: C.mutation,
  query: C.query,
  subscription: C.subscription,
  mark: C.marker,
}
const TYPE_LABEL: Record<MergedEntry['type'], string> = {
  mutation: 'MUT',
  query: 'QRY',
  subscription: 'SUB',
  mark: 'MARK',
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0B'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(2)}M`
}
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}
function formatAgeMs(now: number, timestamp: number): string {
  const age = Math.max(0, now - timestamp)
  if (age < 1000) return `+${age}ms`
  if (age < 60_000) return `+${(age / 1000).toFixed(1)}s`
  return `+${Math.round(age / 60_000)}m`
}

// ---------------------------------------------------------------------------
// Event-merging logic
// ---------------------------------------------------------------------------
function buildMergedEntries(events: TelemetryEvent[]): MergedEntry[] {
  const result: MergedEntry[] = []
  // Maps entry key → index in result (for in-place updates)
  const keyToIdx = new Map<string, number>()
  // FIFO queue: correlationKey → [entry.key, ...]
  const pendingQueue = new Map<string, string[]>()

  for (const ev of events) {
    // ── Mark: standalone horizontal divider ──────────────────────────────
    if (ev.phase === 'mark') {
      const entry: MergedEntry = {
        key: ev.id,
        type: 'mark',
        status: 'done',
        name: ev.name,
        updateCount: 0,
        timestamp: ev.timestamp,
        sessionExternalId: ev.sessionExternalId,
        messageExternalId: ev.messageExternalId,
        details: ev.details,
        rawEvents: [ev],
      }
      keyToIdx.set(ev.id, result.push(entry) - 1)
      continue
    }

    // ── Subscribe: open or re-activate a subscription entry ────────────
    if (ev.phase === 'subscribe') {
      const subKey = ev.details || ev.id
      if (keyToIdx.has(subKey)) {
        const existing = result[keyToIdx.get(subKey)!]
        existing.status = 'active'
        existing.name = ev.name
        existing.timestamp = ev.timestamp
        existing.updateCount = 0
        if (ev.requestBytes !== undefined) existing.requestBytes = ev.requestBytes
        existing.rawEvents.push(ev)
        continue
      }
      const entry: MergedEntry = {
        key: subKey,
        type: 'subscription',
        status: 'active',
        name: ev.name,
        updateCount: 0,
        timestamp: ev.timestamp,
        requestBytes: ev.requestBytes,
        sessionExternalId: ev.sessionExternalId,
        messageExternalId: ev.messageExternalId,
        details: ev.details,
        rawEvents: [ev],
      }
      keyToIdx.set(subKey, result.push(entry) - 1)
      continue
    }

    // ── Update: increment update count, refresh responseBytes ────────────
    if (ev.phase === 'update') {
      const subKey = ev.details ?? ''
      if (subKey && keyToIdx.has(subKey)) {
        const e = result[keyToIdx.get(subKey)!]
        e.updateCount++
        if (ev.responseBytes !== undefined) e.responseBytes = ev.responseBytes
        e.rawEvents.push(ev)
      }
      continue
    }

    // ── Unsubscribe: close the subscription entry ─────────────────────────
    if (ev.phase === 'unsubscribe') {
      const subKey = ev.details ?? ''
      if (subKey && keyToIdx.has(subKey)) {
        const e = result[keyToIdx.get(subKey)!]
        e.status = 'done'
        if (ev.durationMs !== undefined) e.durationMs = ev.durationMs
        e.rawEvents.push(ev)
      }
      continue
    }

    // ── Start: new mutation or one-off query ──────────────────────────────
    if (ev.phase === 'start') {
      const correlKey = `${ev.name}|${ev.sessionExternalId ?? ''}|${ev.messageExternalId ?? ''}`
      const entry: MergedEntry = {
        key: ev.id,
        type: ev.kind === 'mutation' ? 'mutation' : 'query',
        status: 'pending',
        name: ev.name,
        updateCount: 0,
        timestamp: ev.timestamp,
        requestBytes: ev.requestBytes,
        sessionExternalId: ev.sessionExternalId,
        messageExternalId: ev.messageExternalId,
        details: ev.details,
        rawEvents: [ev],
      }
      keyToIdx.set(ev.id, result.push(entry) - 1)
      const q = pendingQueue.get(correlKey) ?? []
      q.push(ev.id)
      pendingQueue.set(correlKey, q)
      continue
    }

    // ── Success / Error: resolve the oldest matching pending entry ────────
    if (ev.phase === 'success' || ev.phase === 'error') {
      const correlKey = `${ev.name}|${ev.sessionExternalId ?? ''}|${ev.messageExternalId ?? ''}`
      const q = pendingQueue.get(correlKey)
      if (q && q.length > 0) {
        const entryKey = q.shift()!
        if (keyToIdx.has(entryKey)) {
          const e = result[keyToIdx.get(entryKey)!]
          e.status = ev.phase === 'success' ? 'success' : 'error'
          if (ev.durationMs !== undefined) e.durationMs = ev.durationMs
          if (ev.responseBytes !== undefined) e.responseBytes = ev.responseBytes
          e.rawEvents.push(ev)
        }
      }
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function StatusDot({ status }: { status: MergedEntry['status'] }) {
  const color =
    status === 'success'
      ? C.success
      : status === 'error'
        ? C.error
        : status === 'pending'
          ? C.pending
          : status === 'active'
            ? C.active
            : C.dim
  const pulse = status === 'pending' || status === 'active'
  return (
    <span
      style={{
        display: 'inline-block',
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
        animation: pulse ? 'ctStatusPulse 1.6s ease-in-out infinite' : 'none',
      }}
    />
  )
}

function EntryRow({ entry }: { entry: MergedEntry }) {
  const isPulsing = entry.status === 'pending' || entry.status === 'active'
  const typeColor = TYPE_COLOR[entry.type]
  const leftColor =
    entry.status === 'success'
      ? C.success
      : entry.status === 'error'
        ? C.error
        : isPulsing
          ? typeColor
          : C.dim
  const now = Date.now()
  const ageMs = Math.max(0, now - entry.timestamp)

  // ── Mark: horizontal divider ──────────────────────────────────────────
  if (entry.type === 'mark') {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 0',
          animation: 'ctFadeSlide 0.18s ease-out',
        }}
      >
        <div style={{ flex: 1, height: 1, background: C.dim }} />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            background: C.bg2,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            padding: '4px 10px',
          }}
        >
          <span style={{ color: C.marker, fontSize: 10, lineHeight: 1 }}>◆</span>
          <span
            style={{
              color: C.marker,
              fontSize: 12,
              fontFamily: fontMono,
              letterSpacing: '0.04em',
            }}
          >
            {entry.name}
          </span>
          <span style={{ color: C.muted, fontSize: 11, fontFamily: fontMono }}>
            {formatTime(entry.timestamp)}
          </span>
        </div>
        <div style={{ flex: 1, height: 1, background: C.dim }} />
      </div>
    )
  }

  // ── Mutation / Query / Subscription: tight horizontal strip ───────────
  return (
    <div
      className="ct-row"
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '8px 10px 8px 14px',
        background: C.bg3,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        minHeight: 38,
        animation: 'ctFadeSlide 0.18s ease-out',
        overflow: 'hidden',
        transition: 'background 0.12s, border-color 0.12s',
      }}
    >
      {/* Left border indicator */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 2,
          background: leftColor,
          animation: isPulsing ? 'ctLeftBorderPulse 1.6s ease-in-out infinite' : 'none',
          borderRadius: '8px 0 0 8px',
        }}
      />

      {/* Status dot */}
      <StatusDot status={entry.status} />

      {/* Name */}
      <span
        style={{
          flex: 1,
          fontSize: 13,
          color: C.text,
          fontFamily: fontMono,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
          lineHeight: 1.25,
        }}
      >
        {entry.name}
      </span>

      {/* Update-count badge (subscriptions) */}
      {entry.type === 'subscription' && entry.updateCount > 0 && (
        <span
          style={{
            fontSize: 10,
            color: C.active,
            background: `${C.active}1a`,
            border: `1px solid ${C.active}40`,
            borderRadius: 6,
            padding: '2px 7px',
            fontFamily: fontMono,
            flexShrink: 0,
          }}
        >
          ×{entry.updateCount}
        </span>
      )}

      {/* Type chip */}
      <span
        style={{
          fontSize: 10,
          color: typeColor,
          background: `${typeColor}18`,
          border: `1px solid ${typeColor}38`,
          borderRadius: 6,
          padding: '2px 7px',
          fontFamily: fontMono,
          letterSpacing: '0.04em',
          flexShrink: 0,
        }}
      >
        {TYPE_LABEL[entry.type]}
      </span>

      {/* Metrics */}
      {(entry.durationMs !== undefined || entry.responseBytes !== undefined) && (
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {entry.durationMs !== undefined && (
            <span style={{ fontSize: 11, color: C.muted, fontFamily: fontMono }}>
              {formatDuration(entry.durationMs)}
            </span>
          )}
          {entry.responseBytes !== undefined && (
            <span style={{ fontSize: 11, color: C.muted, fontFamily: fontMono }}>
              {formatBytes(entry.responseBytes)}
            </span>
          )}
        </div>
      )}

      {/* Timestamp */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 2,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: C.muted,
            fontFamily: fontMono,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatTime(entry.timestamp)}
        </span>
        <span
          style={{
            fontSize: 10,
            color: ageMs > 1500 ? C.marker : C.dim,
            fontFamily: fontMono,
            fontVariantNumeric: 'tabular-nums',
          }}
          title="Time since event timestamp"
        >
          {formatAgeMs(now, entry.timestamp)}
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// KPI card
// ---------------------------------------------------------------------------
function KpiCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{ background: C.bg, padding: '8px 10px' }}>
      <div
        style={{
          fontSize: 9,
          color: C.muted,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          marginBottom: 5,
          fontFamily: fontMono,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 16,
          color: accent ?? C.text,
          fontFamily: fontMono,
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1,
        }}
      >
        {value}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------
export function ConvexTelemetryPanel() {
  const { activeSessionId } = useAppUi()
  const [open, setOpen] = useState(false)
  const [events, setEvents] = useState<TelemetryEvent[]>([])
  const [filePath, setFilePath] = useState('')
  const [showAllSessions, setShowAllSessions] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    injectStyles()
  }, [])

  useEffect(() => {
    window.electronAPI
      .getTelemetrySnapshot()
      .then((snapshot) => {
        setEvents(snapshot.events as TelemetryEvent[])
        setFilePath(snapshot.filePath)
      })
      .catch(() => undefined)

    return window.electronAPI.onTelemetryUpdate((event) => {
      setEvents((prev) => [...prev, event as TelemetryEvent].slice(-500))
    })
  }, [])

  // Build merged entries from all raw events
  const allMerged = useMemo(() => buildMergedEntries(events), [events])

  // Session-filtered slice for display (newest first)
  const displayed = useMemo(() => {
    const filtered =
      showAllSessions || !activeSessionId
        ? allMerged
        : allMerged.filter((e) => !e.sessionExternalId || e.sessionExternalId === activeSessionId)
    return filtered.slice(-100).reverse()
  }, [allMerged, showAllSessions, activeSessionId])

  // KPI stats over the same filtered set
  const kpi = useMemo(() => {
    const base =
      showAllSessions || !activeSessionId
        ? allMerged
        : allMerged.filter((e) => !e.sessionExternalId || e.sessionExternalId === activeSessionId)
    let mutations = 0,
      queries = 0,
      totalLatencyMs = 0,
      latencyCount = 0,
      totalOut = 0
    for (const e of base) {
      if (e.type === 'mutation') mutations++
      if (e.type === 'subscription' || e.type === 'query') queries++
      if (e.durationMs !== undefined && (e.type === 'mutation' || e.type === 'query')) {
        totalLatencyMs += e.durationMs
        latencyCount++
      }
      totalOut += e.responseBytes ?? 0
    }
    const avgLatency = latencyCount > 0 ? Math.round(totalLatencyMs / latencyCount) : 0
    return { mutations, queries, avgLatency, totalOut }
  }, [allMerged, showAllSessions, activeSessionId])

  // Shared button style helper
  const btnStyle = (active?: boolean): CSSProperties => ({
    background: active ? '#111' : C.bg2,
    color: active ? C.text : C.muted,
    border: `1px solid ${active ? '#222' : C.border}`,
    borderRadius: 7,
    padding: '6px 10px',
    fontSize: 10,
    cursor: 'pointer',
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    fontFamily: fontMono,
    transition: 'color 0.12s, border-color 0.12s',
  })

  return (
    <>
      {/* Toggle trigger */}
      <button
        type="button"
        className="ct-btn"
        onClick={() => setOpen((p) => !p)}
        style={{
          position: 'fixed',
          top: 12,
          right: 12,
          zIndex: 60,
          background: C.bg2,
          color: open ? C.text : C.muted,
          border: `1px solid ${open ? '#222' : C.border}`,
          borderRadius: 9,
          padding: '8px 12px',
          fontSize: 11,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          cursor: 'pointer',
          fontFamily: fontSans,
          transition: 'color 0.15s, border-color 0.15s, transform 0.08s',
        }}
      >
        ⬡ CONVEX
      </button>

      {/* Panel */}
      {open && (
        <div
          style={{
            position: 'fixed',
            top: 46,
            right: 12,
            bottom: 12,
            width: 520,
            background: `radial-gradient(1200px 500px at 100% 0%, rgba(59,130,246,0.08), transparent 55%),
                         radial-gradient(900px 450px at 30% 10%, rgba(168,85,247,0.08), transparent 55%),
                         ${C.bg}`,
            border: `1px solid #0e0e0e`,
            borderRadius: 12,
            zIndex: 55,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            boxShadow: '0 32px 80px rgba(0,0,0,0.9), inset 0 0 0 1px #111',
            fontFamily: fontMono,
          }}
        >
          {/* ── Header ────────────────────────────────────────────────────── */}
          <div
            style={{ padding: '14px 16px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}
          >
            {/* Title + controls row */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                marginBottom: 12,
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: 12,
                    color: C.text,
                    letterSpacing: '0.12em',
                    fontFamily: fontSans,
                  }}
                >
                  CONVEX TRACE
                </div>
                <div
                  style={{ fontSize: 11, color: C.muted, marginTop: 4, letterSpacing: '0.02em' }}
                >
                  {activeSessionId
                    ? `session · ${activeSessionId.slice(0, 16)}…`
                    : 'no active session'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 5 }}>
                <button
                  type="button"
                  className="ct-btn"
                  onClick={() => setShowAllSessions((p) => !p)}
                  style={btnStyle(showAllSessions)}
                >
                  {showAllSessions ? 'ALL' : 'ACTIVE'}
                </button>
                <button
                  type="button"
                  className="ct-btn"
                  onClick={() => {
                    window.electronAPI.clearTelemetry().catch(() => undefined)
                    setEvents([])
                  }}
                  style={btnStyle()}
                >
                  CLEAR
                </button>
              </div>
            </div>

            {/* KPI strip — tight grid with inner dividers */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 1,
                background: C.border,
                borderRadius: 4,
                overflow: 'hidden',
              }}
            >
              <KpiCard label="MUTATIONS" value={String(kpi.mutations)} accent={C.mutation} />
              <KpiCard label="QUERIES" value={String(kpi.queries)} accent={C.subscription} />
              <KpiCard label="AVG LAT" value={kpi.avgLatency > 0 ? `${kpi.avgLatency}ms` : '—'} />
              <KpiCard label="TOTAL OUT" value={formatBytes(kpi.totalOut)} />
            </div>

            {/* File path */}
            {filePath && (
              <div
                style={{
                  marginTop: 10,
                  fontSize: 11,
                  color: C.dim,
                  wordBreak: 'break-all',
                  lineHeight: 1.45,
                }}
              >
                {filePath}
              </div>
            )}
          </div>

          {/* ── Event list ────────────────────────────────────────────────── */}
          <div
            ref={listRef}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '10px 12px',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            {displayed.length === 0 ? (
              <div
                style={{
                  color: C.muted,
                  fontSize: 13,
                  padding: '32px 8px',
                  textAlign: 'center',
                  letterSpacing: '0.06em',
                  lineHeight: 1.8,
                }}
              >
                no telemetry captured yet
                <br />
                <span style={{ fontSize: 11, color: C.dim }}>
                  send a message to watch calls stream in
                </span>
              </div>
            ) : (
              displayed.map((entry) => <EntryRow key={entry.key} entry={entry} />)
            )}
          </div>
        </div>
      )}
    </>
  )
}
