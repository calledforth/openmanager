import { CheckIcon, MagnifyingGlassIcon, StarIcon } from 'phosphor-react-native'
import { useMemo, useState } from 'react'
import { ScrollView, TextInput, useWindowDimensions, View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { ProviderMark } from '../ui/ProviderMark'
import { Sheet } from '../ui/Sheet'
import { modelSheetSections, type ComposerModel, type ModelRow } from './model'

/** The height of a heading's line (the 12 px label's), which a provider's mark fills. */
const HEADER_LINE = 15

function Row({
  row,
  current,
  onPick,
  onStar,
}: {
  row: ModelRow
  current: boolean
  onPick: () => void
  onStar: () => void
}) {
  const theme = usePhoneTheme()
  const disabled = !!row.unavailableReason
  return (
    <Press
      accessibilityRole="menuitem"
      accessibilityLabel={row.label}
      accessibilityHint={row.unavailableReason ?? row.hint}
      accessibilityState={{ selected: current, disabled }}
      disabled={disabled}
      onPress={() => {
        tap()
        onPick()
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 11,
        paddingHorizontal: 12,
        borderRadius: 14,
        backgroundColor: current ? theme.active : pressed ? theme.hover : 'transparent',
      })}
    >
      <View style={{ opacity: disabled ? 0.45 : 1 }}>
        <ProviderMark providerId={row.providerId} size={16} />
      </View>
      <View style={{ flex: 1, minWidth: 0, opacity: disabled ? 0.45 : 1 }}>
        <AppText
          variant="text-14-regular"
          numberOfLines={1}
          style={{ color: theme.fg, fontSize: 15 }}
        >
          {row.label}
        </AppText>
        {row.unavailableReason || row.hint ? (
          <AppText variant="text-12-regular" numberOfLines={1} style={{ color: theme.faint }}>
            {row.unavailableReason ?? row.hint}
          </AppText>
        ) : null}
      </View>
      <Press
        accessibilityRole="button"
        accessibilityLabel={row.favorite ? `Unstar ${row.label}` : `Star ${row.label}`}
        hitSlop={8}
        onPress={() => {
          tap()
          onStar()
        }}
        style={({ pressed }) => ({
          width: 28,
          height: 28,
          borderRadius: 14,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: pressed ? theme.active : 'transparent',
        })}
      >
        <StarIcon
          size={14}
          color={row.favorite ? theme.status.needs : theme.faint}
          weight={row.favorite ? 'fill' : 'regular'}
        />
      </Press>
      <View style={{ width: 16 }}>
        {current ? <CheckIcon size={16} color={theme.fg} weight="bold" /> : null}
      </View>
    </Press>
  )
}

/**
 * The model sheet: search on top, favourites, then one group per provider,
 * each headed by the provider's mark (never its name). A session lists its
 * own provider's models; a new session lists every provider. A provider
 * that is down stays listed, its rows saying why.
 */
export function ModelSheet({ model, onClose }: { model: ComposerModel; onClose: () => void }) {
  const theme = usePhoneTheme()
  const { height } = useWindowDimensions()
  const [query, setQuery] = useState('')
  const sections = useMemo(
    () =>
      modelSheetSections({
        groups: model.groups,
        currentProviderId: model.picks.providerId,
        canChangeProvider: model.canChangeProvider,
        favorites: model.favorites,
        query,
      }),
    [model.canChangeProvider, model.favorites, model.groups, model.picks.providerId, query],
  )
  const currentKey = `${model.picks.providerId}:${model.currentModelId}`
  return (
    <Sheet onDismiss={onClose} onBack={onClose}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          marginHorizontal: 4,
          marginBottom: 6,
          paddingHorizontal: 12,
          borderRadius: 14,
          backgroundColor: theme.hover,
        }}
      >
        <MagnifyingGlassIcon size={16} color={theme.faint} />
        <TextInput
          accessibilityLabel="Search models"
          value={query}
          onChangeText={setQuery}
          placeholder="Search models"
          placeholderTextColor={theme.faint}
          autoCorrect={false}
          autoCapitalize="none"
          style={{
            flex: 1,
            paddingVertical: 10,
            color: theme.fg,
            fontFamily: 'Geist-Regular',
            fontSize: 14,
          }}
        />
      </View>
      <ScrollView style={{ maxHeight: height * 0.55 }} keyboardShouldPersistTaps="handled">
        {sections.length === 0 ? (
          <AppText
            variant="text-14-regular"
            style={{ color: theme.muted, padding: 12, textAlign: 'center' }}
          >
            {query ? 'No model matches that.' : 'This environment lists no models yet.'}
          </AppText>
        ) : null}
        {sections.map((section) => (
          <View key={section.id} accessibilityRole="menu">
            <View
              accessible
              accessibilityRole="header"
              accessibilityLabel={section.label}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                // The same line as the Favourites heading, whether it holds words or a mark.
                minHeight: HEADER_LINE + 14,
                paddingTop: 8,
                paddingBottom: 6,
                paddingHorizontal: 12,
              }}
            >
              {section.id === 'favorites' ? (
                <>
                  <StarIcon size={13} color={theme.faint} />
                  <AppText
                    variant="text-12-medium"
                    style={{ color: theme.faint, letterSpacing: 0.24 }}
                  >
                    Favourites
                  </AppText>
                </>
              ) : (
                // The heading is the provider's mark, at the label's weight: never its name.
                <ProviderMark providerId={section.id} size={HEADER_LINE} />
              )}
            </View>
            {section.rows.map((row) => (
              <Row
                key={`${section.id}-${row.key}`}
                row={row}
                current={row.key === currentKey}
                onPick={() => {
                  model.pickModel(row.providerId, row.modelId)
                  onClose()
                }}
                onStar={() => model.toggleFavorite(row.key)}
              />
            ))}
          </View>
        ))}
      </ScrollView>
    </Sheet>
  )
}
