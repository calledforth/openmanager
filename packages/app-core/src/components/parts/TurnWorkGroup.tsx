import type { StreamMessagePart } from '@openmanager/shared/lib/remote-stream-parts'
import { MessageParts } from './MessageParts'
import { activityDetailsSummary, activityRow } from './ToolLine'

export function TurnWorkGroup({ label, parts }: { label: string; parts: StreamMessagePart[] }) {
  return (
    <details className={`group ${activityRow}`} data-turn-work-group>
      <summary className={activityDetailsSummary}>
        <span className="text-[var(--basis-text-muted)]">{label}</span>
      </summary>
      <div className="mt-0.5" data-turn-work-group-body>
        <MessageParts parts={parts} isStreaming={false} />
      </div>
    </details>
  )
}
