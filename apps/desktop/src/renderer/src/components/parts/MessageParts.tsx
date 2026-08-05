import { Fragment, useMemo, type ReactNode } from 'react'
import type { PlanEntry, PlanEntryStatus } from '@agentpack/contract'
import { groupActivityParts } from '@openmanager/shared/lib/activity-groups'
import { TextPart } from './TextPart'
import { ToolCallPermission } from '../permissions/InlinePermissionPrompt'
import { usePermissionStateOptional } from '../../providers/permission-provider'
import { ToolCallPart } from './ToolCallPart'
import { BashToolPart } from './BashToolPart'
import { EditToolPart } from './EditToolPart'
import { ThinkingPart } from './ThinkingPart'
import { ActivityGroup } from './ActivityGroup'
import { SubtaskCard } from './SubtaskCard'
import { canonicalizeToolName } from './ToolRegistry'

interface Part {
  type: string
  id: string
  [key: string]: unknown
}

function getPartKey(part: Part, index: number): string {
  const callId = (part as { callID?: string }).callID
  if (part.id) return part.id
  if (callId) return callId
  if (part.type === 'tool') {
    return `tool:${String(part.tool ?? 'unknown')}:${index}`
  }
  return `${part.type}:${index}`
}

function PlanStatusGlyph({ status }: { status: PlanEntryStatus }) {
  if (status === 'completed') return <span className="text-[#22c55e]">✓</span>
  if (status === 'in_progress') return <span className="text-[var(--basis-text)]">●</span>
  return <span className="text-[var(--basis-text-faint)]">○</span>
}

/** Compact, read-only plan checklist — the persisted/live per-turn plan part. */
function PlanChecklistPart({ entries }: { entries: PlanEntry[] }) {
  if (entries.length === 0) return null
  return (
    <div className="my-1 rounded-[var(--basis-chat-shell-radius)] border border-[var(--basis-border-muted)] bg-[var(--basis-surface)] px-3 py-2">
      <div className="mb-1 text-ui-2xs uppercase tracking-[0.12em] text-[var(--basis-text-faint)]">
        Plan
      </div>
      <ul className="flex flex-col gap-0.5">
        {entries.map((entry, idx) => (
          <li key={idx} className="flex items-start gap-2 text-ui-xs leading-ui-normal">
            <span className="mt-px w-3 shrink-0 text-center leading-none">
              <PlanStatusGlyph status={entry.status} />
            </span>
            <span
              className={
                entry.status === 'in_progress'
                  ? 'text-[var(--basis-text)]'
                  : 'text-[var(--basis-text-muted)]'
              }
            >
              {entry.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function FallbackPart({ part }: { part: Part }) {
  if (
    part.type === 'step-start' ||
    part.type === 'snapshot' ||
    part.type === 'agent' ||
    part.type === 'step-finish'
  ) {
    return null
  }
  return (
    <div className="text-ui-xs text-[var(--basis-text-muted)] py-0.5 italic">
      {part.type}
      {(part as Record<string, unknown>).tool ? `: ${(part as Record<string, unknown>).tool}` : ''}
    </div>
  )
}

function renderPart(part: Part, index: number, isStreaming?: boolean): ReactNode {
  const key = getPartKey(part, index)

  switch (part.type) {
    case 'text': {
      const text = (part.text as string) ?? ''
      if (part.synthetic || part.ignored) return null
      return <TextPart key={key} text={text} />
    }
    case 'tool': {
      const toolName = canonicalizeToolName((part.tool as string) ?? '')
      const callID = (part as { callID?: string }).callID
      let toolElement: ReactNode
      if (toolName === 'Bash') {
        toolElement = <BashToolPart part={part as Parameters<typeof BashToolPart>[0]['part']} />
      } else if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
        toolElement = <EditToolPart part={part as Parameters<typeof EditToolPart>[0]['part']} />
      } else {
        toolElement = <ToolCallPart part={part as Parameters<typeof ToolCallPart>[0]['part']} />
      }
      return (
        <Fragment key={key}>
          {toolElement}
          <ToolCallPermission callID={callID} />
        </Fragment>
      )
    }
    case 'reasoning': {
      const partTime =
        part.time && typeof part.time === 'object'
          ? (part.time as Record<string, number>)
          : undefined
      const reasoningStreaming = partTime ? typeof partTime.end !== 'number' : !!isStreaming
      // Old persisted parts are `{text, time}` and new ones may be
      // `{tokens, time}` with no text at all; both must render forever, so the
      // shape of the part decides what is passed down — never the provider id.
      return (
        <ThinkingPart
          key={key}
          text={typeof part.text === 'string' ? part.text : ''}
          tokens={typeof part.tokens === 'number' ? part.tokens : undefined}
          isStreaming={reasoningStreaming}
          duration={
            partTime ? (partTime.end ?? Date.now()) - (partTime.start ?? Date.now()) : undefined
          }
        />
      )
    }
    case 'retry':
      return (
        <div key={key} className="py-0.5 text-ui-xs text-amber-500/90">
          Retrying (attempt {(part.attempt as number) ?? '?'}){part.error ? `: ${part.error}` : ''}
        </div>
      )
    case 'subtask':
      return <SubtaskCard key={key} part={part as Parameters<typeof SubtaskCard>[0]['part']} />
    case 'compaction':
      return (
        <div key={key} className="py-0.5 text-ui-xs italic text-[var(--basis-text-muted)]">
          Session compacted
        </div>
      )
    case 'plan': {
      const entries = Array.isArray(part.entries) ? (part.entries as PlanEntry[]) : []
      return <PlanChecklistPart key={key} entries={entries} />
    }
    default:
      return <FallbackPart key={key} part={part} />
  }
}

export function MessageParts({ parts, isStreaming }: { parts: Part[]; isStreaming?: boolean }) {
  const safeParts = parts ?? []
  const pendingPermissionCallId =
    usePermissionStateOptional()?.pendingPermission?.toolCallId ?? null

  const deduped = useMemo(() => {
    const seen = new Set<string>()
    return safeParts.filter((part, index) => {
      const id = part.id ?? (part as { callID?: string }).callID ?? getPartKey(part, index)
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
  }, [safeParts])

  // Runs of consecutive tool calls collapse into one summary row; thinking,
  // text, plans, failures and permission prompts break the run. Each group is
  // its own toggle, so the turn needs no second collapse wrapped around them.
  const activityNodes = useMemo(
    () => groupActivityParts(deduped, { pendingPermissionCallId }),
    [deduped, pendingPermissionCallId],
  )

  if (safeParts.length === 0) return null

  return (
    <>
      {activityNodes.map((node, idx) =>
        node.kind === 'part' ? (
          renderPart(node.part, idx, isStreaming)
        ) : (
          <ActivityGroup key={node.id} summary={node.summary}>
            {node.items.map((item, itemIdx) => renderPart(item, itemIdx, isStreaming))}
          </ActivityGroup>
        ),
      )}
    </>
  )
}
