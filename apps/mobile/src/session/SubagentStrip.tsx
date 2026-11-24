import { CaretDownIcon, SquareIcon } from 'phosphor-react-native'
import { memo, useContext, useState, useSyncExternalStore } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import Animated, { Easing, FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated'
import {
  formatElapsed,
  lineageHeadline,
  lineageNodeDetail,
  lineagePhaseRows,
  subagentElapsedMs,
  subagentStatusLabel,
  useLineagePhase,
  type Lineage,
  type LineageNode,
} from '@openmanager/app-core/logic'

import { AppText } from '../components/ui/AppText'
import {
  OpenChildSessionContext,
  StopSubagentContext,
  useTick,
} from '../components/parts/SubagentCard'
import { usePhoneTheme } from '../theme/ThemeProvider'
import type { PhoneTheme } from '../theme/tokens'
import { Glass } from '../ui/Glass'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { StatusMark } from '../ui/StatusMark'

/**
 * The open chat's subagents while any of them works (web's `SubagentDock`,
 * the strip above its composer), above the status line beside the
 * background work and built like it: one row that says how many work and
 * how many need you, opening upward into the list. A subagent per row,
 * nested ones indented under the one that started them, each opening its
 * session, a live one with its Stop.
 *
 * A subagent started turns ago, whose card has scrolled away, is the reason
 * it exists: without it nothing on screen says it still runs. When the last
 * one finishes the strip says "All N done" for a few seconds, then fades;
 * never while it is open.
 */
export const SubagentStrip = memo(function SubagentStrip({
  subscribe,
  getLineage,
  defaultOpen = false,
}: {
  subscribe: (listener: () => void) => () => void
  /** The session's lineage, the same object while it is the same (`lineageReader`). */
  getLineage: () => Lineage
  /** For tests; the page always starts it folded. */
  defaultOpen?: boolean
}) {
  const lineage = useSyncExternalStore(subscribe, getLineage, getLineage)
  return <SubagentStripView lineage={lineage} defaultOpen={defaultOpen} />
})

const ROW_IN = FadeIn.duration(180).easing(Easing.out(Easing.quad))
const STRIP_OUT = FadeOut.duration(400).easing(Easing.in(Easing.quad))
const GROW = LinearTransition.duration(200).easing(Easing.out(Easing.cubic))

/** How far a nested subagent sits in from the one that started it. */
const INDENT = 14

/** The colour a row's dot is drawn in. */
function toneColor(theme: PhoneTheme, node: Pick<LineageNode, 'tone' | 'waitingOn'>): string {
  switch (node.tone) {
    case 'running':
      return theme.status.working
    case 'waiting':
      return node.waitingOn === 'question' ? theme.status.question : theme.status.needs
    case 'done':
      return theme.status.done
    case 'failed':
      return theme.status.error
    case 'stopped':
      return theme.faint
  }
}

export function SubagentStripView({
  lineage,
  defaultOpen = false,
}: {
  lineage: Lineage
  defaultOpen?: boolean
}) {
  const theme = usePhoneTheme()
  const [open, setOpen] = useState(defaultOpen)
  const [showSettled, setShowSettled] = useState(false)
  // Open, it stays: the list never fades out from under the reader.
  const phase = useLineagePhase(lineage, open)
  const now = useTick(lineage.live.length > 0)
  if (phase.kind === 'idle') return null

  const rows = lineagePhaseRows(lineage, phase, showSettled)
  const headline = lineageHeadline(lineage, phase)
  const done = phase.kind === 'done'
  const waiting = lineage.live.find((node) => node.tone === 'waiting')
  const settledShown = phase.kind === 'live' ? lineage.settled : 0
  const label = done ? headline : `Subagents · ${headline}`

  return (
    <Animated.View
      entering={ROW_IN}
      exiting={STRIP_OUT}
      layout={GROW}
      style={{ alignSelf: open ? 'stretch' : 'flex-start', maxWidth: '100%', paddingHorizontal: 2 }}
      testID="subagent-strip"
    >
      <Glass strength="strong" shadow="rest" radius={16} contentStyle={{ paddingVertical: 2 }}>
        {open ? (
          <View
            accessibilityLabel="Subagents of this chat"
            style={{ paddingTop: 4, paddingBottom: 2 }}
            testID="subagent-strip-list"
          >
            {rows.map(({ node }) => (
              <StripRow key={node.key} node={node} now={now} />
            ))}
            {settledShown > 0 ? (
              <Press
                accessibilityRole="button"
                onPress={() => setShowSettled((value) => !value)}
                style={{
                  alignSelf: 'flex-start',
                  paddingLeft: 12,
                  paddingRight: 12,
                  minHeight: 28,
                  justifyContent: 'center',
                }}
              >
                <AppText variant="text-11-regular" style={{ color: theme.faint }}>
                  {showSettled ? 'Hide done' : `${settledShown} done`}
                </AppText>
              </Press>
            ) : null}
          </View>
        ) : null}
        <Press
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={label}
          onPress={() => {
            tap()
            setOpen((value) => !value)
          }}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            minHeight: 32,
            paddingLeft: 11,
            paddingRight: 12,
          }}
          testID="subagent-strip-toggle"
        >
          <StatusMark
            mark={
              done
                ? headline.includes('failed')
                  ? 'error'
                  : 'done'
                : waiting
                  ? waiting.waitingOn === 'question'
                    ? 'question'
                    : 'needs'
                  : 'working'
            }
            size={12}
          />
          <AppText
            variant="text-12-medium"
            numberOfLines={1}
            style={{ color: theme.fg, flexShrink: 1 }}
          >
            {label}
          </AppText>
          <CaretDownIcon
            size={11}
            color={theme.faint}
            weight="bold"
            style={{ transform: [{ rotate: open ? '0deg' : '180deg' }] }}
          />
        </Press>
      </Glass>
    </Animated.View>
  )
}

