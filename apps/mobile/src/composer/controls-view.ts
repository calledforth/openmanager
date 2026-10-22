import type { ComposerChoice, ComposerControls } from '@openmanager/app-core/logic'

import { choiceLabel, currentModelLabel, type ComposerPicks } from './model'

/**
 * The mode choices as web's pill offers them: a provider with only a build
 * mode and Plan gets Build / Plan; any other gets its own list.
 */
export function modeChoicesOf(controls: ComposerControls): {
  choices: ComposerChoice[]
  current: string
} {
  const { modeOptions, currentModeId } = controls
  const plan = modeOptions.find((mode) => mode.id === 'plan')
  const others = modeOptions.filter((mode) => mode.id !== 'plan')
  if (plan && others.length === 1 && modeOptions.length === 2) {
    const buildId = others[0]!.id
    return {
      choices: [
        { id: buildId, name: 'Build' },
        { id: 'plan', name: 'Plan' },
      ],
      current: currentModeId === 'plan' ? 'plan' : buildId,
    }
  }
  return { choices: modeOptions, current: currentModeId }
}

/** The effort levels: the provider's own setting, else the model row's bare levels. */
export function effortChoicesOf(controls: ComposerControls): ComposerChoice[] {
  return (
    controls.effortOptions ?? controls.effortLevels.map((level) => ({ id: level, name: level }))
  )
}

/**
 * The picks the dock and the tray show, from the shared controls. Blank
 * effort stays blank ("Effort"): the provider picks its own depth when
 * nothing was asked, and naming a level would claim a setting never sent.
 */
export function picksOf(controls: ComposerControls, lockedReason: string | null): ComposerPicks {
  const modes = modeChoicesOf(controls)
  const efforts = effortChoicesOf(controls)
  return {
    providerId: controls.currentProviderId,
    modelLabel: currentModelLabel(
      controls.providerModelGroups,
      controls.currentProviderId,
      controls.currentModelId,
    ),
    mode:
      controls.showModeControl && modes.choices.length > 0
        ? { id: modes.current, label: choiceLabel(modes.choices, modes.current) }
        : null,
    effort:
      efforts.length > 0
        ? {
            id: controls.currentEffort,
            label: controls.currentEffort ? choiceLabel(efforts, controls.currentEffort) : 'Effort',
          }
        : null,
    usagePercent: controls.usage ? controls.usage.percent : null,
    lockedReason: controls.canChangeSettings
      ? lockedReason
      : (lockedReason ?? 'Open a session to change this'),
  }
}
