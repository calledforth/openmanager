import { v } from 'convex/values'
import { internalMutation, query } from './_generated/server'

export const upsertStatus = internalMutation({
  args: {
    workspacePath: v.string(),
    externalId: v.string(),
    status: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('sessions')
      .withIndex('by_externalId', (q) => q.eq('externalId', args.externalId))
      .first()

    if (existing) {
      await ctx.db.patch(existing._id, {
        status: args.status,
        ...(args.title !== undefined ? { title: args.title } : {}),
        updatedAt: Date.now(),
      })
      return
    }

    const workspace = await ctx.db
      .query('workspaces')
      .withIndex('by_path', (q) => q.eq('path', args.workspacePath))
      .first()
    if (!workspace) return

    await ctx.db.insert('sessions', {
      workspaceId: workspace._id,
      externalId: args.externalId,
      title: args.title,
      status: args.status,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  },
})

export const listByWorkspace = query({
  args: { workspacePath: v.string() },
  handler: async (ctx, args) => {
    const workspace = await ctx.db
      .query('workspaces')
      .withIndex('by_path', (q) => q.eq('path', args.workspacePath))
      .first()
    if (!workspace) return []
    return await ctx.db
      .query('sessions')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspace._id))
      .collect()
  },
})

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('sessions')
      .withIndex('by_externalId', (q) => q.eq('externalId', args.externalId))
      .first()
  },
})

export const remove = internalMutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query('sessions')
      .withIndex('by_externalId', (q) => q.eq('externalId', args.externalId))
      .first()
    if (session) await ctx.db.delete(session._id)
  },
})
