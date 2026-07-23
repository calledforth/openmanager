import type { StreamMessagePart } from '@openmanager/shared/lib/remote-stream-parts'

export interface StreamingSnapshot {
  content: string
  parts: StreamMessagePart[] | undefined
}

export interface LocalContinuitySnapshot extends StreamingSnapshot {
  hasCompleteHistory: boolean
}

export function shouldRecoverRemoteStream(
  role: string,
  isFinal: boolean | undefined,
  local: LocalContinuitySnapshot | undefined,
): boolean {
  return role === 'assistant' && isFinal !== true && local?.hasCompleteHistory !== true
}

export function selectStreamingSnapshot(
  local: LocalContinuitySnapshot | undefined,
  remote: StreamingSnapshot,
): StreamingSnapshot {
  if (local?.hasCompleteHistory) return local
  if (!local) return remote

  const remotePartsCount = remote.parts?.length ?? 0
  const localPartsCount = local.parts?.length ?? 0
  const remoteCoversLocalText =
    remote.content.length > 0 && remote.content.length >= local.content.length
  const remoteCoversLocalParts =
    local.content.length === 0 && remotePartsCount > 0 && remotePartsCount >= localPartsCount

  return remoteCoversLocalText || remoteCoversLocalParts ? remote : local
}
