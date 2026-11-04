import { CameraIcon, ImagesIcon } from 'phosphor-react-native'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { StyleSheet, TextInput, useWindowDimensions, View } from 'react-native'
import { applySlashCommand, type ComposerChoice } from '@openmanager/app-core/logic'

import { DOCK_GAP, SessionDock, useDockSlot } from '../session/SessionDock'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { coveredBySheet } from '../ui/a11y-focus'
import { CameraCapture } from './CameraCapture'
import { ChoicePopover } from './ChoicePopover'
import { ComposerDock } from './ComposerDock'
import { LibraryPick } from './LibraryPick'
import { ModeIcon } from './icons'
import { useKeyboardHeight } from './keyboard'
import { slashPopupOf, type ComposerModel } from './model'
import { promptRoom, PromptRoomContext } from './prompt-room'
import { ModelSheet } from './ModelSheet'
import { PlanSheet } from './PlanSheet'
import { ProjectSheet, type ProjectSource } from './ProjectSheet'
import { SettingsSheet } from './SettingsSheet'
import { SlashPopup } from './SlashPopup'
import { useComposerUiState, type ComposerUi } from './ui-state'

/** Where an attached photo comes from. */
const ATTACH_CHOICES: readonly ComposerChoice[] = [
  { id: 'camera', name: 'Camera' },
  { id: 'library', name: 'Photo library' },
]

/**
 * The composer over the session page: the dock (status line and the composer,
 * in the page's dock slot), the command list, and whichever sheet or popover
 * is open. One layer over the whole page, passing touches through wherever
 * nothing of it is drawn; its glass blurs the page beneath.
 *
 * A new session's page writes in the page itself (`ComposerPage`, passed as
 * `page`): there is no dock, and this layer holds what floats over it.
 */
export function ComposerSurface({
  model,
  ui,
  projects,
  page = null,
}: {
  model: ComposerModel
  ui: ComposerUi
  /** Where a new session's project is picked from; absent for a session. */
  projects?: ProjectSource
  /** The page is the composer: its field, and how tall its tray stands. */
  page?: { input: RefObject<TextInput | null>; trayHeight: number } | null
}) {
  const theme = usePhoneTheme()
  const slot = useDockSlot()
  const { overlay } = useComposerUiState(ui)
  const dockInput = useRef<TextInput>(null)
  const input = page?.input ?? dockInput

  // The field in use: the prompt taking its place takes the focus with it.
  const [focused, setFocused] = useState(false)
  const replaced = !!model.prompt && model.prompt.kind !== 'plan'
  useEffect(() => {
    if (replaced) setFocused(false)
  }, [replaced])

  // A plan answered elsewhere takes its sheet with it.
  const plan = model.prompt?.kind === 'plan' ? model.prompt.plan : null
  useEffect(() => {
    if (overlay?.kind === 'plan' && !plan) ui.close()
  }, [overlay, plan, ui])

  // Whatever the composer opens covers the dock and the page: a screen
  // reader reads only the layer on top, as under a sheet.
  const covered = overlay !== null
  const onCovered = slot.onCovered
  useEffect(() => {
    onCovered(covered)
  }, [covered, onCovered])
  useEffect(() => () => onCovered(false), [onCovered])

  // The page's height for the composer's prompts, keyboard accounted for.
  const window = useWindowDimensions()
  const keyboard = useKeyboardHeight()
  const [layer, setLayer] = useState(0)
  const room = promptRoom({ layer, window: window.height, keyboard })

  // The dock's height, for the page and for the command list standing on it.
  // No dock on a page that writes in itself: the page keeps no room for one.
  const [dockHeight, setDockHeight] = useState(0)
  const onDockHeight = slot.onHeight
  const onHeight = useCallback(
    (height: number) => {
      setDockHeight(height)
      onDockHeight(height)
    },
    [onDockHeight],
  )
  const onPage = page !== null
  useLayoutEffect(() => {
    if (onPage) onHeight(0)
  }, [onHeight, onPage])

  const { matches: commands } = useMemo(
    () => slashPopupOf(model.text, model.slashCommands, false),
    [model.slashCommands, model.text],
  )
  const commandsOpen = commands.length > 0 && !replaced && (onPage || focused)
  // Above the keyboard the safe area under the dock is the keyboard's own.
  const bottomInset = keyboard > 0 ? DOCK_GAP : slot.bottomInset

  return (
    <PromptRoomContext.Provider value={room}>
      <View
        style={StyleSheet.absoluteFill}
        pointerEvents="box-none"
        onLayout={(event) => setLayer(event.nativeEvent.layout.height)}
      >
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none" {...coveredBySheet(covered)}>
          {onPage ? null : (
            <SessionDock
              status={slot.status}
              above={slot.above}
              bottomInset={bottomInset}
              onHeight={onHeight}
            >
              <ComposerDock
                model={model}
                ui={ui}
                input={input}
                focused={focused}
                onFocusChange={setFocused}
              />
            </SessionDock>
          )}

          {/* The session's commands, in glass over the page, standing on the dock or the tray. */}
          {commandsOpen ? (
            <View
              pointerEvents="box-none"
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: page ? page.trayHeight : dockHeight,
              }}
            >
              <SlashPopup
                commands={commands}
                onPick={(command) => {
                  model.setText(applySlashCommand(command))
                  input.current?.focus()
                }}
              />
            </View>
          ) : null}
        </View>

        {overlay?.kind === 'model' ? <ModelSheet model={model} onClose={ui.close} /> : null}
        {overlay?.kind === 'settings' ? <SettingsSheet model={model} onClose={ui.close} /> : null}
        {overlay?.kind === 'plan' && plan ? <PlanSheet plan={plan} onClose={ui.close} /> : null}
        {overlay?.kind === 'project' && projects ? (
          <ProjectSheet source={projects} browse={overlay.browse} onClose={ui.close} />
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
        {overlay?.kind === 'attach' ? (
          <ChoicePopover
            anchor={overlay.anchor}
            label="Attach a photo"
            choices={ATTACH_CHOICES}
            current=""
            icon={(choice) =>
              choice.id === 'camera' ? (
                <CameraIcon size={16} color={theme.muted} />
              ) : (
                <ImagesIcon size={16} color={theme.muted} />
              )
            }
            // The pick opens what it names in the popover's place.
            closeOnPick={false}
            onPick={(id) => ui.open({ kind: id === 'camera' ? 'camera' : 'library' })}
            onClose={ui.close}
          />
        ) : null}
        {overlay?.kind === 'camera' ? (
          <CameraCapture onPhoto={model.attachPhoto} onClose={ui.close} />
        ) : null}
        {overlay?.kind === 'library' ? (
          <LibraryPick onPhoto={model.attachPhoto} onClose={ui.close} />
        ) : null}
      </View>
    </PromptRoomContext.Provider>
  )
}
