import {
  CloudSlashIcon,
  ImageIcon,
  PaperPlaneTiltIcon,
  PencilSimpleLineIcon,
  TrashIcon,
} from 'phosphor-react-native'
import { useRef } from 'react'
import { View } from 'react-native'
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable'

import { AppText } from '../components/ui/AppText'
import type { HomeDraftRow } from '../home/rows'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { ProjectChip } from './ProjectChip'
import { ProviderMark } from './ProviderMark'
import { shortAge } from './SessionRow'
import { tap } from './haptics'
import { Press } from './Press'

const images = (count: number) => `${count} ${count === 1 ? 'image' : 'images'}`

/** How far a row swipes aside to show its Discard. */
const DISCARD_WIDTH = 92

/**
 * A draft: the first line typed, where it will run and on which tool (its
 * mark, never its name), and whether the environment has it ("Not synced"
 * when the phone could not save it, "Sending" while a send has it).
 *
 * Swiped to the left it shows Discard, which hides the row and offers it
 * back for a moment (the shared discard, as web's ✕ on a draft card). A
 * screen reader finds the same as one of the row's actions. A draft being
 * sent is the send's, and has no Discard.
 */
export function DraftRow({
  row,
  onPress,
  onDiscard,
}: {
  row: HomeDraftRow
  onPress?: () => void
  onDiscard?: () => void
}) {
  const theme = usePhoneTheme()
  const swipeable = useRef<SwipeableMethods>(null)
  const { draft } = row
  const discard = draft.sending ? undefined : onDiscard
  const body = <DraftRowBody row={row} onPress={onPress} onDiscard={discard} />
  if (!discard) return body
  return (
    <ReanimatedSwipeable
      ref={swipeable}
      friction={1.6}
      rightThreshold={DISCARD_WIDTH / 2}
      overshootRight={false}
      dragOffsetFromRightEdge={12}
      renderRightActions={() => (
        <View style={{ width: DISCARD_WIDTH, paddingLeft: 6, paddingVertical: 2 }}>
          <Press
            accessibilityRole="button"
            accessibilityLabel="Discard draft"
            onPress={() => {
              tap()
              swipeable.current?.reset()
              discard()
            }}
            style={({ pressed }) => ({
              flex: 1,
              borderRadius: 12,
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
              backgroundColor: theme.destructive,
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <TrashIcon size={17} color={theme.destructiveFg} />
            <AppText variant="text-12-medium" style={{ color: theme.destructiveFg }}>
              Discard
            </AppText>
          </Press>
        </View>
      )}
    >
      {/* Opaque, so the Discard behind never shows through the row. */}
      <View style={{ backgroundColor: theme.bg, borderRadius: 12 }}>{body}</View>
    </ReanimatedSwipeable>
  )
}

function DraftRowBody({
  row,
  onPress,
  onDiscard,
}: {
  row: HomeDraftRow
  onPress?: () => void
  onDiscard?: () => void
}) {
  const theme = usePhoneTheme()
  const { draft, workspace } = row
  const state = draft.sending
    ? 'sending'
    : draft.unsynced
      ? 'unsynced'
      : draft.imageCount && draft.preview
        ? 'images'
        : null
  return (
    <Press
      accessibilityRole="button"
      {...(onDiscard
        ? {
            accessibilityActions: [{ name: 'discard', label: 'Discard draft' }],
            onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => {
              if (event.nativeEvent.actionName === 'discard') onDiscard()
            },
          }
        : {})}
      onPress={() => {
        tap()
        onPress?.()
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 12,
        backgroundColor: pressed ? theme.hover : 'transparent',
      })}
    >
      <View style={{ width: 22, height: 22, alignItems: 'center', justifyContent: 'center' }}>
        {draft.sending ? (
          <PaperPlaneTiltIcon size={16} color={theme.faint} />
        ) : draft.unsynced ? (
          <CloudSlashIcon size={16} color={theme.faint} />
        ) : draft.imageCount ? (
          <ImageIcon size={16} color={theme.faint} />
        ) : (
          <PencilSimpleLineIcon size={16} color={theme.faint} />
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        {/* A draft of images alone has no first line; its images stand in. */}
        <AppText
          variant="text-14-regular"
          numberOfLines={1}
          style={{ color: draft.preview ? theme.fg : theme.muted }}
        >
          {draft.preview || images(draft.imageCount)}
        </AppText>
        <View className="mt-0.5 flex-row items-center gap-1.5">
          {workspace ? <ProjectChip name={workspace.name} /> : null}
          {workspace ? (
            <AppText variant="text-12-regular" style={{ color: theme.faint }}>
              ·
            </AppText>
          ) : null}
          <ProviderMark providerId={draft.providerId} size={13} />
          {state === 'unsynced' ? (
            <View
              style={{
                paddingHorizontal: 7,
                paddingVertical: 1,
                borderRadius: 999,
                backgroundColor: theme.hover,
              }}
            >
              <AppText variant="text-11-medium" style={{ color: theme.status.needs }}>
                Not synced
              </AppText>
            </View>
          ) : state ? (
            <AppText
              variant="text-12-regular"
              numberOfLines={1}
              style={{ color: theme.muted, flexShrink: 1 }}
            >
              {state === 'sending' ? 'Sending' : images(draft.imageCount)}
            </AppText>
          ) : null}
        </View>
      </View>
      <AppText variant="text-12-regular" style={{ color: theme.faint }}>
        {shortAge(draft.editedAt)}
      </AppText>
    </Press>
  )
}
