import { memo, useMemo, type ReactNode } from 'react'
import { View } from 'react-native'
import {
  groupActivityParts,
  type ActivityNode,
  type ActivitySummary,
} from '@openmanager/shared/lib/activity-groups'
import type {
  ArtifactSource,
  FailurePart,
  MessagePart,
  NoticePart,
  SubagentPart,
} from '@openmanager/app-core/logic'

import { countRender } from '../../session/render-probe'
import { usePhoneTheme } from '../../theme/ThemeProvider'
import { AppText } from '../ui/AppText'
import { ImageGroup, useTranscriptWidth, type GalleryImage } from './ImageGroup'
import { TextPart } from './TextPart'
import { VideoPart, type TranscriptVideo } from './VideoPart'
import { SubagentCard, SubagentGroup } from './SubagentCard'
import { ThinkingPart } from './ThinkingPart'
import { ToolRow, type ToolPartData } from './ToolRow'
import { TurnFailureRow, TurnNoticeRow } from './TurnNoticeRow'
import { isThoughtStreaming, liveThoughtOf, toolCallCount, workGroupLabel } from './work-groups'
import { WorkGroup } from './WorkGroup'

// After web's `MessageParts`: parts deduplicated by id, runs of consecutive
// tool calls folded into one work group with web's own summary wording
// (`groupActivityParts`) with the thoughts between them folded in where they
// came, runs of consecutive images drawn as one gallery, subagents started
// back to back as one group of cards, and every part memoised by identity.
// The shared projection hands an unchanged part back as the same object on
// every event, so a streamed token re-renders the one part it changed.

type Part = MessagePart

function getPartKey(part: Part, index: number): string {
  const callId = (part as { callID?: string }).callID
  if (part.id) return part.id
  if (callId) return callId
  if (part.type === 'tool') return `tool:${String(part.tool ?? 'unknown')}:${index}`
  return `${part.type}:${index}`
}

/** What an image part shows and how to read it. */
function galleryImage(part: Part): GalleryImage {
  return {
    id: part.id,
    url: typeof part.url === 'string' ? part.url : undefined,
    artifact: part.artifact as ArtifactSource | undefined,
    name: typeof part.name === 'string' ? part.name : undefined,
  }
}

type ImagesRun = { kind: 'images'; key: string; images: GalleryImage[] }
type SubagentsRun = { kind: 'subagents'; key: string; parts: SubagentPart[] }
type Node = ActivityNode<Part> | ImagesRun | SubagentsRun

/**
 * Consecutive images as one gallery rather than a card each, as web draws
 * them: a tool that returns a dozen screenshots does not push the reply
 * apart by a screen per picture. Subagents started back to back fold into
 * one group the same way, a card each when opened; one alone is its card.
 */
function withRuns(nodes: readonly ActivityNode<Part>[]): Node[] {
  const out: Node[] = []
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!
    if (node.kind !== 'part' || (node.part.type !== 'image' && node.part.type !== 'subagent')) {
      out.push(node)
      continue
    }
    const type = node.part.type
    const key = getPartKey(node.part, index)
    const run = [node.part]
    while (index + 1 < nodes.length) {
      const next = nodes[index + 1]!
      if (next.kind !== 'part' || next.part.type !== type) break
      run.push(next.part)
      index += 1
    }
    if (type === 'image') {
      out.push({ kind: 'images', key, images: run.map(galleryImage) })
    } else if (run.length === 1) {
      out.push(node)
    } else {
      out.push({
        kind: 'subagents',
        key: `subagents:${key}`,
        parts: run as unknown as SubagentPart[],
      })
    }
  }
  return out
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

