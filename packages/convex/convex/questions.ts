import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

export const upsertPending = mutation({
  args: {
    sessionExternalId: v.string(),
    requestId: v.string(),
    title: v.optional(v.string()),
    questions: v.any(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('pending_questions')
      .withIndex('by_requestId', (q) => q.eq('requestId', args.requestId))
      .first()

    const next = {
      sessionExternalId: args.sessionExternalId,
      requestId: args.requestId,
      title: args.title,
      questions: args.questions,
      updatedAt: Date.now(),
    }

    if (existing) {
      await ctx.db.patch(existing._id, next)
      return existing._id
    }

    return await ctx.db.insert('pending_questions', {
      ...next,
      createdAt: Date.now(),
    })
  },
})

export const resolve = mutation({
  args: { requestId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('pending_questions')
      .withIndex('by_requestId', (q) => q.eq('requestId', args.requestId))
      .first()
    if (!existing) return
    await ctx.db.delete(existing._id)
  },
})

export const clearForSession = mutation({
  args: { sessionExternalId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('pending_questions')
      .withIndex('by_sessionExternalId', (q) => q.eq('sessionExternalId', args.sessionExternalId))
      .collect()
    for (const row of rows) await ctx.db.delete(row._id)
  },
})

export const getPendingForSession = query({
  args: { sessionExternalId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('pending_questions')
      .withIndex('by_sessionExternalId', (q) => q.eq('sessionExternalId', args.sessionExternalId))
      .collect()
    if (rows.length === 0) return null

    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    const latest = rows[0]
    return {
      requestId: latest.requestId,
      title: latest.title,
      questions: latest.questions,
      createdAt: latest.createdAt,
      updatedAt: latest.updatedAt,
    }
  },
})
