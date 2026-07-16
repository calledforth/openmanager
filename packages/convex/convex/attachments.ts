import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

export const generateUploadUrl = mutation({
  args: { clientId: v.string() },
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
})

export const register = mutation({
  args: {
    storageId: v.id('_storage'),
    clientId: v.string(),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
  },
  handler: async (ctx, args) => {
    if (!ALLOWED_IMAGE_TYPES.has(args.mimeType)) {
      await ctx.storage.delete(args.storageId)
      throw new Error(`Unsupported image type: ${args.mimeType}`)
    }
    if (args.size <= 0 || args.size > MAX_IMAGE_BYTES) {
      await ctx.storage.delete(args.storageId)
      throw new Error('Image must be between 1 byte and 10 MB')
    }
    return await ctx.db.insert('attachments', {
      storageId: args.storageId,
      clientId: args.clientId,
      name: args.name.slice(0, 255),
      mimeType: args.mimeType,
      size: args.size,
      createdAt: Date.now(),
    })
  },
})

export const resolveMany = query({
  args: { ids: v.array(v.id('attachments')), clientId: v.string() },
  handler: async (ctx, args) => {
    return await Promise.all(
      args.ids.map(async (id) => {
        const attachment = await ctx.db.get(id)
        if (!attachment || attachment.clientId !== args.clientId) return null
        const url = await ctx.storage.getUrl(attachment.storageId)
        if (!url) return null
        return {
          id: attachment._id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.size,
          url,
        }
      }),
    )
  },
})

export const assignToMessage = mutation({
  args: {
    ids: v.array(v.id('attachments')),
    clientId: v.string(),
    messageExternalId: v.string(),
  },
  handler: async (ctx, args) => {
    for (const id of args.ids) {
      const attachment = await ctx.db.get(id)
      if (attachment?.clientId === args.clientId) {
        await ctx.db.patch(id, { messageExternalId: args.messageExternalId })
      }
    }
  },
})

export const removeMany = mutation({
  args: { ids: v.array(v.id('attachments')), clientId: v.string() },
  handler: async (ctx, args) => {
    for (const id of args.ids) {
      const attachment = await ctx.db.get(id)
      if (!attachment || attachment.clientId !== args.clientId) continue
      await ctx.storage.delete(attachment.storageId)
      await ctx.db.delete(id)
    }
  },
})