function renderPart(
  part: Part,
  isStreaming: boolean | undefined,
  width: number,
  /** A thought the work has moved past, whatever its own timing says. */
  thoughtSettled?: boolean,
  /** A thought on a work group's branch: its words show as they stream. */
  streamed?: boolean,
): ReactNode {
  switch (part.type) {
    case 'text': {
      if (part.synthetic || part.ignored) return null
      return <TextPart text={(part.text as string) ?? ''} live={!!isStreaming} />
    }
    case 'tool':
      return <ToolRow part={part as unknown as ToolPartData} />
    case 'image':
      // A run of images is gathered into one gallery before it gets here; one
      // on its own is a gallery of one.
      return <ImageGroup images={[galleryImage(part)]} width={width} />
    case 'video':
      return (
        <VideoPart
          video={{
            id: part.id,
            artifact: part.artifact as TranscriptVideo['artifact'],
            name: typeof part.name === 'string' ? part.name : undefined,
          }}
          width={width}
        />
      )
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
          text={typeof part.text === 'string' ? part.text : ''}
          tokens={typeof part.tokens === 'number' ? part.tokens : undefined}
          isStreaming={reasoningStreaming}
          streamed={streamed}
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
    case 'subagent':
      // Several back to back are gathered into one group before they get here.
      return <SubagentCard part={part as unknown as SubagentPart} />
    case 'notice': {
      // What the provider said about the turn: kept with it, or live until
      // the environment clears it.
      const notice = part as unknown as NoticePart
      return <TurnNoticeRow notice={notice.notice} live={notice.live === true} />
    }
    case 'failure':
      return <TurnFailureRow part={part as unknown as FailurePart} />
    default:
      // Step markers, snapshots and parts the phone does not draw yet.
      return null
  }
}

/** One part, skipped while it is the object it was. */
const PartNode = memo(function PartNode({
  part,
  isStreaming,
  thoughtSettled,
  streamed,
}: {
  part: Part
  isStreaming?: boolean
  thoughtSettled?: boolean
  streamed?: boolean
}) {
  countRender('PartNode')
  const width = useTranscriptWidth()
  return renderPart(part, isStreaming, width, thoughtSettled, streamed)
})

/** A run of images as one gallery; the run is rebuilt only when the parts change. */
const ImagesNode = memo(function ImagesNode({ images }: { images: GalleryImage[] }) {
  const width = useTranscriptWidth()
  return <ImageGroup images={images} width={width} />
})

const SUMMARY_FIELDS = [
  'text',
  'runningText',
  'isRunning',
  'toolCount',
  'thoughtCount',
] as const satisfies readonly (keyof ActivitySummary)[]

/**
 * A run of the agent's work as one work group: its tool calls, and the
 * thoughts between them in the order they came. Grouping builds the run anew
 * on every render, so it is compared by what it holds: a run whose members
 * and counts are unchanged is left alone, with its rows.
 *
 * Only the run's last member can be a thought in progress; one the work has
 * moved past reads as had, whatever its provider has yet to say. That live
 * thought hangs under the folded header on its own branch. A run of thoughts
 * alone has no calls to sum up, so each thought is its own row.
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
        isStreaming={isStreaming}
        thoughtSettled={item.type === 'reasoning' && index !== last}
      />
    ))
    if (summary.toolCount === 0) return <>{rows}</>
    const thought = liveThoughtOf(items, summary.toolCount, isStreaming)
    const live = thought ? (
      <PartNode part={thought} isStreaming={isStreaming} streamed />
    ) : undefined
    return (
      // Folded, live or not, as web's: the label rewrites itself as calls
      // land, so the run reads as one updating line, and opening it shows
      // each call and thought in order.
      <WorkGroup
        label={workGroupLabel(summary)}
        meta={toolCallCount(summary.toolCount)}
        running={summary.isRunning}
        live={live}
      >
        {rows}
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
 * fold); otherwise each run of calls is its own work group, the thoughts
 * between them in it. Either way a run of images is one gallery and a run of
 * subagents one group.
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
    () =>
      withRuns(
        flat
          ? deduped.map((part): ActivityNode<Part> => ({ kind: 'part', part }))
          : groupActivityParts(deduped as Part[], { absorbReasoning: true }),
      ),
    [deduped, flat],
  )

  if (deduped.length === 0) return null

  return (
    <View style={{ gap: flat ? 6 : 10 }}>
      {nodes.map((node, index) =>
        node.kind === 'part' ? (
          <PartNode key={getPartKey(node.part, index)} part={node.part} isStreaming={isStreaming} />
        ) : node.kind === 'images' ? (
          <ImagesNode key={node.key} images={node.images} />
        ) : node.kind === 'subagents' ? (
          <SubagentGroup key={node.key} parts={node.parts} />
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
