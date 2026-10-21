import {
  CloudSlashIcon,
  ImageIcon,
  PaperPlaneTiltIcon,
  PencilSimpleLineIcon,
} from 'phosphor-react-native'
import { Pressable, View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import type { HomeDraftRow } from '../home/rows'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { ProjectChip } from './ProjectChip'
import { ProviderMark } from './ProviderMark'
import { shortAge } from './SessionRow'
import { tap } from './haptics'

const images = (count: number) => `${count} ${count === 1 ? 'image' : 'images'}`

/**
 * A draft: the first line typed, where it will run and on which tool (its
 * mark, never its name), and whether the environment has it ("Not synced"
 * when the phone could not save it, "Sending" while a send has it).
 */
export function DraftRow({ row, onPress }: { row: HomeDraftRow; onPress?: () => void }) {
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
    <Pressable
      accessibilityRole="button"
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
    </Pressable>
  )
}
