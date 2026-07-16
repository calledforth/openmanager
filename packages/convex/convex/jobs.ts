import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

function routePayloadToSessionProvider(payload: string, providerId: string): string {
  try {
    const parsed = JSON.parse(payload)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return payload
    return JSON.stringify({ ...parsed, providerId })
  } catch {
    return payload
  }
}

export const submit = mutation({
  args: {
    workspacePath: v.string(),
    type: v.string(),
    payload: v.string(),
    clientId: v.string(),
    sessionExternalId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const workspace = await ctx.db
      .query('workspaces')
      .withIndex('by_path', (q) => q.eq('path', args.workspacePath))
      .first()
    if (!workspace) throw new Error(`Workspace not found: ${args.workspacePath}`)

    let sessionId: any
    let targetClientId = args.clientId
    let payload = args.payload

    if (args.sessionExternalId) {
      const session = await ctx.db
        .query('sessions')
        .withIndex('by_externalId', (q) => q.eq('externalId', args.sessionExternalId!))
        .first()
      if (session) {
        sessionId = session._id
        targetClientId = session.clientId ?? args.clientId
        payload = routePayloadToSessionProvider(args.payload, session.providerId ?? 'opencode')
      }
    }

    const now = Date.now()
    return await ctx.db.insert('pending_jobs', {
      workspaceId: workspace._id,
      sessionId,
      targetClientId,
      type: args.type,
      payload,
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
    clientId: v.string(),
  },
  handler: async (ctx, args) => {
    const workspace = await ctx.db
      .query('workspaces')
      .withIndex('by_path', (q) => q.eq('path', args.workspacePath))
      .first()
    if (!workspace) throw new Error(`Workspace not found: ${args.workspacePath}`)

    const session = await ctx.db
      .query('sessions')
      .withIndex('by_externalId', (q) => q.eq('externalId', args.sessionExternalId))
      .first()
    if (!session) throw new Error(`Session not found: ${args.sessionExternalId}`)

    const now = Date.now()
    return await ctx.db.insert('pending_jobs', {
      workspaceId: workspace._id,
      sessionId: session._id,
      targetClientId: session.clientId ?? args.clientId,
      type: 'send_message',
      payload: JSON.stringify({
        workspacePath: args.workspacePath,
        sessionExternalId: args.sessionExternalId,
        content: args.content,
        providerId: session.providerId ?? 'opencode',
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
    clientId: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job || job.status !== 'pending') return null

    await ctx.db.patch(args.jobId, {
      status: 'running',
      claimedBy: args.clientId,
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
  args: { clientId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('pending_jobs')
      .withIndex('by_target_status', (q) =>
        q.eq('targetClientId', args.clientId).eq('status', 'pending'),
      )
      .collect()
  },
})

export const getStatus = query({
  args: { jobId: v.id('pending_jobs') },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job) return null
    return { status: job.status, lastError: job.lastError }
  },
})
