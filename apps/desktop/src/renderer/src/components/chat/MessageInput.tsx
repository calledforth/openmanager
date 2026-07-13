import { useAppUi } from '../../providers/app-ui-provider'
import { useActiveSession } from '../../providers/active-session-provider'
import { MessageInputView } from './MessageInputView'
import { deriveSessionChrome } from '@agentpack/view'

export function MessageInput() {
  const {
    activeSessionId,
    activeWorkspacePath,
    isSessionDraftOpen,
    pendingDraftSessionStart,
    acpSessionState,
    draftSessionState,
    acpAgentInfo,
    setDraftModel,
    setDraftMode,
    setDraftProvider,
    setSessionModel,
    setSessionMode,
    openCodeUiStatus,
    agentEvents,
    providers,
  } = useAppUi()
  const { sendMessage, abortSession, activeSession } = useActiveSession()

  const openCodeReady = openCodeUiStatus === 'connected'
  const disabled =
    !activeWorkspacePath || pendingDraftSessionStart || (!activeSessionId && !isSessionDraftOpen)
  const runtimeState = activeSessionId || !isSessionDraftOpen ? acpSessionState : draftSessionState
  const chrome = deriveSessionChrome(agentEvents, {
    providers,
    selectedProviderId: runtimeState?.providerId ?? 'opencode',
    sessionId: activeSessionId ?? undefined,
  })
  const providerOptions = chrome.providerPicker.options.map((provider) => ({
    id: provider.id,
    name: provider.label,
  }))
  const currentProviderId = chrome.providerPicker.currentProviderId ?? 'opencode'
  const modeOptions = (chrome.modePicker?.options ?? []).map((mode) => ({
    id: mode.id,
    name: mode.label,
  }))
  const currentModeId = runtimeState?.modes?.currentModeId ?? ''
  const modelOptions = (chrome.modelPicker?.options ?? []).map((model) => ({
    id: model.id,
    name: model.label,
  }))
  const currentModelId = runtimeState?.models?.currentModelId ?? ''
  const canChangeSettings = !!activeSessionId || isSessionDraftOpen
  const isStreaming = activeSession?.status === 'running' || activeSession?.status === 'busy'

  return (
    <MessageInputView
      disabled={disabled}
      pendingDraftSessionStart={pendingDraftSessionStart}
      activeWorkspacePath={activeWorkspacePath}
      activeSessionId={activeSessionId}
      isSessionDraftOpen={isSessionDraftOpen}
      openCodeReady={openCodeReady}
      providerOptions={providerOptions}
      currentProviderId={currentProviderId}
      modeOptions={modeOptions}
      currentModeId={currentModeId}
      modelOptions={modelOptions}
      currentModelId={currentModelId}
      canChangeSettings={canChangeSettings}
      canChangeProvider={isSessionDraftOpen && !activeSessionId}
      showModeControl={chrome.modePicker !== null}
      showModelControl={chrome.modelPicker !== null}
      agent={acpAgentInfo}
      isStreaming={isStreaming}
      onModeChange={(id) => {
        if (activeSessionId) {
          void setSessionMode(activeSessionId, id)
          return
        }
        setDraftMode(id)
      }}
      onProviderChange={setDraftProvider}
      onModelChange={(id) => {
        if (activeSessionId) {
          void setSessionModel(activeSessionId, id)
          return
        }
        setDraftModel(id)
      }}
      onSend={(text) => {
        void sendMessage(text)
      }}
      onAbort={() => {
        if (activeSessionId) {
          void abortSession(activeSessionId)
        }
      }}
    />
  )
}
