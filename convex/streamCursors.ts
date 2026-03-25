import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

async function listCursorsByMessageExternalId(ctx: { db: any }, messageExternalId: string) {
  return await ctx.db
    .query('stream_cursors')
    .withIndex('by_messageExternalId', (q: any) => q.eq('messageExternalId', messageExternalId))
    .collect()
}

function getCanonicalCursor(
  cursors: Array<{ [key: string]: any; chunkIndex: number; updatedAt: number }>,
) {
  if (cursors.length === 0) return null
  return cursors.reduce((best, cursor) => {
    if (cursor.chunkIndex > best.chunkIndex) return cursor
    if (cursor.chunkIndex === best.chunkIndex && cursor.updatedAt > best.updatedAt) return cursor
    return best
  })
}

export const upsert = mutation({
  args: {
    messageExternalId: v.string(),
    sessionExternalId: v.string(),
    chunkIndex: v.number(),
    chunkText: v.string(),
    partUpdate: v.optional(v.any()),
    bodyUpToHere: v.string(),
    partsUpToHere: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db
      .query('messages')
      .withIndex('by_externalId', (q) => q.eq('externalId', args.messageExternalId))
      .first()
    if (!message) return null
    if (message.isFinal) return null

    const cursors = await listCursorsByMessageExternalId(ctx, args.messageExternalId)
    const existing = getCanonicalCursor(cursors)
    for (const cursor of cursors) {
      if (!existing || cursor._id !== existing._id) {
        await ctx.db.delete(cursor._id)
      }
    }
    if (existing && args.chunkIndex <= existing.chunkIndex) {
      return existing._id
    }
    const patch = {
      messageId: message._id,
      messageExternalId: args.messageExternalId,
      sessionExternalId: args.sessionExternalId,
      chunkIndex: args.chunkIndex,
      chunkText: args.chunkText,
      partUpdate: args.partUpdate,
      bodyUpToHere: args.bodyUpToHere,
      partsUpToHere: args.partsUpToHere,
      updatedAt: Date.now(),
    }

    if (existing) {
      await ctx.db.patch(existing._id, patch)
      return existing._id
    }

    return await ctx.db.insert('stream_cursors', patch)
  },
})

export const get = query({
  args: { messageExternalId: v.string() },
  handler: async (ctx, args) => {
    const cursor = getCanonicalCursor(
      await listCursorsByMessageExternalId(ctx, args.messageExternalId),
    )
    if (!cursor) return null
    return {
      chunkIndex: cursor.chunkIndex,
      chunkText: cursor.chunkText,
      partUpdate: cursor.partUpdate,
    }
  },
})

export const getSnapshot = query({
  args: { messageExternalId: v.string() },
  handler: async (ctx, args) => {
    const cursor = getCanonicalCursor(
      await listCursorsByMessageExternalId(ctx, args.messageExternalId),
    )
    if (!cursor) return null
    return {
      bodyUpToHere: cursor.bodyUpToHere,
      partsUpToHere: cursor.partsUpToHere,
      chunkIndex: cursor.chunkIndex,
    }
  },
})

export const remove = mutation({
  args: { messageExternalId: v.string() },
  handler: async (ctx, args) => {
    const cursors = await listCursorsByMessageExternalId(ctx, args.messageExternalId)
    for (const cursor of cursors) {
      await ctx.db.delete(cursor._id)
    }
  },
})
