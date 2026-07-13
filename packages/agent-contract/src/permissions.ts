export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'

export type PermissionOption = {
  optionId: string
  name: string
  kind: PermissionOptionKind
}

export type PermissionToolCall = {
  toolCallId: string
  title: string
  kind?: string
  rawInput?: unknown
}

export type PermissionRequest = {
  requestId: string
  sessionId: string
  toolCall: PermissionToolCall
  options: PermissionOption[]
  expiresAt?: string
  metadata?: Record<string, unknown>
}

export type PermissionCancellationReason =
  'user' | 'timeout' | 'session_closed' | 'tool_cancelled' | 'runtime_disposed'

export type PermissionOutcome =
  | {
      outcome: 'selected'
      optionId: string
    }
  | {
      outcome: 'cancelled'
      reason?: PermissionCancellationReason
    }
