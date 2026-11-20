import { Fragment, memo, useMemo, type ReactNode } from 'react'
import { groupActivityParts, type ActivitySummary } from '@openmanager/shared/lib/activity-groups'
import { TextPart } from './TextPart'
import { FindingsCard } from './FindingsCard'
import { ToolCallPermission } from '../permissions/InlinePermissionPrompt'
import { usePermissionStateOptional } from '../../providers/permission-provider'
import { ToolRow, type ToolRowPart } from './ToolRow'
import { ThinkingPart } from './ThinkingPart'
import { ActivityGroup } from './ActivityGroup'
import { SubtaskCard } from './SubtaskCard'
import { SubagentCard, SubagentGroup } from './SubagentCard'
import type { SubagentPart } from './subagent-card'
import { resolveTool } from '@openmanager/shared/lib/tool-presenter'
import { AskedQuestionPart } from '../questions/AskedQuestionPart'
import { readAskedQuestions } from '../questions/askedQuestion'
import { ImageGenerationToolPart } from './ImageGenerationToolPart'
import { GeneratedImages } from './GeneratedImagePart'
import { GeneratedVideoPart } from './GeneratedVideoPart'
import { TurnFailurePart, TurnMovedPart, TurnNoticePart } from './TurnNoticePart'
import { noticeMove, type FailurePart, type NoticePart } from '../../lib/turn-notice-parts'

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

/** Whether a thought is still being had: an open one has no end time. */
function isThoughtStreaming(part: Part, isStreaming?: boolean): boolean {
  const partTime =
    part.time && typeof part.time === 'object' ? (part.time as Record<string, number>) : undefined
  return partTime ? typeof partTime.end !== 'number' : !!isStreaming
}

