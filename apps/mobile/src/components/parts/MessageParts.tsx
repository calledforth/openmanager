import { memo, useMemo, type ReactNode } from 'react'
import { View } from 'react-native'
import { groupActivityParts, type ActivitySummary } from '@openmanager/shared/lib/activity-groups'
import type { ArtifactSource, MessagePart } from '@openmanager/app-core/logic'

import { countRender } from '../../session/render-probe'
import { usePhoneTheme } from '../../theme/ThemeProvider'
import { AppText } from '../ui/AppText'
import { ImagePart } from './ImagePart'
import { TextPart } from './TextPart'
import { ThinkingPart } from './ThinkingPart'
import { ToolRow, type ToolPartData } from './ToolRow'
import { toolCallCount, WorkGroup } from './WorkGroup'

// After web's `MessageParts`: parts deduplicated by id, runs of consecutive
// tool calls folded into one work group with web's own summary wording
// (`groupActivityParts`), and every part memoised by identity. The shared
// projection hands an unchanged part back as the same object on every event,
// so a streamed token re-renders the one part it changed.

type Part = MessagePart

function getPartKey(part: Part, index: number): string {
  const callId = (part as { callID?: string }).callID
  if (part.id) return part.id
  if (callId) return callId
  if (part.type === 'tool') return `tool:${String(part.tool ?? 'unknown')}:${index}`
  return `${part.type}:${index}`
}

/** A note the transcript keeps without a row of its own, in the environment's words. */
function NoteRow({ children }: { children: string }) {
  const theme = usePhoneTheme()
  return (
    <AppText variant="text-13-regular" style={{ color: theme.muted, paddingVertical: 2 }}>
      {children}
    </AppText>
  )
}

function renderPart(part: Part, isStreaming: boolean | undefined): ReactNode {
  switch (part.type) {
    case 'text': {
      if (part.synthetic || part.ignored) return null
      return <TextPart text={(part.text as string) ?? ''} />
    }
    case 'tool':
      return <ToolRow part={part as unknown as ToolPartData} />
    case 'image':
      return (
        <View style={{ paddingVertical: 4 }}>
          <ImagePart
            url={typeof part.url === 'string' ? part.url : undefined}
            artifact={part.artifact as ArtifactSource | undefined}
          />
        </View>
      )
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
          text={typeof part.text === 'string' ? part.text : ''}
          tokens={typeof part.tokens === 'number' ? part.tokens : undefined}
          isStreaming={reasoningStreaming}
          duration={
            partTime && typeof partTime.end === 'number' && typeof partTime.start === 'number'
              ? partTime.end - partTime.start
              : undefined
          }
        />
      )
    }
    case 'retry':
      return (
        <NoteRow>
          {`Retrying (attempt ${(part.attempt as number) ?? '?'})${part.error ? `: ${String(part.error)}` : ''}`}
        </NoteRow>
      )
    case 'subtask':
      return (
        <NoteRow>{`Subtask: ${(part.description as string) ?? (part.prompt as string) ?? 'running'}`}</NoteRow>
      )
    case 'compaction':
      return <NoteRow>Session compacted</NoteRow>
    default:
      // Step markers, snapshots and parts the phone does not draw yet.
      return null
  }
}

/** One part, skipped while it is the object it was. */
const PartNode = memo(function PartNode({
  part,
  isStreaming,
}: {
  part: Part
  isStreaming?: boolean
}) {
  countRender('PartNode')
  return renderPart(part, isStreaming)
})

const SUMMARY_FIELDS = [
  'text',
  'runningText',
  'isRunning',
  'toolCount',
] as const satisfies readonly (keyof ActivitySummary)[]

/** Web's summary starts lower-case so it can join other phrases; a label starts a line. */
const sentence = (text: string) => (text ? text[0]!.toUpperCase() + text.slice(1) : text)

/**
 * A run of tool calls as one work group. Grouping builds the run anew on
 * every render, so it is compared by what it holds: a run whose calls and
 * counts are unchanged is left alone, with its rows.
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
    return (
      <WorkGroup
        label={sentence(summary.isRunning ? summary.runningText : summary.text)}
        meta={toolCallCount(summary.toolCount)}
        running={summary.isRunning}
        // A live run shows its calls as they land; a settled one stays folded.
        defaultOpen={!!isStreaming}
      >
        {items.map((item, index) => (
          <PartNode key={getPartKey(item, index)} part={item} isStreaming={isStreaming} />
        ))}
      </WorkGroup>
    )
  },
  (previous, next) =>
    previous.isStreaming === next.isStreaming &&
    previous.items.length === next.items.length &&
    previous.items.every((item, index) => item === next.items[index]) &&
    SUMMARY_FIELDS.every((field) => previous.summary[field] === next.summary[field]),
)

function dedupe(parts: readonly Part[]): Part[] {
  const seen = new Set<string>()
  return parts.filter((part, index) => {
    const id = part.id ?? (part as { callID?: string }).callID ?? getPartKey(part, index)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/**
 * A turn's parts in the order they happened. `flat` lays tool calls out as
 * bare rows (inside a settled turn's own work group, so no fold sits in a
 * fold); otherwise each run of calls is its own work group.
 */
export const MessageParts = memo(function MessageParts({
  parts,
  isStreaming,
  flat = false,
}: {
  parts: readonly Part[]
  isStreaming?: boolean
  flat?: boolean
}) {
  countRender('MessageParts')
  const deduped = useMemo(() => dedupe(parts), [parts])
  const nodes = useMemo(
    () => (flat ? null : groupActivityParts(deduped as Part[])),
    [deduped, flat],
  )

  if (deduped.length === 0) return null

  if (!nodes) {
    return (
      <View style={{ gap: 6 }}>
        {deduped.map((part, index) => (
          <PartNode key={getPartKey(part, index)} part={part} isStreaming={isStreaming} />
        ))}
      </View>
    )
  }

  return (
    <View style={{ gap: 10 }}>
      {nodes.map((node, index) =>
        node.kind === 'part' ? (
          <PartNode key={getPartKey(node.part, index)} part={node.part} isStreaming={isStreaming} />
        ) : (
          <ActivityGroupNode
            key={node.id}
            items={node.items}
            summary={node.summary}
            isStreaming={isStreaming}
          />
        ),
      )}
    </View>
  )
})
