import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

export const submit = mutation({
  args: {
    workspacePath: v.string(),
    type: v.string(),
    payload: v.string(),
  },
  handler: async (ctx, args) => {
    const workspace = await ctx.db
      .query('workspaces')
      .withIndex('by_path', (q) => q.eq('path', args.workspacePath))
      .first()
    if (!workspace) throw new Error(`Workspace not found: ${args.workspacePath}`)

    const now = Date.now()
    return await ctx.db.insert('pending_jobs', {
      workspaceId: workspace._id,
      type: args.type,
      payload: args.payload,
      status: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    })
  },
})

export const submitMessage = mutation({
  args: {
    workspacePath: v.string(),
    sessionExternalId: v.string(),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const workspace = await ctx.db
      .query('workspaces')
      .withIndex('by_path', (q) => q.eq('path', args.workspacePath))
      .first()
    if (!workspace) throw new Error(`Workspace not found: ${args.workspacePath}`)

    const now = Date.now()
    return await ctx.db.insert('pending_jobs', {
      workspaceId: workspace._id,
      type: 'send_message',
      payload: JSON.stringify({
        workspacePath: args.workspacePath,
        sessionExternalId: args.sessionExternalId,
        content: args.content,
      }),
      status: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    })
  },
})

export const claim = mutation({
  args: {
    jobId: v.id('pending_jobs'),
    machineId: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job || job.status !== 'pending') return null

    await ctx.db.patch(args.jobId, {
      status: 'running',
      claimedBy: args.machineId,
      attempts: job.attempts + 1,
      updatedAt: Date.now(),
    })
    return await ctx.db.get(args.jobId)
  },
})

export const complete = mutation({
  args: {
    jobId: v.id('pending_jobs'),
    status: v.string(),
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.jobId, {
      status: args.status,
      lastError: args.lastError,
      updatedAt: Date.now(),
    })
  },
})

export const listPending = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query('pending_jobs')
      .withIndex('by_status', (q) => q.eq('status', 'pending'))
      .collect()
  },
})
