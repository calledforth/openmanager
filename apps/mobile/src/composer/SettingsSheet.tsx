import { LightningIcon } from 'phosphor-react-native'
import { ScrollView, useWindowDimensions, View } from 'react-native'
import type { ComposerChoice } from '@openmanager/app-core/logic'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { ProviderMark } from '../ui/ProviderMark'
import { Sheet } from '../ui/Sheet'
import { isSpeedSetting, isToggleSetting, settingOn } from './controls-view'
import type { ComposerModel, SessionConfigOption } from './model'
import { FAST_COLOR } from './ModelSheet'

/** A select with more choices than this wraps as chips rather than one segmented row. */
const SEGMENT_LIMIT = 4

/** Fast's colour, faint, for the fill of a fast choice that is on. */
const FAST_FILL = 'rgba(77, 124, 255, 0.18)'

function Label({ name, description }: { name: string; description?: string | null }) {
  const theme = usePhoneTheme()
  return (
    <View style={{ gap: 1 }}>
      <AppText variant="text-14-regular" style={{ color: theme.fg }}>
        {name}
      </AppText>
      {description ? (
        <AppText variant="text-12-regular" style={{ color: theme.faint }}>
          {description}
        </AppText>
      ) : null}
    </View>
  )
}

/**
 * Reasoning effort as rising bars, as web's tile draws it: one bar per level,
 * cheapest first, lit up to the current one; the level's name under each.
 * Nothing lit is "Auto": the model picks its own depth.
 */
function EffortControl({
  choices,
  current,
  onPick,
}: {
  choices: readonly ComposerChoice[]
  current: string
  onPick: (id: string) => void
}) {
  const theme = usePhoneTheme()
  const index = choices.findIndex((choice) => choice.id === current)
  const caption =
    index >= 0
      ? (choices[index]!.description ?? null)
      : 'Auto: the model picks its own depth. Pick a level to set one.'
  return (
    <View style={{ gap: 10, paddingVertical: 10, paddingHorizontal: 12 }}>
      <View className="flex-row items-center" style={{ justifyContent: 'space-between' }}>
        <AppText variant="text-14-regular" style={{ color: theme.fg }}>
          Reasoning effort
        </AppText>
        <AppText variant="text-13-medium" style={{ color: theme.fg }}>
          {index >= 0 ? choices[index]!.name : 'Auto'}
        </AppText>
      </View>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="Reasoning effort"
        style={{ flexDirection: 'row', gap: 6 }}
      >
        {choices.map((choice, i) => {
          const lit = i <= index
          const on = i === index
          const share = choices.length > 1 ? i / (choices.length - 1) : 1
          return (
            <Press
              key={choice.id}
              accessibilityRole="radio"
              accessibilityLabel={choice.name}
              accessibilityHint={choice.disabledReason ?? choice.description}
              accessibilityState={{ checked: on, disabled: !!choice.disabledReason }}
              disabled={!!choice.disabledReason}
              hitSlop={4}
              onPress={() => {
                tap()
                if (!on) onPick(choice.id)
              }}
              style={{ flex: 1, alignItems: 'stretch', gap: 6 }}
            >
              <View style={{ height: 34, justifyContent: 'flex-end' }}>
                <View
                  style={{
                    height: 12 + 22 * share,
                    borderRadius: 5,
                    backgroundColor: lit ? theme.fg : theme.active,
                    opacity: lit ? 0.45 + 0.5 * share : 1,
                  }}
                />
              </View>
              <AppText
                variant={on ? 'text-12-medium' : 'text-12-regular'}
                numberOfLines={1}
                style={{ color: on ? theme.fg : theme.faint, textAlign: 'center' }}
              >
                {choice.name}
              </AppText>
            </Press>
          )
        })}
      </View>
      {caption ? (
        <AppText variant="text-12-regular" style={{ color: theme.faint }}>
          {caption}
        </AppText>
      ) : null}
    </View>
  )
}

