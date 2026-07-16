import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

export const upsertPending = mutation({
  args: {
    sessionExternalId: v.string(),
    requestId: v.string(),
    toolCallId: v.optional(v.string()),
    permission: v.optional(v.string()),
    toolName: v.string(),
    description: v.string(),
    input: v.optional(v.any()),
    patterns: v.optional(v.any()),
    alwaysPatterns: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('pending_permissions')
      .withIndex('by_requestId', (q) => q.eq('requestId', args.requestId))
      .first()

    const next = {
      sessionExternalId: args.sessionExternalId,
      requestId: args.requestId,
      toolCallId: args.toolCallId,
      permission: args.permission,
      toolName: args.toolName,
      description: args.description,
      input: args.input,
      patterns: args.patterns,
      alwaysPatterns: args.alwaysPatterns,
      updatedAt: Date.now(),
    }

    if (existing) {
      await ctx.db.patch(existing._id, next)
      return existing._id
    }

    return await ctx.db.insert('pending_permissions', {
      ...next,
      createdAt: Date.now(),
    })
  },
})

export const resolve = mutation({
  args: { requestId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('pending_permissions')
      .withIndex('by_requestId', (q) => q.eq('requestId', args.requestId))
      .first()
    if (!existing) return
    await ctx.db.delete(existing._id)
  },
})

export const getPendingForSession = query({
  args: { sessionExternalId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('pending_permissions')
      .withIndex('by_sessionExternalId', (q) => q.eq('sessionExternalId', args.sessionExternalId))
      .collect()
    if (rows.length === 0) return null

    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    const latest = rows[0]
    return {
      requestId: latest.requestId,
      toolCallId: latest.toolCallId,
      permission: latest.permission,
      toolName: latest.toolName,
      description: latest.description,
      input: latest.input,
      patterns: latest.patterns,
      alwaysPatterns: latest.alwaysPatterns,
      createdAt: latest.createdAt,
      updatedAt: latest.updatedAt,
    }
  },
})
