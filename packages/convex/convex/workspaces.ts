import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

export const create = mutation({
  args: {
    name: v.string(),
    path: v.string(),
    machineId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const id = await ctx.db.insert('workspaces', {
      ...args,
      createdAt: now,
      updatedAt: now,
    })
    return await ctx.db.get(id)
  },
})

export const ensureByPath = mutation({
  args: {
    path: v.string(),
    machineId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('workspaces')
      .withIndex('by_path', (q) => q.eq('path', args.path))
      .first()
    if (existing) return existing

    const name = args.path.split(/[\\/]/).pop() ?? args.path
    const now = Date.now()
    const id = await ctx.db.insert('workspaces', {
      name,
      path: args.path,
      machineId: args.machineId,
      createdAt: now,
      updatedAt: now,
    })
    return await ctx.db.get(id)
  },
})

export const getById = query({
  args: { id: v.id('workspaces') },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id)
  },
})

export const getByPath = query({
  args: { path: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('workspaces')
      .withIndex('by_path', (q) => q.eq('path', args.path))
      .first()
  },
})

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query('workspaces').collect()
  },
})

export const update = mutation({
  args: {
    id: v.id('workspaces'),
    name: v.optional(v.string()),
    path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args
    const filtered = Object.fromEntries(
      Object.entries(updates).filter(([_, val]) => val !== undefined),
    )
    await ctx.db.patch(id, { ...filtered, updatedAt: Date.now() })
    return await ctx.db.get(id)
  },
})

export const remove = mutation({
  args: { id: v.id('workspaces') },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id)
  },
})
