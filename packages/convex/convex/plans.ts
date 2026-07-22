import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

export const upsertPending = mutation({
  args: {
    sessionExternalId: v.string(),
    requestId: v.string(),
    name: v.optional(v.string()),
    overview: v.optional(v.string()),
    markdown: v.string(),
    todos: v.any(),
    phases: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('plans')
      .withIndex('by_requestId', (q) => q.eq('requestId', args.requestId))
      .first()

    const next = {
      sessionExternalId: args.sessionExternalId,
      requestId: args.requestId,
      name: args.name,
      overview: args.overview,
      markdown: args.markdown,
      todos: args.todos,
      phases: args.phases,
      status: 'pending',
      updatedAt: Date.now(),
    }

    if (existing) {
      await ctx.db.patch(existing._id, next)
      return existing._id
    }

    return await ctx.db.insert('plans', {
      ...next,
      createdAt: Date.now(),
    })
  },
})

export const resolve = mutation({
  args: {
    requestId: v.string(),
    status: v.string(),
    resolutionReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('plans')
      .withIndex('by_requestId', (q) => q.eq('requestId', args.requestId))
      .first()
    if (!existing) return
    await ctx.db.patch(existing._id, {
      status: args.status,
      resolutionReason: args.resolutionReason,
      updatedAt: Date.now(),
    })
  },
})

export const clearForSession = mutation({
  args: { sessionExternalId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('plans')
      .withIndex('by_sessionExternalId', (q) => q.eq('sessionExternalId', args.sessionExternalId))
      .collect()
    for (const row of rows) if (row.status === 'pending') await ctx.db.delete(row._id)
  },
})

export const getPendingForSession = query({
  args: { sessionExternalId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('plans')
      .withIndex('by_sessionExternalId', (q) => q.eq('sessionExternalId', args.sessionExternalId))
      .collect()
    const pending = rows.filter((row) => row.status === 'pending')
    if (pending.length === 0) return null

    pending.sort((a, b) => b.updatedAt - a.updatedAt)
    return pending[0]
  },
})

export const getLatestForSession = query({
  args: { sessionExternalId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('plans')
      .withIndex('by_sessionExternalId', (q) => q.eq('sessionExternalId', args.sessionExternalId))
      .collect()
    if (rows.length === 0) return null

    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    return rows[0]
  },
})

export const listForSession = query({
  args: { sessionExternalId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('plans')
      .withIndex('by_sessionExternalId', (q) => q.eq('sessionExternalId', args.sessionExternalId))
      .collect()

    return rows.sort((a, b) => b.createdAt - a.createdAt)
  },
})
