import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

async function getSessionByExternalId(
  ctx: { db: any },
  sessionExternalId: string,
) {
  return await ctx.db
    .query('sessions')
    .withIndex('by_externalId', (q: any) => q.eq('externalId', sessionExternalId))
    .first()
}

async function getMessageByExternalId(
  ctx: { db: any },
  externalId: string,
) {
  return await ctx.db
    .query('messages')
    .withIndex('by_externalId', (q: any) => q.eq('externalId', externalId))
    .first()
}

async function getNextSequenceNum(
  ctx: { db: any },
  sessionId: any,
): Promise<number> {
  const messages = await ctx.db
    .query('messages')
    .withIndex('by_session_seq', (q: any) => q.eq('sessionId', sessionId))
    .collect()
  return (
    messages.reduce(
      (max: number, message: { sequenceNum: number }) => Math.max(max, message.sequenceNum),
      -1,
    ) + 1
  )
}

async function upsertFinalizedMessage(
  ctx: { db: any },
  args: {
    sessionExternalId: string
    externalId: string
    content: string
    role: string
    parts?: unknown
    runtimeMetadata?: unknown
  },
) {
  const metadata =
    args.parts || args.runtimeMetadata
      ? {
          ...(args.parts ? { parts: args.parts } : {}),
          ...(args.runtimeMetadata ? { runtime: args.runtimeMetadata } : {}),
        }
      : undefined
  const existing = await getMessageByExternalId(ctx, args.externalId)

  if (existing) {
    await ctx.db.patch(existing._id, {
      content: args.content,
      role: args.role,
      isFinal: true,
      metadata,
    })
    return existing._id
  }

  const session = await getSessionByExternalId(ctx, args.sessionExternalId)
  if (!session) return null

  const sequenceNum = await getNextSequenceNum(ctx, session._id)
  return await ctx.db.insert('messages', {
    sessionId: session._id,
    externalId: args.externalId,
    role: args.role,
    content: args.content,
    metadata,
    createdAt: Date.now(),
    sequenceNum,
    isFinal: true,
  })
}

export const insertPlaceholder = mutation({
  args: {
    sessionExternalId: v.string(),
    externalId: v.string(),
    role: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await getMessageByExternalId(ctx, args.externalId)
    if (existing) return existing._id

    const session = await getSessionByExternalId(ctx, args.sessionExternalId)
    if (!session) return

    const sequenceNum = await getNextSequenceNum(ctx, session._id)
    return await ctx.db.insert('messages', {
      sessionId: session._id,
      externalId: args.externalId,
      role: args.role,
      content: '',
      createdAt: Date.now(),
      sequenceNum,
      isFinal: false,
    })
  },
})

export const finalize = mutation({
  args: {
    sessionExternalId: v.string(),
    externalId: v.string(),
    content: v.string(),
    role: v.string(),
    parts: v.optional(v.any()),
    runtimeMetadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await upsertFinalizedMessage(ctx, args)
  },
})

export const upsertFinalized = mutation({
  args: {
    sessionExternalId: v.string(),
    externalId: v.string(),
    content: v.string(),
    role: v.string(),
    parts: v.optional(v.any()),
    runtimeMetadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await upsertFinalizedMessage(ctx, args)
  },
})

export const removeByExternalId = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const msg = await getMessageByExternalId(ctx, args.externalId)
    if (msg) {
      const attachments = await ctx.db
        .query('attachments')
        .withIndex('by_message', (q) => q.eq('messageExternalId', args.externalId))
        .collect()
      for (const attachment of attachments) {
        await ctx.storage.delete(attachment.storageId)
        await ctx.db.delete(attachment._id)
      }
      await ctx.db.delete(msg._id)
    }

    const chunks = await ctx.db
      .query('stream_chunks')
      .withIndex('by_message_and_index', (q) => q.eq('messageExternalId', args.externalId))
      .collect()
    for (const chunk of chunks) {
      await ctx.db.delete(chunk._id)
    }
  },
})

export const listMetadata = query({
  args: { sessionExternalId: v.string() },
  handler: async (ctx, args) => {
    const session = await getSessionByExternalId(ctx, args.sessionExternalId)
    if (!session) return []
    const messages = await ctx.db
      .query('messages')
      .withIndex('by_session_seq', (q) => q.eq('sessionId', session._id))
      .collect()
    return messages.map((message) => ({
      _id: message._id,
      externalId: message.externalId,
      role: message.role,
      sequenceNum: message.sequenceNum,
      isFinal: message.isFinal,
    }))
  },
})

export const getContent = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const message = await getMessageByExternalId(ctx, args.externalId)
    if (!message) return null
    const metadata = message.metadata as
      { parts?: Array<Record<string, unknown>>; runtime?: unknown } | undefined
    const parts = metadata?.parts
      ? await Promise.all(
          metadata.parts.map(async (part) => {
            if (part.type !== 'image' || typeof part.attachmentId !== 'string') return part
            // normalizeId guards against malformed ids in persisted parts: db.get
            // would throw and take the whole message query down with it.
            const attachmentId = ctx.db.normalizeId('attachments', part.attachmentId)
            if (!attachmentId) return part
            const attachment = await ctx.db.get(attachmentId)
            if (!attachment) return part
            const url = await ctx.storage.getUrl(attachment.storageId)
            return url ? { ...part, url } : part
          }),
        )
      : undefined
    return {
      externalId: message.externalId,
      content: message.content,
      metadata: metadata ? { ...metadata, ...(parts ? { parts } : {}) } : undefined,
      isFinal: message.isFinal,
      role: message.role,
    }
  },
})
