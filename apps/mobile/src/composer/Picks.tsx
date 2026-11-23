import { FadersHorizontalIcon, LightningIcon } from 'phosphor-react-native'
import { useRef, useState } from 'react'
import { View } from 'react-native'

import { usePhoneTheme } from '../theme/ThemeProvider'
import { ProviderMark } from '../ui/ProviderMark'
import { CaretGlyph, EffortGlyph, effortLevelOf, ModeIcon } from './icons'
import { FAST_COLOR, PICK_GAP, roomFor, TRAY_MODEL_MAX, type ComposerModel } from './model'
import { ContextMeter, Pick } from './Pick'
import type { ComposerUi, PickAnchor } from './ui-state'

/** Where a pick sits in the window, for the popover that stands on it. */
export function measure(view: View | null, then: (anchor: PickAnchor) => void) {
  if (!view) return
  view.measureInWindow((x, y, width, height) => then({ x, y, width, height }))
}

/**
 * The picks, as web's composer row has them: provider mark and model ▾, the
 * model's settings (its effort, a bolt while fast is on), mode, and (in the
 * dock) the context meter at the end. Tapping one opens the same sheet or
 * popover from the dock or the new-session page's tray. Picks the session
 * cannot change say why and do not open.
 */
export function Picks({
  model,
  ui,
  variant,
}: {
  model: ComposerModel
  ui: ComposerUi
  variant: 'row' | 'tray'
}) {
  const theme = usePhoneTheme()
  const modeRef = useRef<View>(null)
  const { picks } = model
  const tray = variant === 'tray'
  const ink = tray ? theme.fg : theme.muted
  // The model's settings earn a pick when it has an effort or any other setting.
  const hasSettings = picks.effort !== null || model.settings.length > 0
  // The row's room, and what mode and settings take of it (they never shrink).
  const [rowWidth, setRowWidth] = useState(0)
  const [modeWidth, setModeWidth] = useState(0)
  const [settingsWidth, setSettingsWidth] = useState(0)
  const room = roomFor({
    row: rowWidth,
    fixed: (picks.mode ? modeWidth + PICK_GAP : 0) + (hasSettings ? settingsWidth + PICK_GAP : 0),
    meter: picks.usagePercent !== null,
  })
  const effortIndex = picks.effort
    ? model.effortChoices.findIndex((choice) => choice.id === picks.effort!.id)
    : -1
  const settingsLabel = picks.effort?.label
  const content = (
    <>
      <Pick
        strong
        filled={tray}
        label={picks.modelLabel}
        accessibilityLabel={`Model: ${picks.modelLabel}`}
        maxWidth={tray ? TRAY_MODEL_MAX : room.model}
        icon={<ProviderMark providerId={picks.providerId} size={13} />}
        trailing={<CaretGlyph size={9} color={theme.faint} />}
        disabledReason={picks.lockedReason}
        onPress={() => ui.open({ kind: 'model' })}
      />
      {hasSettings ? (
        <Pick
          filled={tray}
          onLayout={(event) => setSettingsWidth(event.nativeEvent.layout.width)}
          label={settingsLabel}
          accessibilityLabel={
            settingsLabel
              ? `Model settings: effort ${settingsLabel}${picks.fast ? ', fast' : ''}`
              : `Model settings${picks.fast ? ': fast' : ''}`
          }
          icon={
            picks.effort ? (
              <EffortGlyph
                size={13}
                color={ink}
                level={effortIndex < 0 ? 0 : effortLevelOf(effortIndex, model.effortChoices.length)}
              />
            ) : (
              <FadersHorizontalIcon size={13} color={ink} />
            )
          }
          trailing={
            picks.fast ? <LightningIcon size={11} color={FAST_COLOR} weight="fill" /> : undefined
          }
          disabledReason={picks.lockedReason}
          onPress={() => ui.open({ kind: 'settings' })}
        />
      ) : null}
      {picks.mode ? (
        <Pick
          ref={modeRef}
          filled={tray}
          onLayout={(event) => setModeWidth(event.nativeEvent.layout.width)}
          label={picks.mode.label}
          accessibilityLabel={`Mode: ${picks.mode.label}`}
          icon={<ModeIcon modeId={picks.mode.id} size={13} color={ink} />}
          disabledReason={picks.lockedReason}
          onPress={() => measure(modeRef.current, (anchor) => ui.open({ kind: 'mode', anchor }))}
        />
      ) : null}
      {!tray ? <View style={{ flex: 1 }} /> : null}
      {!tray && picks.usagePercent !== null && room.meter ? (
        <ContextMeter percent={picks.usagePercent} />
      ) : null}
    </>
  )
  if (tray) return content
  return (
    <View
      onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}
      style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: PICK_GAP }}
    >
      {content}
    </View>
  )
}
