import { v } from 'convex/values'
import { internalMutation, query } from './_generated/server'

export const upsertContent = internalMutation({
  args: {
    sessionExternalId: v.string(),
    externalId: v.string(),
    content: v.string(),
    role: v.string(),
    isFinal: v.boolean(),
    sequenceNum: v.number(),
    parts: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('messages')
      .withIndex('by_externalId', (q) => q.eq('externalId', args.externalId))
      .first()

    const metadata = args.parts ? { parts: args.parts } : undefined

    if (existing) {
      await ctx.db.patch(existing._id, {
        content: args.content,
        isFinal: args.isFinal,
        ...(metadata ? { metadata } : {}),
      })
      return
    }

    const session = await ctx.db
      .query('sessions')
      .withIndex('by_externalId', (q) => q.eq('externalId', args.sessionExternalId))
      .first()
    if (!session) return

    await ctx.db.insert('messages', {
      sessionId: session._id,
      externalId: args.externalId,
      role: args.role,
      content: args.content,
      metadata,
      createdAt: Date.now(),
      sequenceNum: args.sequenceNum,
      isFinal: args.isFinal,
    })
  },
})

export const removeByExternalId = internalMutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const msg = await ctx.db
      .query('messages')
      .withIndex('by_externalId', (q) => q.eq('externalId', args.externalId))
      .first()
    if (msg) await ctx.db.delete(msg._id)
  },
})

export const listBySession = query({
  args: { sessionExternalId: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query('sessions')
      .withIndex('by_externalId', (q) => q.eq('externalId', args.sessionExternalId))
      .first()
    if (!session) return []
    return await ctx.db
      .query('messages')
      .withIndex('by_session_seq', (q) => q.eq('sessionId', session._id))
      .collect()
  },
})
