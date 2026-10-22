import { useRef } from 'react'
import { View } from 'react-native'

import { usePhoneTheme } from '../theme/ThemeProvider'
import { ProviderMark } from '../ui/ProviderMark'
import { ProjectSquare } from '../ui/ProjectChip'
import { CaretGlyph, EffortGlyph, effortLevelOf, ModeIcon } from './icons'
import type { ComposerModel } from './model'
import { ContextMeter, Pick } from './Pick'
import type { ComposerUi, PickAnchor } from './ui-state'

/** Where a pick sits in the window, for the popover that stands on it. */
function measure(view: View | null, then: (anchor: PickAnchor) => void) {
  if (!view) return
  view.measureInWindow((x, y, width, height) => then({ x, y, width, height }))
}

/**
 * The picks: provider mark and model ▾, mode, effort, and (in the dock) the
 * context meter at the end; in the pulled-up composer's tray, the project
 * when the session is new. Tapping one opens the same sheet or popover from
 * either place. Picks the session cannot change say why and do not open.
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
  const effortRef = useRef<View>(null)
  const { picks } = model
  const tray = variant === 'tray'
  const effortIndex = picks.effort
    ? model.effortChoices.findIndex((choice) => choice.id === picks.effort!.id)
    : -1
  return (
    <>
      {tray && model.project ? (
        <Pick
          filled
          label={model.project.name}
          accessibilityLabel={`Project: ${model.project.name}`}
          icon={<ProjectSquare name={model.project.name} size={11} />}
          disabledReason={model.project.pickable ? null : 'A session stays in its project'}
          onPress={() => ui.open({ kind: 'project' })}
        />
      ) : null}
      <Pick
        strong
        filled={tray}
        label={picks.modelLabel}
        accessibilityLabel={`Model: ${picks.modelLabel}`}
        icon={<ProviderMark providerId={picks.providerId} size={13} />}
        trailing={<CaretGlyph size={9} color={theme.faint} />}
        disabledReason={picks.lockedReason}
        onPress={() => ui.open({ kind: 'model' })}
      />
      {picks.mode ? (
        <Pick
          ref={modeRef}
          filled={tray}
          label={picks.mode.label}
          accessibilityLabel={`Mode: ${picks.mode.label}`}
          icon={<ModeIcon modeId={picks.mode.id} size={13} color={tray ? theme.fg : theme.muted} />}
          disabledReason={picks.lockedReason}
          onPress={() => measure(modeRef.current, (anchor) => ui.open({ kind: 'mode', anchor }))}
        />
      ) : null}
      {picks.effort ? (
        <Pick
          ref={effortRef}
          filled={tray}
          label={picks.effort.label}
          accessibilityLabel={`Effort: ${picks.effort.label}`}
          icon={
            <EffortGlyph
              size={13}
              color={tray ? theme.fg : theme.muted}
              level={effortLevelOf(effortIndex, model.effortChoices.length)}
            />
          }
          disabledReason={picks.lockedReason}
          onPress={() =>
            measure(effortRef.current, (anchor) => ui.open({ kind: 'effort', anchor }))
          }
        />
      ) : null}
      {!tray ? <View style={{ flex: 1 }} /> : null}
      {!tray && picks.usagePercent !== null ? <ContextMeter percent={picks.usagePercent} /> : null}
    </>
  )
}
