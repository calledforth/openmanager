import { useCallback, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { statusLineOf, type HomeRow } from '../home/rows'
import { EnvironmentPage } from '../environment/PhoneEnvironmentProvider'
import { useHomeSource } from '../home/source'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { EnvironmentTag, LineDot } from '../ui/EnvironmentTag'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { ProjectChip } from '../ui/ProjectChip'
import { Sheet } from '../ui/Sheet'
import { StatusMark } from '../ui/StatusMark'
import { MenuRow, menuIconOf } from './SessionMenu'
import {
  conciseMenu,
  isPlaceItem,
  type SessionMenuItem,
  type SessionMenuItemId,
} from './session-menu'
import {
  unavailableSessionActions,
  useSessionActions,
  type SessionActions,
} from './useSessionActions'
import { commandFailure, TITLE_MAX } from './useSessionChrome'

const untitled = (title: string | undefined) => title?.trim() || 'Untitled session'

/**
 * How long after it opens the sheet takes no touch. It rises under the
 * finger that long-pressed its row, and lifting that finger must neither
 * close it (the scrim) nor choose whatever came up beneath it.
 */
const SETTLE_MS = 280

/**
 * A session's actions from its row, on a long press: the session named at
 * the top, the three places it can be put as tiles (cooking, the pin,
 * settled), then the rest as rows (rename, name it again, stop background
 * work). The same items as the page's title menu, less its settings, which
 * live with the composer. Only what can be done is listed.
 *
 * Choosing closes the sheet at once: every one of these shows in the list
 * the moment it is asked for (the shared client holds the ask until the
 * environment answers, and takes it back if it refuses), so there is
 * nothing to wait on here. A refusal is said by the home (`onFailed`).
 */
export function SessionActionsSheet({
  row,
  showEnvironment = false,
  onClose,
  onFailed,
}: {
  row: HomeRow
  /** The home spans more than one environment: say which this one is on. */
  showEnvironment?: boolean
  onClose: () => void
  /** A command the environment refused, in words. */
  onFailed?: (text: string) => void
}) {
  const { kind } = useHomeSource()
  const environmentId = row.session.environment?.environmentId
  const shared = { row, showEnvironment, onClose, onFailed }
  const unavailable = <UnavailableActions {...shared} />
  if (kind !== 'environment' || !environmentId) return unavailable
  // Through the row's own environment, whatever else is connected.
  return (
    <EnvironmentPage environmentId={environmentId} fallback={unavailable}>
      <LiveActions {...shared} />
    </EnvironmentPage>
  )
}

interface BodyProps {
  row: HomeRow
  showEnvironment: boolean
  onClose: () => void
  onFailed?: (text: string) => void
}

function LiveActions(props: BodyProps) {
  const actions = useSessionActions(props.row.session.externalId, props.row.session)
  return <ActionsSheetBody {...props} actions={actions} />
}

function UnavailableActions(props: BodyProps) {
  const { kind } = useHomeSource()
  const { session } = props.row
  const actions = useMemo(
    () =>
      unavailableSessionActions(
        session,
        kind === 'fixture'
          ? 'A sample session: pair an environment to change it'
          : 'Not connected to its environment',
      ),
    [kind, session],
  )
  return <ActionsSheetBody {...props} actions={actions} />
}

function ActionsSheetBody({
  row,
  showEnvironment,
  actions,
  onClose,
  onFailed,
}: BodyProps & { actions: SessionActions }) {
  const theme = usePhoneTheme()
  const title = untitled(row.session.title)
  const [editing, setEditing] = useState(false)
  // The page's settings live in its composer: not reachable from a row.
  const items = useMemo(
    () =>
      conciseMenu(
        actions.menu.filter((item) => item.id !== 'session-settings'),
        actions.unavailable,
      ),
    [actions.menu, actions.unavailable],
  )
  const places = items.filter(isPlaceItem)
  const rest = items.filter((item) => !isPlaceItem(item))
  const line = statusLineOf(row.session)
  const tone = row.mark === 'idle' ? theme.muted : theme.status[row.mark]
  const environment = showEnvironment ? row.session.environment : undefined

  const openedAt = useRef(Date.now())
  const settled = () => Date.now() - openedAt.current >= SETTLE_MS
  const dismiss = () => {
    if (settled()) onClose()
  }
  // One answer per opening: a second tap while the sheet leaves does nothing.
  const chosen = useRef(false)
  const send = useCallback(
    (id: SessionMenuItemId | 'rename', command: () => Promise<void>) => {
      if (chosen.current) return
      chosen.current = true
      onClose()
      command().catch((error: unknown) => onFailed?.(commandFailure(id, error)))
    },
    [onClose, onFailed],
  )
  const choose = (item: SessionMenuItem) => {
    if (item.disabledReason !== null || !settled()) return
    if (item.id === 'rename') setEditing(true)
    else send(item.id, () => actions.run(item.id))
  }
  const commitTitle = (next: string) => {
    const trimmed = next.trim().slice(0, TITLE_MAX)
    // Nothing to ask for: back to the actions, the title as it was.
    if (!trimmed || trimmed === title) setEditing(false)
    else send('rename', () => actions.rename(trimmed))
  }

  return (
    // The title's field rises with the keyboard, never under it.
    <KeyboardAvoidingView
      behavior="padding"
      style={StyleSheet.absoluteFill}
      pointerEvents="box-none"
    >
      <Sheet onDismiss={dismiss} onBack={editing ? () => setEditing(false) : onClose}>
        {editing ? (
          <TitleEditor title={title} onCommit={commitTitle} onCancel={() => setEditing(false)} />
        ) : (
          <View style={{ gap: 12 }}>
            <View
              style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4 }}
            >
              <View style={{ width: 20, alignItems: 'center' }}>
                <StatusMark mark={row.mark} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <AppText
                  accessibilityRole="header"
                  variant="text-16-medium"
                  numberOfLines={2}
                  style={{ color: theme.fg, letterSpacing: -0.2 }}
                >
                  {title}
                </AppText>
                <View className="mt-0.5 flex-row items-center gap-1.5">
                  {row.workspace ? (
                    <ProjectChip
                      name={row.workspace.name}
                      workspaceId={row.workspace.path}
                      scratch={row.workspace.scratch === true}
                    />
                  ) : null}
                  {row.workspace && line ? <LineDot /> : null}
                  {line ? (
                    <AppText variant="text-12-medium" numberOfLines={1} style={{ color: tone }}>
                      {line}
                    </AppText>
                  ) : null}
                  {environment ? (
                    <>
                      {row.workspace || line ? <LineDot /> : null}
                      <EnvironmentTag environment={environment} />
                    </>
                  ) : null}
                </View>
              </View>
            </View>

            {actions.unavailable ? (
              <AppText
                variant="text-12-regular"
                style={{ color: theme.muted, paddingHorizontal: 4 }}
              >
                {actions.unavailable}
              </AppText>
            ) : null}

            {places.length ? (
              <View accessibilityRole="menu" style={{ flexDirection: 'row', gap: 8 }}>
                {places.map((item) => (
                  <PlaceTile key={item.id} item={item} onChoose={() => choose(item)} />
                ))}
              </View>
            ) : null}

            {rest.length ? (
              <View accessibilityRole="menu" style={{ marginHorizontal: -6, marginBottom: -4 }}>
                {rest.map((item) => (
                  <MenuRow key={item.id} item={item} onChoose={() => choose(item)} />
                ))}
              </View>
            ) : null}
          </View>
        )}
      </Sheet>
    </KeyboardAvoidingView>
  )
}

