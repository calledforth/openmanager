import { useEffect, useState } from 'react'
import { BackHandler, StyleSheet, View } from 'react-native'

import { SessionDock, useDockSlot } from '../session/SessionDock'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { coveredBySheet } from '../ui/a11y-focus'
import { GlassTargetProvider, useGlassTarget, type GlassTarget } from '../ui/Glass'
import { CameraCapture } from './CameraCapture'
import { ChoicePopover } from './ChoicePopover'
import { ComposerDock } from './ComposerDock'
import { ExpandedComposer } from './ExpandedComposer'
import { ModeIcon } from './icons'
import type { ComposerModel } from './model'
import { ModelSheet } from './ModelSheet'
import { PlanSheet } from './PlanSheet'
import { ProjectSheet, type ProjectSource } from './ProjectSheet'
import { SettingsSheet } from './SettingsSheet'
import { coveredLayers, useComposerUiState, type ComposerUi } from './ui-state'

/**
 * The composer over the session page: the dock (status line and the docked
 * composer, in the page's dock slot), the pulled-up composer, and whichever
 * sheet or popover is open. One layer over the whole page, passing touches
 * through wherever nothing of it is drawn.
 *
 * Its glass blurs the page beneath (the page's target, from the session's
 * `Screen`); a sheet or popover opened from the pulled-up composer blurs
 * the composer instead, which covers the page.
 */
export function ComposerSurface({
  model,
  ui,
  contextName,
  projects,
}: {
  model: ComposerModel
  ui: ComposerUi
  contextName: string | null
  /** Where a new session's project is picked from; absent for a session. */
  projects?: ProjectSource
}) {
  const theme = usePhoneTheme()
  const slot = useDockSlot()
  const state = useComposerUiState(ui)
  const { overlay, expanded } = state
  const pageTarget = useGlassTarget()
  const [editorTarget, setEditorTarget] = useState<GlassTarget | null>(null)
  const layerTarget = expanded && editorTarget ? editorTarget : pageTarget

  // Back closes the pulled-up composer (sheets and popovers take it first).
  useEffect(() => {
    if (!expanded) return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => ui.back())
    return () => subscription.remove()
  }, [expanded, ui])

  // A request arriving brings the composer down to it (see `followPrompt`).
  const requestId = model.prompt?.requestId ?? null
  useEffect(() => {
    ui.followPrompt(requestId)
  }, [requestId, ui])

  // A plan answered elsewhere takes its sheet with it.
  const plan = model.prompt?.kind === 'plan' ? model.prompt.plan : null
  useEffect(() => {
    if (overlay?.kind === 'plan' && !plan) ui.close()
  }, [overlay, plan, ui])

  // Whatever the composer opens covers the dock and the page: a screen
  // reader reads only the layer on top, as under a sheet.
  const { page: covered, editor: editorCovered } = coveredLayers(state)
  const onCovered = slot.onCovered
  useEffect(() => {
    onCovered(covered)
  }, [covered, onCovered])
  useEffect(() => () => onCovered(false), [onCovered])

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none" {...coveredBySheet(covered)}>
        <SessionDock status={slot.status} bottomInset={slot.bottomInset} onHeight={slot.onHeight}>
          <ComposerDock model={model} ui={ui} />
        </SessionDock>
      </View>

      {expanded ? (
        <ExpandedComposer
          model={model}
          ui={ui}
          contextName={contextName}
          // Whatever opens from it stands over it, and a screen reader reads only that.
          covered={editorCovered}
          onTarget={setEditorTarget}
        />
      ) : null}

      <GlassTargetProvider target={layerTarget}>
        {overlay?.kind === 'model' ? <ModelSheet model={model} onClose={ui.close} /> : null}
        {overlay?.kind === 'settings' ? <SettingsSheet model={model} onClose={ui.close} /> : null}
        {overlay?.kind === 'plan' && plan ? <PlanSheet plan={plan} onClose={ui.close} /> : null}
        {overlay?.kind === 'project' && projects ? (
          <ProjectSheet source={projects} onClose={ui.close} />
        ) : null}
        {overlay?.kind === 'mode' && model.picks.mode ? (
          <ChoicePopover
            anchor={overlay.anchor}
            label="Mode"
            choices={model.modeChoices}
            current={model.picks.mode.id}
            icon={(choice) => <ModeIcon modeId={choice.id} size={16} color={theme.muted} />}
            onPick={model.pickMode}
            onClose={ui.close}
          />
        ) : null}
        {overlay?.kind === 'effort' && model.picks.effort ? (
          <ChoicePopover
            anchor={overlay.anchor}
            label="Effort"
            choices={model.effortChoices}
            current={model.picks.effort.id}
            onPick={model.pickEffort}
            onClose={ui.close}
          />
        ) : null}
        {overlay?.kind === 'camera' ? (
          <CameraCapture onPhoto={model.attachPhoto} onClose={ui.close} />
        ) : null}
      </GlassTargetProvider>
    </View>
  )
}
