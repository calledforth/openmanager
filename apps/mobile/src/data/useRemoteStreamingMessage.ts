import type { StreamMessagePart } from '@openmanager/shared/lib/remote-stream-parts'

// Inert until streaming text comes from the environment client's events.

const NOTHING: { content: string; parts: StreamMessagePart[] | undefined } = {
  content: '',
  parts: undefined,
}

export function useRemoteStreamingMessage(
  _messageExternalId: string,
  _enabled: boolean,
  _onUpdate?: () => void,
): { content: string; parts: StreamMessagePart[] | undefined } {
  return NOTHING
}
