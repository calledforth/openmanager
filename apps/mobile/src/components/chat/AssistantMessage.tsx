import { memo, useMemo, useState } from 'react'
import { View } from 'react-native'
import {
  settledTurnLabel,
  UNPROMPTED_TURN_LABEL,
  type MessagePart,
  type TurnRuntimeMetadata,
} from '@openmanager/app-core/logic'

import { usePhoneTheme } from '../../theme/ThemeProvider'
import { MessageParts } from '../parts/MessageParts'
import { TextPart } from '../parts/TextPart'
import { foldSettledTurn, toolCallCount, turnLayout } from '../parts/work-groups'
import { WorkGroup } from '../parts/WorkGroup'
import { AppText } from '../ui/AppText'
import { ShimmerText } from './ShimmerText'

const NO_PARTS: readonly MessagePart[] = []

/**
 * A full-width assistant turn, as web's `AssistantMessage` lays it out. While
 * it runs: its parts in the order they happened, runs of tools as work
 * groups showing their calls, a "Working" shimmer until anything arrives.
 * Settled: everything before the answer folds into one work group labelled
 * with how long the turn took ("Worked for 14s"), and the answer follows.
 */
export const AssistantMessage = memo(function AssistantMessage({
  content,
  isFinal,
  parts,
  runtime,
}: {
  content: string
  isFinal?: boolean
  parts?: readonly MessagePart[]
  runtime?: TurnRuntimeMetadata
}) {
  const theme = usePhoneTheme()
  const hasParts = !!parts && parts.length > 0
  const isStreaming = isFinal !== true
  // Whether this row was live when it mounted: a reply watched as it
  // streamed settles in place rather than re-folding under the reader.
  const [watchedLive] = useState(isStreaming)
  const folded = turnLayout({ streaming: isStreaming, watchedLive }) === 'folded'
  const fold = useMemo(
    () => (hasParts && folded ? foldSettledTurn(parts) : undefined),
    [folded, hasParts, parts],
  )
  const workParts = fold?.work ?? NO_PARTS
  const finalParts = fold?.answer ?? NO_PARTS
  const toolCount = fold?.toolCount ?? 0

  if (!hasParts && !content) {
    if (isStreaming) {
      return <ShimmerText variant="text-14-regular">Working…</ShimmerText>
    }
    return null
  }

  return (
    <View style={{ gap: 10 }}>
      {/* The work group's own label says it once the turn has one. */}
      {runtime?.unprompted && workParts.length === 0 ? (
        <AppText variant="text-13-regular" style={{ color: theme.muted }}>
          {UNPROMPTED_TURN_LABEL}
        </AppText>
      ) : null}
      {workParts.length > 0 ? (
        <>
          <WorkGroup
            label={settledTurnLabel(runtime)}
            meta={toolCount > 0 ? toolCallCount(toolCount) : undefined}
          >
            <MessageParts parts={workParts} isStreaming={false} flat />
          </WorkGroup>
          {finalParts.length > 0 ? <MessageParts parts={finalParts} isStreaming={false} /> : null}
        </>
      ) : hasParts ? (
        <MessageParts parts={parts} isStreaming={isStreaming} />
      ) : (
        <TextPart text={content} live={isStreaming} />
      )}
    </View>
  )
})
