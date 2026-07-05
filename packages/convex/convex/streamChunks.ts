import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

async function getMessageByExternalId(ctx: { db: any }, messageExternalId: string) {
  return await ctx.db
    .query('messages')
    .withIndex('by_externalId', (q: any) => q.eq('externalId', messageExternalId))
    .first()
}

async function deleteChunksByMessageExternalId(ctx: { db: any }, messageExternalId: string) {
  const chunks = await ctx.db
    .query('stream_chunks')
    .withIndex('by_message_and_index', (q: any) => q.eq('messageExternalId', messageExternalId))
    .collect()
  for (const chunk of chunks) {
    await ctx.db.delete(chunk._id)
  }
}

export const appendChunk = mutation({
  args: {
    messageExternalId: v.string(),
    sessionExternalId: v.string(),
    chunkIndex: v.number(),
    chunkText: v.string(),
    partUpdate: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const message = await getMessageByExternalId(ctx, args.messageExternalId)
    if (!message) return null
    if (message.isFinal) return null

    return await ctx.db.insert('stream_chunks', {
      messageId: message._id,
      messageExternalId: args.messageExternalId,
      sessionExternalId: args.sessionExternalId,
      chunkIndex: args.chunkIndex,
      chunkText: args.chunkText,
      partUpdate: args.partUpdate,
      createdAt: Date.now(),
    })
  },
})

export const getLatestChunk = query({
  args: { messageExternalId: v.string() },
  handler: async (ctx, args) => {
    const latest = await ctx.db
      .query('stream_chunks')
      .withIndex('by_message_and_index', (q) => q.eq('messageExternalId', args.messageExternalId))
      .order('desc')
      .first()
    if (!latest) return null
    return {
      chunkIndex: latest.chunkIndex,
      chunkText: latest.chunkText,
      partUpdate: latest.partUpdate,
    }
  },
})

export const getChunksSince = query({
  args: { messageExternalId: v.string(), afterIndex: v.number() },
  handler: async (ctx, args) => {
    const chunks = await ctx.db
      .query('stream_chunks')
      .withIndex('by_message_and_index', (q) =>
        q.eq('messageExternalId', args.messageExternalId).gt('chunkIndex', args.afterIndex),
      )
      .collect()
    return chunks.map((chunk) => ({
      chunkIndex: chunk.chunkIndex,
      chunkText: chunk.chunkText,
      partUpdate: chunk.partUpdate,
    }))
  },
})

export const remove = mutation({
  args: { messageExternalId: v.string() },
  handler: async (ctx, args) => {
    await deleteChunksByMessageExternalId(ctx, args.messageExternalId)
  },
})
