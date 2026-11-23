import {
  CheckIcon,
  LightningIcon,
  MagnifyingGlassIcon,
  StarIcon,
  XIcon,
} from 'phosphor-react-native'
import { useMemo, useState } from 'react'
import { ScrollView, TextInput, useWindowDimensions, View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { ProviderMark } from '../ui/ProviderMark'
import { Sheet } from '../ui/Sheet'
import { modelSheetView, type ComposerModel, type ModelRow, type ModelTab } from './model'

function Row({
  row,
  current,
  showMark,
  onPick,
  onStar,
}: {
  row: ModelRow
  current: boolean
  /** Rows from more than one provider: each says whose it is, by its mark. */
  showMark: boolean
  onPick: () => void
  onStar: () => void
}) {
  const theme = usePhoneTheme()
  const disabled = !!row.unavailableReason
  const detail = row.unavailableReason ?? row.hint
  return (
    <Press
      accessibilityRole="menuitem"
      accessibilityLabel={row.label}
      accessibilityHint={detail}
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
        minHeight: 48,
        paddingVertical: 8,
        paddingLeft: 12,
        paddingRight: 6,
        borderRadius: 14,
        backgroundColor: current ? theme.active : pressed ? theme.hover : 'transparent',
      })}
    >
      {showMark ? (
        <View style={{ opacity: disabled ? 0.45 : 1 }}>
          <ProviderMark providerId={row.providerId} size={16} />
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0, opacity: disabled ? 0.45 : 1 }}>
        <AppText
          variant="text-14-regular"
          numberOfLines={1}
          style={{ color: theme.fg, fontSize: 15 }}
        >
          {row.label}
        </AppText>
        {detail ? (
          <AppText variant="text-12-regular" numberOfLines={1} style={{ color: theme.faint }}>
            {detail}
          </AppText>
        ) : null}
      </View>
      {row.context || row.fast ? (
        <View
          className="flex-row items-center"
          style={{ gap: 4, opacity: disabled ? 0.45 : 1 }}
          accessibilityLabel={[
            row.context ? `${row.context} context` : null,
            row.fast ? 'has fast mode' : null,
          ]
            .filter(Boolean)
            .join(', ')}
        >
          {row.context ? (
            <AppText variant="text-11-regular" style={{ color: theme.faint }}>
              {row.context}
            </AppText>
          ) : null}
          {row.fast ? <LightningIcon size={11} color={theme.faint} /> : null}
        </View>
      ) : null}
      {row.typed ? null : (
        <Press
          accessibilityRole="button"
          accessibilityLabel={row.favorite ? `Unstar ${row.label}` : `Star ${row.label}`}
          hitSlop={8}
          onPress={() => {
            tap()
            onStar()
          }}
          style={({ pressed }) => ({
            width: 30,
            height: 30,
            borderRadius: 15,
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
      )}
      <View style={{ width: 16 }}>
        {current ? <CheckIcon size={16} color={theme.fg} weight="bold" /> : null}
      </View>
    </Press>
  )
}

/** A tab: Favourites by its star, a provider by its mark alone, its name for a screen reader. */
function Tab({ tab, on, onPress }: { tab: ModelTab; on: boolean; onPress: () => void }) {
  const theme = usePhoneTheme()
  return (
    <Press
      accessibilityRole="tab"
      accessibilityLabel={tab.label}
      accessibilityState={{ selected: on }}
      onPress={() => {
        tap()
        onPress()
      }}
      style={({ pressed }) => ({
        height: 34,
        minWidth: 44,
        paddingHorizontal: 12,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: on ? theme.active : pressed ? theme.hover : 'transparent',
      })}
    >
      {tab.id === 'favorites' ? (
        <StarIcon size={16} color={on ? theme.fg : theme.muted} weight={on ? 'fill' : 'regular'} />
      ) : (
        <View style={{ opacity: on ? 1 : 0.7 }}>
          <ProviderMark providerId={tab.id} size={17} />
        </View>
      )}
    </Press>
  )
}

/**
 * The model sheet, at web's picker's parity: search on top, then Favourites
 * and one tab per provider (each by its mark, never its name), opening on
 * the current model's provider with that model filled. A search looks across
 * every provider; a provider that takes typed ids offers what is typed. A
 * session lists its own provider's models only; a provider that is down
 * stays listed, its rows saying why.
 */
export function ModelSheet({ model, onClose }: { model: ComposerModel; onClose: () => void }) {
  const theme = usePhoneTheme()
  const { height } = useWindowDimensions()
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<ModelTab['id'] | null>(null)
  const view = useMemo(
    () =>
      modelSheetView({
        groups: model.groups,
        currentProviderId: model.picks.providerId,
        canChangeProvider: model.canChangeProvider,
        favorites: model.favorites,
        query,
        tab,
      }),
    [model.canChangeProvider, model.favorites, model.groups, model.picks.providerId, query, tab],
  )
  const currentKey = `${model.picks.providerId}:${model.currentModelId}`
  const showMark = view.searching || view.tab === 'favorites'
  return (
    <Sheet onDismiss={onClose} onBack={onClose}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          marginHorizontal: 4,
          marginBottom: 8,
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
          placeholder={view.tabs.length > 0 ? 'Search every provider' : 'Search models'}
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
        {query ? (
          <Press
            accessibilityRole="button"
            accessibilityLabel="Clear the search"
            hitSlop={8}
            onPress={() => setQuery('')}
            style={{ padding: 4 }}
          >
            <XIcon size={13} color={theme.faint} weight="bold" />
          </Press>
        ) : null}
      </View>
      {view.tabs.length > 0 && !view.searching ? (
        <View
          accessibilityRole="tablist"
          style={{ flexDirection: 'row', gap: 4, paddingHorizontal: 4, paddingBottom: 8 }}
        >
          {view.tabs.map((item) => (
            <Tab
              key={item.id}
              tab={item}
              on={item.id === view.tab}
              onPress={() => setTab(item.id)}
            />
          ))}
        </View>
      ) : null}
      <ScrollView
        style={{ maxHeight: height * 0.5 }}
        keyboardShouldPersistTaps="handled"
        accessibilityRole="menu"
      >
        {view.rows.length === 0 ? (
          <AppText
            variant="text-13-regular"
            style={{ color: theme.muted, paddingVertical: 18, textAlign: 'center' }}
          >
            {query
              ? 'No model matches that.'
              : view.tab === 'favorites'
                ? 'Star a model to keep it here.'
                : 'This environment lists no models yet.'}
          </AppText>
        ) : null}
        {view.rows.map((row) => (
          <Row
            key={row.key}
            row={row}
            current={row.key === currentKey}
            showMark={showMark}
            onPick={() => {
              model.pickModel(row.providerId, row.modelId)
              onClose()
            }}
            onStar={() => model.toggleFavorite(row.key)}
          />
        ))}
      </ScrollView>
    </Sheet>
  )
}
