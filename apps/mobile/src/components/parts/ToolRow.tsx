import { memo, useRef, useState } from 'react'
import { ScrollView, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { useToolOutput } from '@openmanager/app-core/logic'
import {
  presentToolPart,
  type ToolOutcome,
  type ToolPartData as SharedToolPartData,
  type ToolPresenterModel,
} from '@openmanager/shared/lib/tool-presenter'

import { usePhoneTheme } from '../../theme/ThemeProvider'
import { Press } from '../../ui/Press'
import { ShimmerText } from '../chat/ShimmerText'
import { AppText } from '../ui/AppText'
import { DisclosureChevron, revealBody } from './Disclosure'
import { getToolIcon } from './toolIcons'

/**
 * A tool call as the shared projection hands it over: the provider's name,
 * its title and kind, what it was given, the files it named, its line counts
 * and times. A running call carries its text so far in `state.output`; a
 * settled one carries only `outputBytes`, and its text is read when the row
 * is opened.
 */
export type ToolPartData = SharedToolPartData & {
  type: 'tool'
  id: string
  callID?: string
  /** Where a settled call's output is read from, and how much of it there is. */
  sessionId?: string
  outputBytes?: number
}

const OUTCOME_LABELS: Record<ToolOutcome, string> = {
  failed: 'Failed',
  declined: 'Declined',
  cancelled: 'Cancelled',
}

/** How tall an opened row's text may grow before it scrolls on its own. */
const BODY_MAX_HEIGHT = 280

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`
  const seconds = ms / 1_000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Whether the row has anything to show when opened. */
export function isExpandable(part: ToolPartData, model: ToolPresenterModel): boolean {
  if (model.expandedText || part.outputBytes) return true
  if (model.files.length > 1) return true
  return (
    model.uiKind === 'terminal' &&
    model.fullDetail !== undefined &&
    model.fullDetail !== model.detail
  )
}

/** What the row says on its right: line counts, how it ended, or how long it ran. */
function RowMeta({ model }: { model: ToolPresenterModel }) {
  const theme = usePhoneTheme()
  const tabular = { fontVariant: ['tabular-nums' as const] }
  return (
    <>
      {model.diffAdds ? (
        <AppText variant="text-12-regular" style={[tabular, { color: theme.status.done }]}>
          +{model.diffAdds}
        </AppText>
      ) : null}
      {model.diffDels ? (
        <AppText variant="text-12-regular" style={[tabular, { color: theme.status.error }]}>
          -{model.diffDels}
        </AppText>
      ) : null}
      {model.outcome ? (
        <AppText
          variant="text-12-regular"
          style={{ color: model.outcome === 'failed' ? theme.status.error : theme.faint }}
        >
          {OUTCOME_LABELS[model.outcome]}
        </AppText>
      ) : !model.isRunning && model.durationMs !== undefined && model.durationMs >= 1_000 ? (
        <AppText variant="text-12-regular" style={[tabular, { color: theme.faint }]}>
          {formatDuration(model.durationMs)}
        </AppText>
      ) : null}
    </>
  )
}

/** The one line a tool call is: what it did, to what, and how that went. */
function RowLine({
  part,
  model,
  open,
}: {
  part: ToolPartData
  model: ToolPresenterModel
  /** Undefined for a row with nothing to open. */
  open?: boolean
}) {
  const theme = usePhoneTheme()
  const Icon = getToolIcon(part, model.uiKind)
  const failed = model.outcome === 'failed'
  // A refused or cut-off call did not do what it set out to: it reads quieter.
  const quiet = model.outcome === 'declined' || model.outcome === 'cancelled'
  const said = `${model.verb}${model.detail ? ` ${model.detail}` : ''}`
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 20 }}>
      <Icon size={13} color={failed ? theme.status.error : theme.faint} />
      <View style={{ flex: 1, minWidth: 0, opacity: quiet ? 0.6 : 1 }}>
        {model.isRunning ? (
          <ShimmerText variant="text-13-regular" numberOfLines={1}>
            {said}
          </ShimmerText>
        ) : (
          <AppText variant="text-13-regular" numberOfLines={1} style={{ color: theme.muted }}>
            {model.verb}
            {model.detail ? (
              <AppText
                variant={model.detailIsCode ? 'mono' : 'text-13-regular'}
                style={{ color: failed ? theme.status.error : theme.fg }}
              >
                {` ${model.detail}`}
              </AppText>
            ) : null}
          </AppText>
        )}
      </View>
      <RowMeta model={model} />
      {open !== undefined ? <DisclosureChevron open={open} color={theme.faint} size={10} /> : null}
    </View>
  )
}

/** A block of text on a fill, scrolling on its own past a few hundred points. */
function Body({ children, color }: { children: string; color?: string }) {
  const theme = usePhoneTheme()
  return (
    <View
      style={{
        borderRadius: 8,
        backgroundColor: theme.active,
        paddingHorizontal: 10,
        paddingVertical: 8,
        maxHeight: BODY_MAX_HEIGHT,
      }}
    >
      <ScrollView nestedScrollEnabled showsVerticalScrollIndicator={false}>
        <AppText variant="tool-output" selectable style={{ color: color ?? theme.muted }}>
          {children}
        </AppText>
      </ScrollView>
    </View>
  )
}

/** What opening the row shows. Mounted only while open, so a shut row reads nothing. */
function RowDetails({ part, model }: { part: ToolPartData; model: ToolPresenterModel }) {
  const theme = usePhoneTheme()
  const running = model.expandedText
  // Text the view already has (a running tool's) needs no read.
  const target =
    running === undefined && part.sessionId && part.outputBytes
      ? { sessionId: part.sessionId, toolCallId: part.callID ?? part.id }
      : undefined
  const { read, retry } = useToolOutput(target)
  // The settle takes the running text out of the store. What this open row was
  // showing stays until the whole text arrives: view state, nothing more.
  const [last, setLast] = useState(running)
  if (running !== undefined && running !== last) setLast(running)
  const shown = running ?? (read.state === 'ready' ? read.text : undefined)
  const held = read.state === 'failed' ? undefined : last
  const text = shown ?? held
  const lead =
    model.uiKind === 'terminal' && model.fullDetail && model.fullDetail !== model.detail
      ? model.fullDetail
      : undefined
  const files = model.files.length > 1 ? model.files : []

  return (
    <View style={{ paddingLeft: 21, paddingTop: 6, gap: 6 }}>
      {lead ? <Body color={theme.fg}>{lead}</Body> : null}
      {files.length > 0 ? <Body>{files.join('\n')}</Body> : null}
      {text !== undefined ? (
        <Body color={model.outcome === 'failed' ? theme.status.error : undefined}>
          {text || '(no output)'}
        </Body>
      ) : read.state === 'failed' ? (
        <View
          style={{
            borderRadius: 8,
            backgroundColor: theme.active,
            paddingHorizontal: 10,
            paddingVertical: 8,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <AppText variant="text-12-regular" style={{ color: theme.muted, flex: 1 }}>
            The output could not be read.
          </AppText>
          <Press
            accessibilityRole="button"
            onPress={retry}
            hitSlop={8}
            style={({ pressed }) => ({
              borderRadius: 6,
              paddingHorizontal: 8,
              paddingVertical: 3,
              backgroundColor: pressed ? theme.hover : 'transparent',
            })}
          >
            <AppText variant="text-12-medium" style={{ color: theme.fg }}>
              Try again
            </AppText>
          </Press>
        </View>
      ) : read.state === 'loading' ? (
        <View
          style={{
            borderRadius: 8,
            backgroundColor: theme.active,
            paddingHorizontal: 10,
            paddingVertical: 8,
          }}
        >
          <ShimmerText variant="text-12-regular">
            {`Reading ${part.outputBytes ? formatBytes(part.outputBytes) : 'output'}`}
          </ShimmerText>
        </View>
      ) : null}
    </View>
  )
}

/**
 * Every tool call's row, read from what the call was given (shared with web
 * through `presentToolPart`), so it says what happened before any output is
 * fetched: the tool's glyph, "Ran `pnpm test`", line counts, and how it
 * ended (Failed, Declined, Cancelled) or how long it ran. A row with more to
 * show opens on a tap; a settled call's output is read from the environment
 * only then. The reader's tap is the only thing that opens it, and only then
 * does the body fade in.
 */
export const ToolRow = memo(function ToolRow({ part }: { part: ToolPartData }) {
  const model = presentToolPart(part)
  const [open, setOpen] = useState(false)
  const revealedRef = useRef(false)
  const label = `${model.verb} ${model.detail}`.trim()
  const accessibility = model.outcome
    ? `${label}, ${OUTCOME_LABELS[model.outcome].toLowerCase()}`
    : model.isRunning
      ? `${label}, running`
      : label

  if (!isExpandable(part, model)) {
    return (
      <View accessibilityLabel={accessibility}>
        <RowLine part={part} model={model} />
      </View>
    )
  }

  return (
    <View>
      <Press
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={accessibility}
        hitSlop={4}
        onPress={() => {
          revealedRef.current = true
          setOpen((value) => !value)
        }}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      >
        <RowLine part={part} model={model} open={open} />
      </Press>
      {open ? (
        <Animated.View entering={revealedRef.current ? revealBody : undefined}>
          <RowDetails part={part} model={model} />
        </Animated.View>
      ) : null}
    </View>
  )
})
