import { action } from './_generated/server'
import { internal } from './_generated/api'
import { v } from 'convex/values'

export const flushMessageBatch = action({
  args: {
    sessionExternalId: v.string(),
    messageExternalId: v.string(),
    content: v.string(),
    role: v.string(),
    isFinal: v.boolean(),
    sequenceNum: v.number(),
    parts: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.messages.upsertContent, {
      sessionExternalId: args.sessionExternalId,
      externalId: args.messageExternalId,
      content: args.content,
      role: args.role,
      isFinal: args.isFinal,
      sequenceNum: args.sequenceNum,
      parts: args.parts,
    })
  },
})

export const updateSessionStatus = action({
  args: {
    workspacePath: v.string(),
    externalId: v.string(),
    status: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.sessions.upsertStatus, args)
  },
})

export const deleteSession = action({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.sessions.remove, args)
  },
})

export const deleteMessage = action({
  args: { messageExternalId: v.string() },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.messages.removeByExternalId, {
      externalId: args.messageExternalId,
    })
  },
})
