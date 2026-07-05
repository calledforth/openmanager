import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
  workspaces: defineTable({
    name: v.string(),
    path: v.string(),
    machineId: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_path', ['path'])
    .index('by_machineId', ['machineId']),

  sessions: defineTable({
    workspaceId: v.id('workspaces'),
    externalId: v.string(),
    clientId: v.optional(v.string()),
    title: v.optional(v.string()),
    status: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_externalId', ['externalId']),

  messages: defineTable({
    sessionId: v.id('sessions'),
    externalId: v.string(),
    role: v.string(),
    content: v.string(),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
    sequenceNum: v.number(),
    isFinal: v.optional(v.boolean()),
  })
    .index('by_session', ['sessionId'])
    .index('by_externalId', ['externalId'])
    .index('by_session_seq', ['sessionId', 'sequenceNum']),

  pending_jobs: defineTable({
    workspaceId: v.id('workspaces'),
    sessionId: v.optional(v.id('sessions')),
    targetClientId: v.optional(v.string()),
    type: v.string(),
    payload: v.string(),
    status: v.string(),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    claimedBy: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_status', ['status'])
    .index('by_workspace', ['workspaceId'])
    .index('by_target_status', ['targetClientId', 'status']),

  pending_permissions: defineTable({
    sessionExternalId: v.string(),
    requestId: v.string(),
    permission: v.optional(v.string()),
    toolName: v.string(),
    description: v.string(),
    input: v.optional(v.any()),
    patterns: v.optional(v.any()),
    alwaysPatterns: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_sessionExternalId', ['sessionExternalId'])
    .index('by_requestId', ['requestId']),

  stream_chunks: defineTable({
    messageId: v.id('messages'),
    messageExternalId: v.string(),
    sessionExternalId: v.string(),
    chunkIndex: v.number(),
    chunkText: v.string(),
    partUpdate: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index('by_message_and_index', ['messageExternalId', 'chunkIndex'])
    .index('by_sessionExternalId', ['sessionExternalId'])
    .index('by_createdAt', ['createdAt']),
})
