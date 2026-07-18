import { useState } from 'react'
import { ScrollView, TouchableOpacity, View } from 'react-native'

import { presentToolPart } from '@openmanager/shared/lib/tool-presenter'

import { useTokens } from '../../theme/useTokens'
import { AppText } from '../ui/AppText'
import { ShimmerText } from '../chat/ShimmerText'
import { getToolIcon } from './toolIcons'

interface ToolPartData {
  type: 'tool'
  id: string
  tool?: string
  callID?: string
  state?: {
    type?: string
    status?: string
    input?: unknown
    output?: string
    title?: string
    error?: string
  }
}

// Mirror of the desktop tool rows (`ToolCallPart` / `ToolLine`): a single-line
// icon + verb + detail from the shared `tool-presenter`. Running rows shimmer,
// errored rows take a destructive tint, and rows with output expand to a
// scrollable, capped mono panel.

export function ToolRow({ part }: { part: ToolPartData }) {
  const tokens = useTokens()
  const [expanded, setExpanded] = useState(false)
  const model = presentToolPart(part)
  const Icon = getToolIcon(part.tool ?? '')

  const iconColor = model.isError
    ? tokens.destructive
    : model.isRunning
      ? tokens.textMuted
      : tokens.textFaint

  const detail = model.detail?.trim()
  const label = detail ? `${model.verb} ${detail}` : model.verb
  const hasOutput = !!model.expandedText

  const line = (
    <View className="flex-row items-center gap-1.5">
      <Icon size={13} color={iconColor} />
      {model.isRunning ? (
        <ShimmerText variant="text-14-regular" className="flex-1">
          {label}
        </ShimmerText>
      ) : (
        <AppText
          variant="text-14-regular"
          numberOfLines={expanded ? undefined : 1}
          className={`flex-1 ${model.isError ? 'text-destructive' : 'text-textMuted'}`}
        >
          <AppText
            variant="text-14-regular"
            className={model.isError ? 'text-destructive' : 'text-textMuted'}
          >
            {model.verb}
          </AppText>
          {detail ? (
            <AppText
              variant="text-14-regular"
              className={model.isError ? 'text-destructive' : 'text-textFaint'}
            >
              {' '}
              {detail}
            </AppText>
          ) : null}
        </AppText>
      )}
    </View>
  )

  if (!hasOutput) {
    return <View className="py-px">{line}</View>
  }

  return (
    <View className="py-px">
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => setExpanded((prev) => !prev)}
        hitSlop={6}
      >
        {line}
      </TouchableOpacity>
      {expanded ? (
        <ScrollView
          style={{ maxHeight: 260 }}
          className="mt-1 rounded border border-borderMuted bg-surface"
          contentContainerStyle={{ padding: 10 }}
          nestedScrollEnabled
        >
          <AppText variant="mono" className="text-textMuted" selectable>
            {model.expandedText}
          </AppText>
        </ScrollView>
      ) : null}
    </View>
  )
}