function renderPart(
  part: Part,
  index: number,
  isStreaming?: boolean,
  /** A thought the work has moved past, whatever its own timing says. */
  thoughtSettled?: boolean,
): ReactNode {
  const key = getPartKey(part, index)

  switch (part.type) {
    case 'text': {
      const text = (part.text as string) ?? ''
      if (part.synthetic || part.ignored) return null
      if (part.findings === true) return <FindingsCard key={key} text={text} />
      return <TextPart key={key} text={text} />
    }
    case 'tool': {
      const toolName = resolveTool(part as ToolRowPart).canonical
      const callID = (part as { callID?: string }).callID
      let toolElement: ReactNode
      const asked = toolName === 'AskUserQuestion' ? readAskedQuestions(part.state) : null
      if (toolName === 'GenerateImage') {
        toolElement = (
          <ImageGenerationToolPart
            part={part as Parameters<typeof ImageGenerationToolPart>[0]['part']}
          />
        )
      } else if (asked) {
        toolElement = <AskedQuestionPart questions={asked} />
      } else {
        toolElement = <ToolRow part={part as ToolRowPart} />
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
      const reasoningStreaming = !thoughtSettled && isThoughtStreaming(part, isStreaming)
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
    case 'image':
      return (
        <GeneratedImages
          key={key}
          parts={[part as Parameters<typeof GeneratedImages>[0]['parts'][number]]}
        />
      )
    case 'video':
      return (
        <GeneratedVideoPart
          key={key}
          part={part as Parameters<typeof GeneratedVideoPart>[0]['part']}
        />
      )
    case 'retry':
      return (
        <div key={key} className="py-0.5 text-ui-xs text-amber-500/90">
          Retrying (attempt {(part.attempt as number) ?? '?'}){part.error ? `: ${part.error}` : ''}
        </div>
      )
    case 'subtask':
      return <SubtaskCard key={key} part={part as Parameters<typeof SubtaskCard>[0]['part']} />
    case 'subagent':
      return <SubagentCard key={key} part={part as unknown as SubagentPart} className="my-1.5" />
    case 'compaction':
      return (
        <div key={key} className="py-0.5 text-ui-xs italic text-[var(--basis-text-muted)]">
          Session compacted
        </div>
      )
    case 'notice': {
      const notice = part as unknown as NoticePart
      const move = noticeMove(notice.notice)
      if (move) return <TurnMovedPart key={key} move={move} />
      return <TurnNoticePart key={key} notice={notice.notice} live={notice.live === true} />
    }
    case 'failure':
      return <TurnFailurePart key={key} part={part as unknown as FailurePart} />
    case 'plan':
      // Live checklist lives on the composer (`ComposerTodos`), not in the transcript.
      return null
    default:
      return <FallbackPart key={key} part={part} />
  }
}

/**
 * One part of a turn. A live turn is rendered again for every event it
 * receives, and each event changes one part; the rest are the objects they
 * were, so they skip here instead of rebuilding their rows.
 */
const PartNode = memo(function PartNode({
  part,
  index,
  isStreaming,
  thoughtSettled,
}: {
  part: Part
  index: number
  isStreaming?: boolean
  thoughtSettled?: boolean
}) {
  return renderPart(part, index, isStreaming, thoughtSettled)
})

const SUMMARY_FIELDS = [
  'text',
  'runningText',
  'diffAdded',
  'diffRemoved',
  'isRunning',
  'toolCount',
  'thoughtCount',
] as const satisfies readonly (keyof ActivitySummary)[]

/**
 * A run of the agent's work under its summary line: tool calls, and the
 * thoughts between them in the order they came. Grouping builds the run and
 * its summary anew on every render, so they are compared by what they hold: a
 * run whose members and counts are unchanged is left alone, along with its
 * rows.
 *
 * Only the run's last member can be a thought in progress; one the work has
 * moved past reads as had, whatever its provider has yet to say. A run of
 * thoughts alone (one that ends in text) has no calls to sum up, so each
 * thought is its own row.
 */
const ActivityGroupNode = memo(
  function ActivityGroupNode({
    items,
    summary,
    isStreaming,
  }: {
    items: Part[]
    summary: ActivitySummary
    isStreaming?: boolean
  }) {
    const last = items.length - 1
    const rows = items.map((item, index) => (
      <PartNode
        key={getPartKey(item, index)}
        part={item}
        index={index}
        isStreaming={isStreaming}
        thoughtSettled={item.type === 'reasoning' && index !== last}
      />
    ))
    if (summary.toolCount === 0) return <>{rows}</>
    const tail = items[last]
    const live =
      tail?.type === 'reasoning' && isThoughtStreaming(tail, isStreaming) ? (
        <PartNode part={tail} index={last} isStreaming={isStreaming} />
      ) : undefined
    return (
      <ActivityGroup summary={summary} live={live}>
        {rows}
      </ActivityGroup>
    )
  },
  (previous, next) =>
    previous.isStreaming === next.isStreaming &&
    previous.items.length === next.items.length &&
    previous.items.every((item, index) => item === next.items[index]) &&
    SUMMARY_FIELDS.every((field) => previous.summary[field] === next.summary[field]),
)

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

  // Runs of consecutive tool calls collapse into one summary row, the
  // thoughts between them folded in where they came; text, plans, failures
  // and permission prompts break the run. Each group is its own toggle, so
  // the turn needs no second collapse wrapped around them.
  const activityNodes = useMemo(
    () => groupActivityParts(deduped, { pendingPermissionCallId, absorbReasoning: true }),
    [deduped, pendingPermissionCallId],
  )

  if (safeParts.length === 0) return null

  // Consecutive images render as one gallery rather than a card each.
  const rendered: ReactNode[] = []
  for (let idx = 0; idx < activityNodes.length; idx++) {
    const node = activityNodes[idx]
    if (node.kind === 'part' && node.part.type === 'image') {
      const start = idx
      const run: Part[] = [node.part]
      while (idx + 1 < activityNodes.length) {
        const next = activityNodes[idx + 1]
        if (next.kind !== 'part' || next.part.type !== 'image') break
        run.push(next.part)
        idx++
      }
      rendered.push(
        <GeneratedImages
          key={getPartKey(run[0], start)}
          parts={run as unknown as Parameters<typeof GeneratedImages>[0]['parts']}
        />,
      )
      continue
    }
    // Subagents started back to back fold into one group, a card each when opened.
    if (node.kind === 'part' && node.part.type === 'subagent') {
      const start = idx
      const run: Part[] = [node.part]
      while (idx + 1 < activityNodes.length) {
        const next = activityNodes[idx + 1]
        if (next.kind !== 'part' || next.part.type !== 'subagent') break
        run.push(next.part)
        idx++
      }
      rendered.push(
        run.length === 1 ? (
          <PartNode key={getPartKey(run[0], start)} part={run[0]} index={start} />
        ) : (
          <SubagentGroup
            key={`subagents:${getPartKey(run[0], start)}`}
            parts={run as unknown as SubagentPart[]}
          />
        ),
      )
      continue
    }
    rendered.push(
      node.kind === 'part' ? (
        <PartNode
          key={getPartKey(node.part, idx)}
          part={node.part}
          index={idx}
          isStreaming={isStreaming}
        />
      ) : (
        <ActivityGroupNode
          key={node.id}
          items={node.items}
          summary={node.summary}
          isStreaming={isStreaming}
        />
      ),
    )
  }

  return <>{rendered}</>
}
