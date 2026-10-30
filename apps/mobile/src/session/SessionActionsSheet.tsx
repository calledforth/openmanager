import { useEffect, useMemo, useRef } from 'react'
import { TextInput, View } from 'react-native'
import { useEnvironmentClientOptional } from '@openmanager/app-core/logic'

import { ShimmerText } from '../components/chat/ShimmerText'
import { AppText } from '../components/ui/AppText'
import { statusLineOf, type HomeRow } from '../home/rows'
import { useHomeSource } from '../home/source'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { ProjectChip } from '../ui/ProjectChip'
import { Sheet } from '../ui/Sheet'
import { StatusMark } from '../ui/StatusMark'
import { MenuRow } from './SessionMenu'
import { unavailableSessionActions, useSessionActions, type SessionActions } from './useSessionActions'
import { TITLE_MAX, useSessionChrome } from './useSessionChrome'

const untitled = (title: string | undefined) => title?.trim() || 'Untitled session'

/**
 * A session's actions from its row, on a long press: the same items as the
 * page's ⋯ menu (rename, name it again, settle or move back, stop background
 * work), in a sheet with the session named at its top. Session settings stay
 * on the page, where the composer is. A command keeps the sheet open until
 * the environment answers: it closes on success, and says why on failure.
 */
export function SessionActionsSheet({ row, onClose }: { row: HomeRow; onClose: () => void }) {
  const client = useEnvironmentClientOptional()
  const { kind } = useHomeSource()
  if (client && kind === 'environment') return <LiveActions row={row} onClose={onClose} />
  return <UnavailableActions row={row} onClose={onClose} />
}

function LiveActions({ row, onClose }: { row: HomeRow; onClose: () => void }) {
  const actions = useSessionActions(row.session.externalId, row.session)
  return <ActionsSheetBody row={row} actions={actions} onClose={onClose} />
}

function UnavailableActions({ row, onClose }: { row: HomeRow; onClose: () => void }) {
  const { kind } = useHomeSource()
  const actions = useMemo(
    () =>
      unavailableSessionActions(
        row.session,
        kind === 'fixture'
          ? 'A sample session: pair an environment to change it'
          : 'Not connected to an environment',
      ),
    [kind, row.session],
  )
  return <ActionsSheetBody row={row} actions={actions} onClose={onClose} />
}

function ActionsSheetBody({
  row,
  actions,
  onClose,
}: {
  row: HomeRow
  actions: SessionActions
  onClose: () => void
}) {
  const theme = usePhoneTheme()
  const title = untitled(row.session.title)
  const chrome = useSessionChrome(actions, title)
  // The page's settings live in its composer: not reachable from a row.
  const items = chrome.menu.filter((item) => item.id !== 'session-settings')
  const line = statusLineOf(row.session)
  const tone = row.mark === 'idle' ? theme.muted : theme.status[row.mark]

  // A command that landed closes the sheet; one that failed leaves it open with why.
  const wasPending = useRef(false)
  useEffect(() => {
    if (wasPending.current && !chrome.pending && chrome.note === null) onClose()
    wasPending.current = chrome.pending
  }, [chrome.note, chrome.pending, onClose])

  const dismiss = chrome.pending ? undefined : onClose
  return (
    <Sheet onDismiss={dismiss} onBack={() => dismiss?.()}>
      <View style={{ paddingHorizontal: 6, paddingBottom: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 6 }}>
          <View style={{ width: 22, alignItems: 'center' }}>
            <StatusMark mark={row.mark} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            {chrome.editing ? (
              <TitleField title={title} onCommit={chrome.commitTitle} />
            ) : (
              <AppText
                accessibilityRole="header"
                variant="text-16-medium"
                numberOfLines={2}
                style={{ color: theme.fg }}
              >
                {title}
              </AppText>
            )}
            <View className="mt-0.5 flex-row items-center gap-1.5">
              {row.workspace ? (
                <ProjectChip name={row.workspace.name} workspaceId={row.workspace.path} />
              ) : null}
              {row.workspace && line ? (
                <AppText variant="text-12-regular" style={{ color: theme.faint }}>
                  ·
                </AppText>
              ) : null}
              {line ? (
                <AppText variant="text-12-medium" style={{ color: tone }}>
                  {line}
                </AppText>
              ) : null}
            </View>
          </View>
        </View>

        {chrome.editing ? (
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <SheetButton label="Cancel" onPress={() => chrome.commitTitle(title)} />
          </View>
        ) : (
          <View accessibilityRole="menu" style={{ marginTop: 10 }}>
            {items.map((item) => (
              <MenuRow
                key={item.id}
                item={item}
                said={actions.unavailable}
                onChoose={() => chrome.choose(item.id)}
              />
            ))}
          </View>
        )}

        {actions.unavailable || chrome.note ? (
          <View style={{ paddingHorizontal: 12, paddingTop: 8 }}>
            {chrome.note?.kind === 'busy' ? (
              <ShimmerText variant="text-12-regular" numberOfLines={1}>
                {chrome.note.text}
              </ShimmerText>
            ) : chrome.note ? (
              <AppText
                variant="text-12-regular"
                numberOfLines={2}
                style={{ color: theme.status.error }}
              >
                {chrome.note.text}
              </AppText>
            ) : (
              <AppText variant="text-12-regular" style={{ color: theme.muted }}>
                {actions.unavailable}
              </AppText>
            )}
          </View>
        ) : null}
      </View>
    </Sheet>
  )
}

/** The title, editable in the sheet: done or blur commits, as the page's field does. */
function TitleField({ title, onCommit }: { title: string; onCommit: (title: string) => void }) {
  const theme = usePhoneTheme()
  const value = useRef(title)
  const done = useRef(false)
  const commit = () => {
    if (done.current) return
    done.current = true
    onCommit(value.current)
  }
  return (
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
      onSubmitEditing={commit}
      onBlur={commit}
      underlineColorAndroid="transparent"
      cursorColor={theme.fg}
      selectionColor={theme.active}
      style={{
        fontFamily: 'Geist-Medium',
        fontSize: 16,
        lineHeight: 22,
        color: theme.fg,
        padding: 0,
        margin: 0,
      }}
    />
  )
}

function SheetButton({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = usePhoneTheme()
  return (
    <Press
      accessibilityRole="button"
      onPress={() => {
        tap()
        onPress()
      }}
      style={({ pressed }) => ({
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: 999,
        backgroundColor: pressed ? theme.active : theme.hover,
      })}
    >
      <AppText variant="text-14-medium" style={{ color: theme.fg }}>
        {label}
      </AppText>
    </Press>
  )
}