/**
 * One of the places a session can be put, as a tile: the glyph over a word.
 * A fill, never an outline; it deepens while pressed.
 */
function PlaceTile({ item, onChoose }: { item: SessionMenuItem; onChoose: () => void }) {
  const theme = usePhoneTheme()
  const Icon = menuIconOf(item)
  const disabled = item.disabledReason !== null
  return (
    <Press
      accessibilityRole="menuitem"
      accessibilityLabel={item.label}
      accessibilityHint={item.disabledReason ?? undefined}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        tap()
        onChoose()
      }}
      style={({ pressed }) => ({
        flex: 1,
        minWidth: 0,
        height: 64,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        backgroundColor: pressed && !disabled ? theme.active : theme.hover,
        opacity: disabled ? 0.45 : 1,
      })}
    >
      <Icon size={20} color={theme.fg} />
      <AppText variant="text-12-medium" numberOfLines={1} style={{ color: theme.fg }}>
        {item.short ?? item.label}
      </AppText>
    </Press>
  )
}

/**
 * The title, being renamed: the field in a fill, then Cancel and Save. Done
 * on the keyboard saves; Cancel, Back, or a tap outside the sheet never
 * does. Putting the keyboard away leaves the field as it is.
 */
function TitleEditor({
  title,
  onCommit,
  onCancel,
}: {
  title: string
  onCommit: (title: string) => void
  onCancel: () => void
}) {
  const theme = usePhoneTheme()
  const value = useRef(title)
  return (
    <View style={{ gap: 12 }}>
      <AppText
        accessibilityRole="header"
        variant="text-12-medium"
        style={{ color: theme.muted, paddingHorizontal: 4 }}
      >
        Rename session
      </AppText>
      <View
        style={{
          borderRadius: 14,
          backgroundColor: theme.hover,
          paddingHorizontal: 14,
          paddingVertical: 11,
        }}
      >
        <TextInput
          accessibilityLabel="Session title"
          autoFocus
          selectTextOnFocus
          defaultValue={title}
          onChangeText={(next) => {
            value.current = next
          }}
          maxLength={TITLE_MAX}
          returnKeyType="done"
          submitBehavior="blurAndSubmit"
          onSubmitEditing={() => onCommit(value.current)}
          underlineColorAndroid="transparent"
          cursorColor={theme.fg}
          selectionColor={theme.active}
          style={[
            {
              fontFamily: 'Geist-Medium',
              fontSize: 16,
              lineHeight: 22,
              color: theme.fg,
              padding: 0,
              margin: 0,
            },
            // The browser's own focus ring, on the web build: the fill is the field.
            Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null,
          ]}
        />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
        <SheetButton label="Cancel" onPress={onCancel} />
        <SheetButton label="Save" primary onPress={() => onCommit(value.current)} />
      </View>
    </View>
  )
}

function SheetButton({
  label,
  primary = false,
  onPress,
}: {
  label: string
  primary?: boolean
  onPress: () => void
}) {
  const theme = usePhoneTheme()
  return (
    <Press
      accessibilityRole="button"
      onPress={() => {
        tap()
        onPress()
      }}
      style={({ pressed }) => ({
        minHeight: 40,
        justifyContent: 'center',
        paddingHorizontal: 18,
        borderRadius: 999,
        backgroundColor: primary
          ? pressed
            ? theme.actionHover
            : theme.actionBg
          : pressed
            ? theme.active
            : theme.hover,
      })}
    >
      <AppText variant="text-14-medium" style={{ color: primary ? theme.actionFg : theme.fg }}>
        {label}
      </AppText>
    </Press>
  )
}
