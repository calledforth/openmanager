import { CloudSlashIcon, ImageIcon, PencilSimpleLineIcon } from 'phosphor-react-native'
import { Pressable, View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import type { HomeDraftRow } from '../home/rows'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { ProjectChip } from './ProjectChip'
import { shortAge } from './SessionRow'
import { tap } from './haptics'

/**
 * A draft: the first line typed, where it will run, the picks, and whether
 * the environment has it ("Not synced" when the phone could not save it).
 */
export function DraftRow({ row, onPress }: { row: HomeDraftRow; onPress?: () => void }) {
  const theme = usePhoneTheme()
  const { draft, workspace } = row
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
        {!draft.synced ? (
          <CloudSlashIcon size={16} color={theme.faint} />
        ) : draft.imageCount ? (
          <ImageIcon size={16} color={theme.faint} />
        ) : (
          <PencilSimpleLineIcon size={16} color={theme.faint} />
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText variant="text-14-regular" numberOfLines={1} style={{ color: theme.fg }}>
          {draft.preview}
        </AppText>
        <View className="mt-0.5 flex-row items-center gap-1.5">
          {workspace ? <ProjectChip name={workspace.name} /> : null}
          {workspace && (draft.providerLabel || !draft.synced || draft.imageCount) ? (
            <AppText variant="text-12-regular" style={{ color: theme.faint }}>
              ·
            </AppText>
          ) : null}
          {!draft.synced ? (
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
          ) : draft.imageCount ? (
            <AppText variant="text-12-regular" style={{ color: theme.muted }}>
              {draft.imageCount} {draft.imageCount === 1 ? 'image' : 'images'}
              {draft.providerLabel ? ` · ${draft.providerLabel}` : ''}
            </AppText>
          ) : draft.providerLabel ? (
            <AppText
              variant="text-12-regular"
              numberOfLines={1}
              style={{ color: theme.muted, flexShrink: 1 }}
            >
              {draft.providerLabel}
            </AppText>
          ) : null}
        </View>
      </View>
      <AppText variant="text-12-regular" style={{ color: theme.faint }}>
        {shortAge(draft.updatedAt)}
      </AppText>
    </Pressable>
  )
}
