import type { ProviderId, ProviderMetadata } from '@agentpack/contract'
import type { ProviderComposerProfiles } from '../../../../shared/composer-profile'
import type { ProviderModelGroup } from './MessageInputView'

/** `description` is load-bearing for Claude Code, not decoration: the CLI puts
 * the marketing name there rather than in `displayName`, so a row reads
 * `{name: 'Opus', description: 'Opus 5 · Best for everyday, complex tasks'}`.
 * Drop it and the picker cannot tell Opus 5 from Opus 4.8, and cannot say what
 * the `default` row currently resolves to. */
export type ComposerModelChoice = {
  id: string
  name: string
  description?: string
  /** Carried so the composer can gate the effort pill, the fast-mode switch
   * and the `auto` permission mode on the model that is actually selected. */
  effortLevels?: string[]
  supportsFastMode?: boolean
  supportsAutoMode?: boolean
}

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
    .map((model) => ({
      id: model.id,
      name: model.displayName,
      ...(model.description ? { description: model.description } : {}),
      ...(model.effortLevels?.length ? { effortLevels: model.effortLevels } : {}),
      ...(model.supportsFastMode ? { supportsFastMode: true } : {}),
      ...(model.supportsAutoMode ? { supportsAutoMode: true } : {}),
    }))
}

/** The mode catalog a provider reported at handshake time, on exactly the same
 * terms as `metadataModelOptions`.
 *
 * Claude Code's modes are static rather than wire-reported, but they still
 * arrive this way: the composer gates its mode control on a non-empty list,
 * and every other source of one requires a live session. */
export function metadataModeOptions(
  providers: readonly ProviderMetadata[],
  providerId: ProviderId,
): ComposerModelChoice[] {
  return (providers.find((provider) => provider.id === providerId)?.modes?.availableModes ?? []).map(
    (mode) => ({
      id: mode.id,
      name: mode.displayName,
      ...(mode.description ? { description: mode.description } : {}),
    }),
  )
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
      (model) => ({
        id: model.modelId,
        name: model.name,
        ...(model.description ? { description: model.description } : {}),
        ...(model.effortLevels?.length ? { effortLevels: model.effortLevels } : {}),
        ...(model.supportsFastMode ? { supportsFastMode: true } : {}),
        ...(model.supportsAutoMode ? { supportsAutoMode: true } : {}),
      }),
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
