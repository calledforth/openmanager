import { InfoIcon } from 'phosphor-react-native'
import { memo, useMemo } from 'react'
import { View } from 'react-native'
import {
  partitionSettledTurnParts,
  settledTurnLabel,
  UNPROMPTED_TURN_LABEL,
  type MessagePart,
  type TurnRuntimeMetadata,
} from '@openmanager/app-core/logic'

import { usePhoneTheme } from '../../theme/ThemeProvider'
import { MessageParts } from '../parts/MessageParts'
import { TextPart } from '../parts/TextPart'
import { toolCallCount, WorkGroup } from '../parts/WorkGroup'
import { AppText } from '../ui/AppText'
import { ShimmerText } from './ShimmerText'

/**
 * What the environment noted about the turn, in its own words, until the
 * rich notice rows arrive.
 */
function NoticeRows({ notices }: { notices: readonly string[] }) {
  const theme = usePhoneTheme()
  return (
    <View style={{ gap: 4 }}>
      {notices.map((notice, index) => (
        <View key={index} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
          <View style={{ paddingTop: 3 }}>
            <InfoIcon size={13} color={theme.faint} />
          </View>
          <AppText variant="text-13-regular" style={{ color: theme.muted, flex: 1 }}>
            {notice}
          </AppText>
        </View>
      ))}
    </View>
  )
}

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
  notices,
}: {
  content: string
  isFinal?: boolean
  parts?: readonly MessagePart[]
  runtime?: TurnRuntimeMetadata
  notices?: readonly string[]
}) {
  const theme = usePhoneTheme()
  const hasParts = !!parts && parts.length > 0
  const isStreaming = isFinal !== true
  const partition = useMemo(
    () => (hasParts && !isStreaming ? partitionSettledTurnParts(parts) : undefined),
    [hasParts, isStreaming, parts],
  )
  const workParts = partition?.workParts ?? []
  const finalParts = partition?.finalParts ?? []
  const toolCount = workParts.filter((part) => part.type === 'tool').length
  const noted = notices && notices.length > 0 ? <NoticeRows notices={notices} /> : null

  if (!hasParts && !content) {
    if (isStreaming) {
      return (
        <View style={{ gap: 8 }}>
          <ShimmerText variant="text-14-regular">Working…</ShimmerText>
          {noted}
        </View>
      )
    }
    return noted
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
      {noted}
    </View>
  )
})