/**
 * One subagent: a dot in its colour, its title, how long it has run, and,
 * while it works, waits or after it failed, a line saying what it is doing,
 * waits on, or why. A tap opens its session; a live one has its Stop.
 */
function StripRow({ node, now }: { node: LineageNode; now: number }) {
  const theme = usePhoneTheme()
  const openChild = useContext(OpenChildSessionContext)
  const stopSubagent = useContext(StopSubagentContext)
  const [stopping, setStopping] = useState(false)
  const [failed, setFailed] = useState(false)
  const record = node.subagent
  const self = node.tone === 'running' || node.tone === 'waiting'
  const sessionId = node.sessionId
  const open = sessionId && openChild ? () => openChild(sessionId) : undefined
  const stop = self && record?.stoppable && stopSubagent ? () => stopSubagent(record) : undefined
  const elapsed = record ? subagentElapsedMs(record, now) : undefined
  const detail = lineageNodeDetail(node)
  const pad = 12 + (node.depth - 1) * INDENT
  const status = subagentStatusLabel({ status: node.status })
  const flagged = node.tone === 'waiting' || node.tone === 'failed'
  const run = () => {
    if (!stop || stopping) return
    tap()
    setFailed(false)
    setStopping(true)
    stop().catch(() => {
      setFailed(true)
      setStopping(false)
    })
  }
  // The row and its Stop are siblings, not one inside the other: a button
  // in a button is no button on the web, and VoiceOver reaches each.
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', paddingRight: stop ? 4 : 0 }}
      testID={`subagent-strip-row:${node.key}`}
    >
      <Press
        accessibilityRole={open ? 'button' : undefined}
        accessibilityLabel={[node.title, status, detail].filter(Boolean).join(', ')}
        accessibilityActions={
          stop && !stopping ? [{ name: 'stop', label: `Stop ${node.title}` }] : undefined
        }
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'stop') run()
        }}
        disabled={!open}
        onPress={
          open
            ? () => {
                tap()
                open()
              }
            : undefined
        }
        style={({ pressed }) => ({
          flex: 1,
          minWidth: 0,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          minHeight: 32,
          paddingVertical: 4,
          paddingLeft: pad,
          paddingRight: stop ? 4 : 12,
          backgroundColor: pressed && open ? theme.active : 'transparent',
        })}
        testID={`subagent-strip-open:${node.key}`}
      >
        {node.depth > 1 ? (
          <View
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: pad - INDENT + 3,
              width: StyleSheet.hairlineWidth,
              backgroundColor: theme.border,
            }}
          />
        ) : null}
        <View
          style={{
            alignSelf: 'flex-start',
            marginTop: 6,
            width: 7,
            height: 7,
            borderRadius: 4,
            backgroundColor: toneColor(theme, node),
            opacity: self ? 1 : 0.55,
          }}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText
            variant="text-12-medium"
            numberOfLines={1}
            style={{ color: self ? theme.fg : theme.muted }}
          >
            {node.title}
          </AppText>
          {detail || failed ? (
            <AppText
              variant="text-11-regular"
              numberOfLines={1}
              style={{
                color: failed ? theme.status.error : flagged ? toneColor(theme, node) : theme.muted,
              }}
            >
              {failed ? 'Couldn’t stop it' : detail}
            </AppText>
          ) : null}
        </View>
        {elapsed !== undefined ? (
          <AppText
            variant="text-11-regular"
            style={{ color: theme.faint, fontVariant: ['tabular-nums'] }}
          >
            {formatElapsed(elapsed)}
          </AppText>
        ) : null}
      </Press>
      {stop ? (
        <Press
          accessibilityRole="button"
          accessibilityLabel={stopping ? 'Stopping…' : `Stop ${node.title}`}
          accessibilityState={{ busy: stopping, disabled: stopping }}
          disabled={stopping}
          hitSlop={6}
          onPress={run}
          style={({ pressed }) => ({
            width: 26,
            height: 26,
            borderRadius: 13,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? theme.active : 'transparent',
          })}
          testID="subagent-strip-stop"
        >
          {stopping ? (
            <ActivityIndicator
              size="small"
              color={theme.muted}
              style={{ transform: [{ scale: 0.7 }] }}
            />
          ) : (
            <SquareIcon size={10} color={failed ? theme.status.error : theme.muted} weight="fill" />
          )}
        </Press>
      ) : null}
    </View>
  )
}
