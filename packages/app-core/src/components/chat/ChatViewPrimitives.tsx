import { type ReactNode } from 'react'
import { MessageParts } from '../parts/MessageParts'
import { TurnWorkGroup } from '../parts/TurnWorkGroup'
import {
  partitionSettledTurnParts,
  settledTurnLabel,
  UNPROMPTED_TURN_LABEL,
  type TurnRuntimeMetadata,
} from '../parts/turn-work-group'
import { TextPart } from '../parts/TextPart'
import { cn } from '../../lib/utils'
import type { StreamMessagePart } from '@openmanager/shared/lib/remote-stream-parts'
import { chatStreamInner } from './chatComposerStyles'
import { SessionBusyLoader } from '../sidebar/SessionBusyLoader'
import { CopyMessageButton } from './CopyMessageButton'

export { UserMessage } from './UserMessage'

type MessagePart = StreamMessagePart

export function ChatViewPanel({ children }: { children: ReactNode }) {
  return (
    <div data-chat-view className="relative flex min-h-0 flex-1 flex-col">
      {children}
    </div>
  )
}

export function ChatLoadingSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading conversation"
      className="chat-animate-fade-in flex min-h-[min(28rem,55vh)] items-center justify-center"
    >
      <SessionBusyLoader tone="working" style={{ width: 22, height: 22, gap: 3.5 }} />
    </div>
  )
}

/**
 * What the copy button under a reply copies: the answer text the reader sees, without tool
 * calls, reasoning or hidden parts. A settled turn with collapsed work copies only the answer
 * below it. Empty while the turn streams, so no button shows.
 */
export function assistantCopyText(
  content: string,
  isFinal: boolean | undefined,
  parts: MessagePart[] | undefined,
): string {
  if (isFinal !== true) return ''
  if (!parts?.length) return content.trim()
  const { workParts, finalParts } = partitionSettledTurnParts(parts)
  return (workParts.length > 0 ? finalParts : parts)
    .filter((part) => part.type === 'text' && !part.synthetic && !part.ignored)
    .map((part) => (typeof part.text === 'string' ? part.text.trim() : ''))
    .filter(Boolean)
    .join('\n\n')
}

export function AssistantMessage({
  content,
  isFinal,
  parts,
  runtime,
}: {
  content: string
  isFinal?: boolean
  parts?: MessagePart[]
  runtime?: TurnRuntimeMetadata
}) {
  const hasParts = !!parts && parts.length > 0
  const isStreaming = isFinal === false
  const partition = hasParts && isFinal === true ? partitionSettledTurnParts(parts) : undefined
  const workParts = partition?.workParts ?? []
  const finalParts = partition?.finalParts ?? []
  const hasWorkGroup = workParts.length > 0
  const copyText = assistantCopyText(content, isFinal, parts)

  return (
    <div className="group/assistant py-1">
      <div className={cn(chatStreamInner, isStreaming ? 'opacity-90' : 'opacity-100')}>
        {/* The work group's own label says it once the turn has one. */}
        {runtime?.unprompted && !hasWorkGroup ? (
          <div className="py-px text-ui-base leading-snug text-[var(--basis-text-muted)]">
            {UNPROMPTED_TURN_LABEL}
          </div>
        ) : null}
        {hasWorkGroup ? (
          <>
            <TurnWorkGroup label={settledTurnLabel(runtime)} parts={workParts} />
            {finalParts.length > 0 && <MessageParts parts={finalParts} isStreaming={false} />}
          </>
        ) : hasParts ? (
          <MessageParts parts={parts} isStreaming={isStreaming} />
        ) : (
          <TextPart text={content} />
        )}
        {copyText && (
          <div className="-ml-1.5 mt-1 flex justify-start">
            <CopyMessageButton text={copyText} row="assistant" />
          </div>
        )}
      </div>
    </div>
  )
}
