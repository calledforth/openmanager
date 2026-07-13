import type { ToolCallContent, ToolCallLocation, ToolCallStatus, ToolKind } from './events.js'

export type MessagePartBase = {
  id: string
  messageId?: string
  sessionId?: string
}

export type TextPart = MessagePartBase & {
  type: 'text'
  text: string
  synthetic?: boolean
  ignored?: boolean
}

export type ToolPart = MessagePartBase & {
  type: 'tool'
  toolCallId: string
  tool: string
  title: string
  kind?: ToolKind
  state: {
    status: ToolCallStatus
    input?: unknown
    output?: unknown
    error?: string
    metadata?: Record<string, unknown>
  }
  content?: ToolCallContent[]
  locations?: ToolCallLocation[]
  resultLinks?: string[]
}

export type ReasoningPart = MessagePartBase & {
  type: 'reasoning'
  text: string
  time?: {
    start: number
    end?: number
  }
}

export type RetryPart = MessagePartBase & {
  type: 'retry'
  attempt: number
  error?: string
  retryAt?: string
}

export type SubtaskPart = MessagePartBase & {
  type: 'subtask'
  description?: string
  prompt?: string
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  targetSessionId?: string
  modelId?: string
}

export type CompactionPart = MessagePartBase & {
  type: 'compaction'
  summary?: string
  automatic?: boolean
}

export type StepStartPart = MessagePartBase & {
  type: 'step-start'
  stepId: string
  title?: string
  startedAt?: string
}

export type StepFinishPart = MessagePartBase & {
  type: 'step-finish'
  stepId: string
  status: 'completed' | 'failed' | 'cancelled'
  finishedAt?: string
  error?: string
}

export type SnapshotPart = MessagePartBase & {
  type: 'snapshot'
  snapshotId: string
  data: unknown
}

export type AgentPart = MessagePartBase & {
  type: 'agent'
  name?: string
  sessionUpdate?: string
  payload?: unknown
}

export type MessagePart =
  | TextPart
  | ToolPart
  | ReasoningPart
  | RetryPart
  | SubtaskPart
  | CompactionPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | AgentPart
