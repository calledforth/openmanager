import type { ModelListing, ModelOption } from '@agentpack/contract'
import type { v2 } from '@openmanager/codex-app-server-protocol'
import type { CodexAppServerClient } from './CodexAppServerClient.js'

/** Most pages `model/list` is followed for. The catalog is about ten models
 * today; the bound only stops a server that keeps returning a cursor from
 * holding the probe forever. */
const MAX_MODEL_PAGES = 10

/** Every model the account can pick, across `model/list`'s pages. */
export async function readCodexModels(client: CodexAppServerClient): Promise<v2.Model[]> {
  const models: v2.Model[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_MODEL_PAGES; page++) {
    const response: v2.ModelListResponse = await client.request(
      'model/list',
      cursor ? { cursor } : {},
    )
    models.push(...response.data)
    cursor = response.nextCursor
    if (!cursor) break
  }
  return models
}

/** Codex's catalog in the shape every composer reads.
 *
 * Hidden models are left out: `model/list` already omits them unless asked,
 * and one that slipped through is one Codex itself would not offer. What
 * each model accepts — its reasoning efforts, whether it reads images — comes
 * from the catalog, never from a list kept here, so a CLI upgrade that adds a
 * model or an effort needs no change in openmanager. */
export function codexModelListing(models: readonly v2.Model[]): ModelListing {
  const visible = models.filter((model) => !model.hidden)
  const current = visible.find((model) => model.isDefault) ?? visible[0]
  return {
    availableModels: visible.map(codexModelOption),
    ...(current ? { currentModelId: current.id } : {}),
  }
}

export function codexModelOption(model: v2.Model): ModelOption {
  return {
    id: model.id,
    displayName: model.displayName || model.id,
    ...(model.description ? { description: model.description } : {}),
    ...(model.supportedReasoningEfforts.length > 0
      ? { effortLevels: model.supportedReasoningEfforts.map((option) => option.reasoningEffort) }
      : {}),
    // Absent means "could not say" to the composer, which lets an image
    // through; Codex always says, so this is a real answer either way.
    supportsImageInput: model.inputModalities.includes('image'),
  }
}
