import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { providerTitlePatch, shouldReplaceSessionTitle } from './sessionTitle'

const titleSource = v.union(v.literal('fallback'), v.literal('provider'), v.literal('user'))

export const upsertStatus = mutation({
  args: {
    workspacePath: v.string(),
    externalId: v.string(),
    status: v.string(),
    providerId: v.optional(v.string()),
    title: v.optional(v.string()),
    titleSource: v.optional(titleSource),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('sessions')
      .withIndex('by_externalId', (q) => q.eq('externalId', args.externalId))
      .first()

    if (existing) {
      const incomingTitleSource = args.titleSource ?? 'fallback'
      const acceptsRequestedTitle =
        args.title !== undefined &&
        shouldReplaceSessionTitle(existing.title, existing.titleSource, incomingTitleSource)
      const requestedTitle = acceptsRequestedTitle ? args.title : undefined
      const nextTitle = requestedTitle !== undefined ? requestedTitle : existing.title
      const nextTitleSource = acceptsRequestedTitle ? incomingTitleSource : existing.titleSource
      const nextClientId = args.clientId ?? existing.clientId
      const nextProviderId = existing.providerId ?? args.providerId
      const statusChanged = existing.status !== args.status
      const titleChanged = nextTitle !== existing.title
      const titleSourceChanged = nextTitleSource !== existing.titleSource
      const clientChanged = nextClientId !== existing.clientId
      const providerChanged = nextProviderId !== existing.providerId
      if (
        !statusChanged &&
        !titleChanged &&
        !titleSourceChanged &&
        !clientChanged &&
        !providerChanged
      )
        return

      await ctx.db.patch(existing._id, {
        status: args.status,
        ...(providerChanged ? { providerId: nextProviderId } : {}),
        ...(requestedTitle !== undefined ? { title: requestedTitle } : {}),
        ...(titleSourceChanged ? { titleSource: nextTitleSource } : {}),
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
      providerId: args.providerId,
      clientId: args.clientId,
      title: args.title,
      titleSource: args.title ? (args.titleSource ?? 'fallback') : undefined,
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
    source: titleSource,
    providerId: v.optional(v.string()),
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
      const nextProviderId = existing.providerId ?? args.providerId
      const providerChanged = nextProviderId !== existing.providerId
      if (!shouldReplaceSessionTitle(existing.title, existing.titleSource, args.source)) {
        if (providerChanged) {
          await ctx.db.patch(existing._id, { providerId: nextProviderId, updatedAt: Date.now() })
        }
        return
      }
      if (
        existing.title === nextTitle &&
        existing.titleSource === args.source &&
        (!args.clientId || existing.clientId === args.clientId) &&
        !providerChanged
      )
        return
      await ctx.db.patch(existing._id, {
        title: nextTitle,
        titleSource: args.source,
        ...(providerChanged ? { providerId: nextProviderId } : {}),
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
      providerId: args.providerId,
      clientId: args.clientId,
      title: nextTitle,
      titleSource: args.source,
      status: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  },
})

export const syncProviderTitles = mutation({
  args: {
    workspacePath: v.string(),
    providerId: v.string(),
    sessions: v.array(
      v.object({
        externalId: v.string(),
        title: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const workspace = await ctx.db
      .query('workspaces')
      .withIndex('by_path', (q) => q.eq('path', args.workspacePath))
      .first()
    if (!workspace || args.sessions.length === 0) return { updated: 0 }

    const existingSessions = await ctx.db
      .query('sessions')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspace._id))
      .collect()
    const existingByExternalId = new Map(
      existingSessions.map((session) => [session.externalId, session]),
    )
    let updated = 0

    for (const candidate of args.sessions) {
      const nextTitle = candidate.title.trim()
      if (!nextTitle) continue
      const existing = existingByExternalId.get(candidate.externalId)
      const patch = providerTitlePatch(existing, args.providerId, nextTitle)
      if (!existing || !patch) continue

      await ctx.db.patch(existing._id, patch)
      updated += 1
    }

    return { updated }
  },
})

/** Mark (or create) a session as a subagent child of another session, so the
 * sidebar can nest it and the transcript opens read-only. Runs before
 * load-session replay so the projector's own upsert only patches the row. */
export const registerChild = mutation({
  args: {
    workspacePath: v.string(),
    externalId: v.string(),
    parentExternalId: v.string(),
    title: v.optional(v.string()),
    providerId: v.optional(v.string()),
    clientId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('sessions')
      .withIndex('by_externalId', (q) => q.eq('externalId', args.externalId))
      .first()
    if (existing) {
      if (existing.parentExternalId === args.parentExternalId) return { registered: true }
      await ctx.db.patch(existing._id, {
        parentExternalId: args.parentExternalId,
        updatedAt: Date.now(),
      })
      return { registered: true }
    }
    const workspace = await ctx.db
      .query('workspaces')
      .withIndex('by_path', (q) => q.eq('path', args.workspacePath))
      .first()
    if (!workspace) throw new Error(`Workspace not found: ${args.workspacePath}`)
    await ctx.db.insert('sessions', {
      workspaceId: workspace._id,
      externalId: args.externalId,
      providerId: args.providerId,
      clientId: args.clientId,
      title: args.title,
      status: 'idle',
      parentExternalId: args.parentExternalId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    return { registered: true }
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
    const sessions = await ctx.db
      .query('sessions')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspace._id))
      .collect()
    return sessions.filter((session) => !session.parentExternalId)
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
      providerId?: string
      clientId?: string
      parentExternalId?: string
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
          providerId: session.providerId,
          clientId: session.clientId,
          parentExternalId: session.parentExternalId,
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
      const attachments = await ctx.db
        .query('attachments')
        .withIndex('by_message', (q) => q.eq('messageExternalId', message.externalId))
        .collect()
      for (const attachment of attachments) {
        await ctx.storage.delete(attachment.storageId)
        await ctx.db.delete(attachment._id)
      }
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
