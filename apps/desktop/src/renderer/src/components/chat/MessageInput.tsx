import { useAppUi } from '../../providers/app-ui-provider'
import { useActiveSession } from '../../providers/active-session-provider'
import { MessageInputView } from './MessageInputView'

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
    setSessionModel,
    setSessionMode,
    openCodeUiStatus,
  } = useAppUi()
  const { sendMessage, abortSession, activeSession } = useActiveSession()

  const openCodeReady = openCodeUiStatus === 'connected'
  const disabled =
    !activeWorkspacePath || pendingDraftSessionStart || (!activeSessionId && !isSessionDraftOpen)
  const runtimeState = activeSessionId || !isSessionDraftOpen ? acpSessionState : draftSessionState
  const modeOptions = (runtimeState?.modes?.availableModes ?? []).map((m) => ({
    id: m.id,
    name: m.name,
  }))
  const currentModeId = runtimeState?.modes?.currentModeId ?? ''
  const modelOptions = (runtimeState?.models?.availableModels ?? []).map((m) => ({
    id: m.modelId,
    name: m.name,
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
      modeOptions={modeOptions}
      currentModeId={currentModeId}
      modelOptions={modelOptions}
      currentModelId={currentModelId}
      canChangeSettings={canChangeSettings}
      agent={acpAgentInfo}
      isStreaming={isStreaming}
      onModeChange={(id) => {
        if (activeSessionId) {
          void setSessionMode(activeSessionId, id)
          return
        }
        setDraftMode(id)
      }}
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
