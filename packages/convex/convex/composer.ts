import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

const agentInfoValidator = v.object({
  name: v.optional(v.string()),
  version: v.optional(v.string()),
})

const modelOptionValidator = v.object({
  modelId: v.string(),
  name: v.string(),
  description: v.optional(v.string()),
  contextWindowTokens: v.optional(v.number()),
})

const modeOptionValidator = v.object({
  id: v.string(),
  name: v.string(),
  description: v.optional(v.string()),
})

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

export const listProfiles = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query('provider_profiles').collect()
  },
})

export const listPreferences = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query('workspace_composer_preferences').collect()
  },
})

export const upsertProfile = mutation({
  args: {
    providerId: v.string(),
    agentInfo: v.optional(agentInfoValidator),
    availableModels: v.optional(v.array(modelOptionValidator)),
    availableModes: v.optional(v.array(modeOptionValidator)),
    defaultModelId: v.optional(v.string()),
    defaultModeId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('provider_profiles')
      .withIndex('by_provider', (q) => q.eq('providerId', args.providerId))
      .first()

    const fields = [
      'agentInfo',
      'availableModels',
      'availableModes',
      'defaultModelId',
      'defaultModeId',
    ] as const

    if (existing) {
      // Patch only fields that were provided and actually changed. Skipping the
      // patch entirely (including updatedAt) keeps subscriptions quiet when a
      // session lifecycle event re-reports an unchanged catalog.
      const patch: Record<string, unknown> = {}
      for (const field of fields) {
        const value = args[field]
        if (value === undefined) continue
        if (sameValue(value, existing[field])) continue
        patch[field] = value
      }
      if (Object.keys(patch).length === 0) return
      await ctx.db.patch(existing._id, { ...patch, updatedAt: Date.now() })
      return
    }

    await ctx.db.insert('provider_profiles', {
      providerId: args.providerId,
      ...(args.agentInfo !== undefined ? { agentInfo: args.agentInfo } : {}),
      ...(args.availableModels !== undefined ? { availableModels: args.availableModels } : {}),
      ...(args.availableModes !== undefined ? { availableModes: args.availableModes } : {}),
      ...(args.defaultModelId !== undefined ? { defaultModelId: args.defaultModelId } : {}),
      ...(args.defaultModeId !== undefined ? { defaultModeId: args.defaultModeId } : {}),
      updatedAt: Date.now(),
    })
  },
})

export const upsertPreference = mutation({
  args: {
    workspacePath: v.string(),
    providerId: v.string(),
    modelId: v.optional(v.string()),
    modeId: v.optional(v.string()),
    configValues: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('workspace_composer_preferences')
      .withIndex('by_workspace_provider', (q) =>
        q.eq('workspacePath', args.workspacePath).eq('providerId', args.providerId),
      )
      .first()

    if (existing) {
      const patch: Record<string, unknown> = {}
      if (args.modelId !== undefined && args.modelId !== existing.modelId) {
        patch.modelId = args.modelId
      }
      if (args.modeId !== undefined && args.modeId !== existing.modeId) {
        patch.modeId = args.modeId
      }
      if (args.configValues !== undefined && !sameValue(args.configValues, existing.configValues)) {
        patch.configValues = args.configValues
      }
      if (Object.keys(patch).length === 0) return
      await ctx.db.patch(existing._id, { ...patch, updatedAt: Date.now() })
      return
    }

    await ctx.db.insert('workspace_composer_preferences', {
      workspacePath: args.workspacePath,
      providerId: args.providerId,
      ...(args.modelId !== undefined ? { modelId: args.modelId } : {}),
      ...(args.modeId !== undefined ? { modeId: args.modeId } : {}),
      ...(args.configValues !== undefined ? { configValues: args.configValues } : {}),
      updatedAt: Date.now(),
    })
  },
})
