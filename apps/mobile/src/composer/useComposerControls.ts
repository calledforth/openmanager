import { useCallback, useMemo } from 'react'
import {
  deriveComposerControls,
  useComposerState,
  usePlatformCapabilities,
  useSessionState,
  type ComposerControls,
  type SessionConfigValue,
} from '@openmanager/app-core/logic'

import type { ProviderId } from './model'

export interface ComposerControlsBinding {
  controls: ComposerControls
  /** The last pick the environment refused, in its words. */
  error: string | null
  pickModel: (providerId: ProviderId, modelId: string) => void
  pickMode: (modeId: string) => void
  setSetting: (configId: string, value: SessionConfigValue) => void
}

/**
 * The composer's picks over the shared providers, exactly as web's
 * `MessageInput` reads and writes them: the controls from
 * `deriveComposerControls`, and every pick through the composer state's
 * setters. A session's pick is a command (`session.composer.*`), which the
 * environment answers by pushing the session's new selection to every
 * client; a draft's is kept with the draft. Nothing is set on screen first.
 *
 * `activeThreadStatus` is the thread's listed status, handed in rather than
 * read here: the thread's own state changes with every streamed token.
 */
export function useComposerControls(
  activeThreadStatus: string | undefined,
): ComposerControlsBinding {
  const session = useSessionState()
  const composer = useComposerState()
  const platform = usePlatformCapabilities()
  const {
    activeSessionId,
    activeWorkspacePath,
    isSessionDraftOpen,
    newSessionDraftId,
    defaultProviderId,
    localSessionStatus,
  } = session
  const {
    acpSessionState,
    draftSessionState,
    agentEvents,
    providerComposerProfiles,
    composerConfigValues,
    setDraftModel,
    setDraftMode,
    setDraftConfigOption,
    setDraftProvider,
    setSessionModel,
    setSessionMode,
    setSessionConfigOption,
    error,
  } = composer
  const { providers, agentUiStatusByProvider, acpPromptCapabilitiesByProvider } = platform

  const controls = useMemo(
    () =>
      deriveComposerControls({
        session: {
          activeSessionId,
          activeWorkspacePath,
          isSessionDraftOpen,
          newSessionDraftId,
          defaultProviderId,
          localSessionStatus,
        },
        composer: {
          acpSessionState,
          draftSessionState,
          agentEvents,
          providerComposerProfiles,
          composerConfigValues,
        },
        platform: { providers, agentUiStatusByProvider, acpPromptCapabilitiesByProvider },
        activeThreadStatus,
      }),
    [
      acpPromptCapabilitiesByProvider,
      acpSessionState,
      activeSessionId,
      activeThreadStatus,
      activeWorkspacePath,
      agentEvents,
      agentUiStatusByProvider,
      composerConfigValues,
      defaultProviderId,
      draftSessionState,
      isSessionDraftOpen,
      localSessionStatus,
      newSessionDraftId,
      providerComposerProfiles,
      providers,
    ],
  )
  const currentProviderId = controls.currentProviderId

  const pickModel = useCallback(
    (providerId: ProviderId, modelId: string) => {
      if (activeSessionId) {
        // A session stays on its provider; web's picker offers no other.
        if (providerId === currentProviderId) void setSessionModel(activeSessionId, modelId)
        return
      }
      if (providerId !== currentProviderId) {
        setDraftProvider(providerId, modelId)
        return
      }
      setDraftModel(modelId)
    },
    [activeSessionId, currentProviderId, setDraftModel, setDraftProvider, setSessionModel],
  )
  const pickMode = useCallback(
    (modeId: string) => {
      if (activeSessionId) {
        void setSessionMode(activeSessionId, modeId)
        return
      }
      setDraftMode(modeId)
    },
    [activeSessionId, setDraftMode, setSessionMode],
  )
  const setSetting = useCallback(
    (configId: string, value: SessionConfigValue) => {
      if (activeSessionId) {
        void setSessionConfigOption(activeSessionId, configId, value)
        return
      }
      setDraftConfigOption(configId, value)
    },
    [activeSessionId, setDraftConfigOption, setSessionConfigOption],
  )

  return useMemo(
    () => ({ controls, error, pickModel, pickMode, setSetting }),
    [controls, error, pickMode, pickModel, setSetting],
  )
}
