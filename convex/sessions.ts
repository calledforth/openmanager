import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

function isPlaceholderTitle(title: string | undefined): boolean {
  if (!title) return true
  const trimmed = title.trim()
  if (!trimmed) return true
  if (/^ACP Session\s+[0-9a-f-]{8,}$/i.test(trimmed)) return true
  if (/^New session\s*-\s*\d+$/i.test(trimmed)) return true
  if (/^session[-_\s]?[0-9a-z]{6,}$/i.test(trimmed)) return true
  return false
}

export const upsertStatus = mutation({
  args: {
    workspacePath: v.string(),
    externalId: v.string(),
    status: v.string(),
    title: v.optional(v.string()),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('sessions')
      .withIndex('by_externalId', (q) => q.eq('externalId', args.externalId))
      .first()

    if (existing) {
      const requestedTitle =
        args.title !== undefined && isPlaceholderTitle(args.title) && !isPlaceholderTitle(existing.title)
          ? existing.title
          : args.title
      const nextTitle = requestedTitle !== undefined ? requestedTitle : existing.title
      const nextClientId = args.clientId ?? existing.clientId
      const statusChanged = existing.status !== args.status
      const titleChanged = nextTitle !== existing.title
      const clientChanged = nextClientId !== existing.clientId
      if (!statusChanged && !titleChanged && !clientChanged) return

      await ctx.db.patch(existing._id, {
        status: args.status,
        ...(requestedTitle !== undefined ? { title: requestedTitle } : {}),
        ...(args.clientId ? { clientId: args.clientId } : {}),
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
      clientId: args.clientId,
      title: args.title,
      status: args.status,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  },
})

export const upsertTitle = mutation({
  args: {
    workspacePath: v.string(),
    externalId: v.string(),
    title: v.string(),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const nextTitle = args.title.trim()
    if (!nextTitle) return

    const existing = await ctx.db
      .query('sessions')
      .withIndex('by_externalId', (q) => q.eq('externalId', args.externalId))
      .first()

    if (existing) {
      if (!isPlaceholderTitle(existing.title)) return
      if (existing.title === nextTitle && (!args.clientId || existing.clientId === args.clientId)) return
      await ctx.db.patch(existing._id, {
        title: nextTitle,
        ...(args.clientId ? { clientId: args.clientId } : {}),
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
      clientId: args.clientId,
      title: nextTitle,
      status: 'idle',
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

export const listForSidebar = query({
  args: { workspacePaths: v.array(v.string()) },
  handler: async (ctx, args) => {
    if (args.workspacePaths.length === 0) return []

    const rows: Array<{
      workspacePath: string
      externalId: string
      title?: string
      status: string
      clientId?: string
      updatedAt: number
    }> = []

    for (const workspacePath of args.workspacePaths) {
      const workspace = await ctx.db
        .query('workspaces')
        .withIndex('by_path', (q) => q.eq('path', workspacePath))
        .first()
      if (!workspace) continue
      const sessions = await ctx.db
        .query('sessions')
        .withIndex('by_workspace', (q) => q.eq('workspaceId', workspace._id))
        .collect()
      for (const session of sessions) {
        rows.push({
          workspacePath,
          externalId: session.externalId,
          title: session.title,
          status: session.status,
          clientId: session.clientId,
          updatedAt: session.updatedAt,
        })
      }
    }

    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    return rows
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

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query('sessions')
      .withIndex('by_externalId', (q) => q.eq('externalId', args.externalId))
      .first()
    if (!session) return

    const messages = await ctx.db
      .query('messages')
      .withIndex('by_session', (q) => q.eq('sessionId', session._id))
      .collect()

    for (const message of messages) {
      const chunks = await ctx.db
        .query('stream_chunks')
        .withIndex('by_message_and_index', (q) => q.eq('messageExternalId', message.externalId))
        .collect()
      for (const chunk of chunks) {
        await ctx.db.delete(chunk._id)
      }
      await ctx.db.delete(message._id)
    }

    const pendingPermissions = await ctx.db
      .query('pending_permissions')
      .withIndex('by_sessionExternalId', (q) => q.eq('sessionExternalId', args.externalId))
      .collect()
    for (const pendingPermission of pendingPermissions) {
      await ctx.db.delete(pendingPermission._id)
    }

    await ctx.db.delete(session._id)
  },
})
