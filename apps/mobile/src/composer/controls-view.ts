import {
  configurableSessionOptions,
  effortDisplayName,
  isBooleanSelect,
  type ComposerChoice,
  type ComposerControls,
} from '@openmanager/app-core/logic'

import {
  choiceLabel,
  currentModelLabel,
  type ComposerPicks,
  type SessionConfigOption,
} from './model'

/**
 * The mode choices as web's pill offers them: a provider with only a build
 * mode and Plan gets Build / Plan; any other gets its own list. A mode the
 * provider's policy rules out stays listed, saying why (`disabledReason`).
 */
export function modeChoicesOf(controls: ComposerControls): {
  choices: ComposerChoice[]
  current: string
} {
  const { modeOptions, currentModeId } = controls
  const plan = modeOptions.find((mode) => mode.id === 'plan')
  const others = modeOptions.filter((mode) => mode.id !== 'plan')
  if (plan && others.length === 1 && modeOptions.length === 2) {
    const build = others[0]!
    return {
      choices: [
        {
          id: build.id,
          name: 'Build',
          ...(build.disabledReason ? { disabledReason: build.disabledReason } : {}),
        },
        {
          id: 'plan',
          name: 'Plan',
          ...(plan.disabledReason ? { disabledReason: plan.disabledReason } : {}),
        },
      ],
      current: currentModeId === 'plan' ? 'plan' : build.id,
    }
  }
  return { choices: modeOptions, current: currentModeId }
}

/** The effort levels, cheapest first: the provider's own setting, else the model row's bare levels. */
export function effortChoicesOf(controls: ComposerControls): ComposerChoice[] {
  const choices =
    controls.effortOptions ?? controls.effortLevels.map((level) => ({ id: level, name: level }))
  return choices.map((choice) => ({ ...choice, name: effortDisplayName(choice.name) }))
}

const isOn = (option: SessionConfigOption) =>
  option.type === 'boolean' ? option.currentValue : option.currentValue.toLowerCase() === 'true'

/** A toggle (on/off, or a true/false select). */
export function isToggleSetting(option: SessionConfigOption): boolean {
  return option.type === 'boolean' || isBooleanSelect(option)
}

/** Whether a toggle reads as on. */
export function settingOn(option: SessionConfigOption): boolean {
  return isOn(option)
}

/**
 * The settings that make the model faster: a fast-mode switch (Claude,
 * Cursor), or Codex's speed (`service_tier`, Standard or Fast).
 */
export function isSpeedSetting(option: SessionConfigOption): boolean {
  if (isToggleSetting(option)) return /fast/i.test(option.id) || /fast/i.test(option.category ?? '')
  return option.id === 'service_tier' || option.category === 'service_tier'
}

/** Standard speed as Codex names it: anything else is faster. */
const STANDARD_TIERS = new Set(['default', 'standard', 'auto', 'flex'])

/** Fast mode is on, or a faster tier is picked: the settings pick shows the bolt, as web's does. */
export function fastOn(options: readonly SessionConfigOption[]): boolean {
  return options.some((option) => {
    if (!isSpeedSetting(option)) return false
    if (isToggleSetting(option)) return isOn(option)
    return option.type === 'select' && !STANDARD_TIERS.has(option.currentValue.toLowerCase())
  })
}

/**
 * The picks the dock and the tray show, from the shared controls. Blank
 * effort reads "Auto", as web's pill says it: the provider picks its own
 * depth when nothing was asked, and naming a level would claim a setting
 * never sent.
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
            label: controls.currentEffort ? choiceLabel(efforts, controls.currentEffort) : 'Auto',
          }
        : null,
    usagePercent: controls.usage ? controls.usage.percent : null,
    fast: fastOn(configurableSessionOptions(controls.configOptions)),
    lockedReason: controls.canChangeSettings
      ? lockedReason
      : (lockedReason ?? 'Open a session to change this'),
  }
}
