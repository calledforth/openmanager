import type { ProviderId, ProviderMetadata } from '@agentpack/contract'
import type { ProviderComposerProfiles } from '../../../../shared/composer-profile'
import type { ProviderModelGroup } from './MessageInputView'

export type ComposerModelChoice = { id: string; name: string }

/** The catalog a provider reported at handshake time, before any session.
 *
 * Only providers that can answer their model list without a live session carry
 * one — over ACP the list arrives as session state, so this is empty for them
 * and every caller falls through to the source it already used. */
export function metadataModelOptions(
  providers: readonly ProviderMetadata[],
  providerId: ProviderId,
): ComposerModelChoice[] {
  return (providers.find((provider) => provider.id === providerId)?.models?.availableModels ?? [])
    .map((model) => ({ id: model.id, name: model.displayName }))
}

/** One group per provider for the composer's single provider→model control.
 *
 * The ordering is the point. Every source but the last requires the provider to
 * have been *used*: the current provider's models come from live session or
 * replayed chrome state, and every other provider's come from the composer
 * profile, which is written from session events. A provider nobody has run a
 * session with therefore had no models — and the picker hides a group with no
 * models, so it could never be picked, so it could never report any. Provider
 * metadata breaks that loop, because a probe fills it in at launch. */
export function buildProviderModelGroups(args: {
  providerOptions: readonly { id: ProviderId; name: string }[]
  currentProviderId: ProviderId
  /** Already-resolved models for the current provider (runtime, then chrome,
   * then metadata) — the same list the composer's own model label reads. */
  currentModels: readonly ComposerModelChoice[]
  composerProfiles: ProviderComposerProfiles
  providers: readonly ProviderMetadata[]
}): ProviderModelGroup[] {
  return args.providerOptions.map((provider) => {
    const profileModels = (args.composerProfiles[provider.id]?.availableModels ?? []).map(
      (model) => ({ id: model.modelId, name: model.name }),
    )
    const models =
      provider.id === args.currentProviderId
        ? args.currentModels
        : profileModels.length > 0
          ? profileModels
          : metadataModelOptions(args.providers, provider.id)
    return { providerId: provider.id, providerName: provider.name, models: [...models] }
  })
}