/** On/off, as the provider lists it; fast mode lights its bolt in its colour. */
function Toggle({
  option,
  onChange,
}: {
  option: SessionConfigOption
  onChange: (value: string | boolean) => void
}) {
  const theme = usePhoneTheme()
  const on = settingOn(option)
  const fast = isSpeedSetting(option)
  const flip = () => {
    if (option.type === 'boolean') return onChange(!on)
    const next = option.options.find((entry) => entry.value.toLowerCase() === String(!on))?.value
    if (next !== undefined) onChange(next)
  }
  return (
    <Press
      accessibilityRole="switch"
      accessibilityLabel={option.name}
      accessibilityHint={option.description}
      accessibilityState={{ checked: on }}
      onPress={() => {
        tap()
        flip()
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 14,
        backgroundColor: pressed ? theme.hover : 'transparent',
      })}
    >
      {fast ? (
        <LightningIcon
          size={16}
          color={on ? FAST_COLOR : theme.muted}
          weight={on ? 'fill' : 'regular'}
        />
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label name={option.name} description={option.description} />
      </View>
      <View
        style={{
          width: 40,
          height: 24,
          borderRadius: 12,
          padding: 3,
          alignItems: on ? 'flex-end' : 'flex-start',
          backgroundColor: on ? (fast ? FAST_COLOR : theme.actionBg) : theme.active,
        }}
      >
        <View
          style={{
            width: 18,
            height: 18,
            borderRadius: 9,
            backgroundColor: on ? (fast ? '#ffffff' : theme.actionFg) : theme.muted,
          }}
        />
      </View>
    </Press>
  )
}

/** A choice of a few: one segmented row, the current one filled. */
function Segments({
  option,
  onChange,
}: {
  option: Extract<SessionConfigOption, { type: 'select' }>
  onChange: (value: string) => void
}) {
  const theme = usePhoneTheme()
  const speed = isSpeedSetting(option)
  const wrap = option.options.length > SEGMENT_LIMIT
  const selected = option.options.find((entry) => entry.value === option.currentValue)
  return (
    <View style={{ gap: 8, paddingVertical: 10, paddingHorizontal: 12 }}>
      <Label name={option.name} description={selected?.description ?? option.description} />
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={option.name}
        style={{
          flexDirection: 'row',
          flexWrap: wrap ? 'wrap' : 'nowrap',
          gap: wrap ? 6 : 3,
          ...(wrap ? null : { padding: 3, borderRadius: 12, backgroundColor: theme.hover }),
        }}
      >
        {option.options.map((entry) => {
          const on = entry.value === option.currentValue
          const fast = speed && !/^(default|standard|auto|flex)$/i.test(entry.value)
          return (
            <Press
              key={entry.value}
              accessibilityRole="radio"
              accessibilityLabel={entry.name}
              accessibilityHint={entry.description}
              accessibilityState={{ checked: on }}
              onPress={() => {
                tap()
                if (!on) onChange(entry.value)
              }}
              style={({ pressed }) => ({
                ...(wrap ? null : { flex: 1 }),
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                minHeight: 34,
                paddingHorizontal: 12,
                borderRadius: wrap ? 999 : 9,
                backgroundColor: on
                  ? fast
                    ? FAST_FILL
                    : theme.active
                  : pressed
                    ? theme.active
                    : wrap
                      ? theme.hover
                      : 'transparent',
              })}
            >
              {fast ? (
                <LightningIcon
                  size={12}
                  color={on ? FAST_COLOR : theme.muted}
                  weight={on ? 'fill' : 'regular'}
                />
              ) : null}
              <AppText
                variant={on ? 'text-13-medium' : 'text-13-regular'}
                numberOfLines={1}
                style={{ color: on ? theme.fg : theme.muted }}
              >
                {entry.name}
              </AppText>
            </Press>
          )
        })}
      </View>
    </View>
  )
}

/** One setting, drawn for what it is. */
function Setting({
  option,
  onChange,
}: {
  option: SessionConfigOption
  onChange: (value: string | boolean) => void
}) {
  const theme = usePhoneTheme()
  if (isToggleSetting(option)) return <Toggle option={option} onChange={onChange} />
  if (option.type !== 'select') return null
  if (option.options.length <= 1) {
    // One choice only: a fact about the model, not a control.
    const value = option.options[0]?.name ?? option.currentValue
    return (
      <View
        className="flex-row items-center"
        style={{ gap: 12, paddingVertical: 10, paddingHorizontal: 12 }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label name={option.name} description={option.description} />
        </View>
        <AppText variant="text-13-regular" style={{ color: theme.muted }}>
          {value}
        </AppText>
      </View>
    )
  }
  return <Segments option={option} onChange={onChange} />
}

/**
 * The model's settings, at web's "Model settings" parity: reasoning effort
 * as rising bars, then every other setting the provider lists for the model
 * (fast mode, Codex's speed and web search, the context window), each drawn
 * for what it is. Opened from the settings pick in the composer, and from
 * the session's ⋯ menu. Every change goes through the shared composer logic,
 * so it is the environment's and shows on web.
 */
export function SettingsSheet({ model, onClose }: { model: ComposerModel; onClose: () => void }) {
  const theme = usePhoneTheme()
  const { height } = useWindowDimensions()
  const locked = model.picks.lockedReason
  const effort = model.picks.effort
  const empty = !effort && model.settings.length === 0
  return (
    <Sheet onDismiss={onClose} onBack={onClose}>
      <View style={{ paddingHorizontal: 12, paddingBottom: 8, gap: 4 }}>
        <View className="flex-row items-center" style={{ gap: 8 }}>
          <AppText
            accessibilityRole="header"
            variant="text-14-medium"
            style={{ color: theme.fg, flex: 1 }}
          >
            Model settings
          </AppText>
          <View className="flex-row items-center" style={{ gap: 5, maxWidth: 220 }}>
            <ProviderMark providerId={model.picks.providerId} size={13} />
            <AppText
              variant="text-12-regular"
              numberOfLines={1}
              style={{ color: theme.muted, flexShrink: 1 }}
            >
              {model.picks.modelLabel}
            </AppText>
          </View>
        </View>
        {locked ? (
          <AppText variant="text-12-regular" style={{ color: theme.muted }}>
            {locked}
          </AppText>
        ) : null}
      </View>
      <ScrollView style={{ maxHeight: height * 0.6 }}>
        {empty ? (
          <AppText
            variant="text-13-regular"
            style={{ color: theme.muted, textAlign: 'center', paddingVertical: 14 }}
          >
            This model lists no settings.
          </AppText>
        ) : (
          <View
            pointerEvents={locked ? 'none' : 'auto'}
            style={{ opacity: locked ? 0.45 : 1, gap: 2 }}
          >
            {effort ? (
              <EffortControl
                choices={model.effortChoices}
                current={effort.id}
                onPick={model.pickEffort}
              />
            ) : null}
            {model.settings.map((option) => (
              <Setting
                key={option.id}
                option={option}
                onChange={(value) => model.setSetting(option.id, value)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </Sheet>
  )
}
