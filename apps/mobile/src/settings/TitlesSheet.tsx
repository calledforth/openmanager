import { CheckIcon, SparkleIcon } from 'phosphor-react-native'
import { useContext, useRef, useState, type Ref, type RefObject } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { ComposerStateContext, PlatformCapabilitiesContext } from '@openmanager/app-core/logic'

import { AppText } from '../components/ui/AppText'
import { ActionButton } from '../pairing/ActionButton'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { SectionLabel } from '../ui/chrome'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { ProviderMark } from '../ui/ProviderMark'
import { Sheet } from '../ui/Sheet'
import { SettingsRow } from './SettingsRow'
import {
  FIRST_TOOL,
  TITLE_TOOLS,
  titleModels,
  titleSummary,
  type TitleSetting,
  type TitleSettingState,
  type TitleTool,
} from './title-generation'
import { Toggle } from './Toggle'

/** For the screen reader only: on screen a tool is its mark. */
const TOOL_NAMES: Record<TitleTool, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  codex: 'Codex',
}

function useTitleModels(state: TitleSettingState | null, tool: TitleTool) {
  const platform = useContext(PlatformCapabilitiesContext)
  const profiles = useContext(ComposerStateContext)?.providerComposerProfiles
  return titleModels(tool, platform?.providers ?? [], profiles ?? {}, state?.saved ?? null)
}

/** The setting's row on the environment page: what names sessions now. */
export function TitlesSection({
  state,
  onOpen,
  rowRef,
}: {
  state: TitleSettingState
  onOpen: () => void
  rowRef: Ref<View>
}) {
  const theme = usePhoneTheme()
  const saved = state.saved
  const tool: TitleTool = saved && saved.provider !== 'off' ? saved.provider : FIRST_TOOL
  const models = useTitleModels(state, tool)
  const on = saved !== null && saved.provider !== 'off'
  const words = state.error && !saved ? state.error : titleSummary(saved, models)
  return (
    <>
      <SectionLabel>Session titles</SectionLabel>
      <SettingsRow
        icon={<SparkleIcon size={17} color={theme.muted} />}
        title="Generate titles"
        accessibilityLabel={`Session titles: ${on ? `${TOOL_NAMES[tool]}, ${words}` : words}`}
        sub={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {on ? <ProviderMark providerId={tool} size={12} /> : null}
            <AppText
              variant="text-12-regular"
              numberOfLines={1}
              style={{
                color: state.error && !saved ? theme.status.error : theme.muted,
                flexShrink: 1,
              }}
            >
              {words}
            </AppText>
          </View>
        }
        pressRef={rowRef}
        onPress={saved ? onOpen : undefined}
      />
    </>
  )
}

/**
 * Which tool and model name this environment's sessions, kept by the
 * environment for every device: on or off, the tool as its mark, then that
 * tool's models (its title default first). A pick saves the whole setting
 * and the sheet shows what the environment answered.
 */
export function TitlesSheet({
  setting,
  state,
  returnFocus,
  onClose,
}: {
  setting: TitleSetting
  state: TitleSettingState
  returnFocus?: RefObject<unknown>
  onClose: () => void
}) {
  const theme = usePhoneTheme()
  const heading = useRef<Text>(null)
  const saved = state.saved
  const on = saved !== null && saved.provider !== 'off'
  const [viewing, setViewing] = useState<TitleTool>(
    saved && saved.provider !== 'off' ? saved.provider : FIRST_TOOL,
  )
  const models = useTitleModels(state, viewing)
  return (
    <Sheet onDismiss={onClose} onBack={onClose} initialFocus={heading} returnFocus={returnFocus}>
      <View style={{ paddingHorizontal: 8, paddingBottom: 10, gap: 4 }}>
        <AppText
          ref={heading}
          accessibilityRole="header"
          variant="text-16-medium"
          style={{ color: theme.fg, textAlign: 'center' }}
        >
          Session titles
        </AppText>
        <AppText
          variant="text-13-regular"
          style={{ color: theme.muted, textAlign: 'center', lineHeight: 19 }}
        >
          Names each session from its first message, using a model on this environment.
        </AppText>
      </View>
      <SettingsRow
        raised
        icon={<SparkleIcon size={17} color={theme.muted} />}
        title="Generate titles"
        sub={on ? 'Every device sees this choice' : 'Sessions keep their first prompt as the title'}
        trailing={
          <Toggle
            label="Generate titles"
            value={on}
            disabled={!saved || state.busy}
            onChange={() => {
              void setting.toggle().then(() => {
                const next = setting.getState().saved
                if (next && next.provider !== 'off') setViewing(next.provider)
              })
            }}
          />
        }
      />
      {on ? (
        <>
          <View
            accessibilityRole="tablist"
            style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 4, paddingTop: 10 }}
          >
            {TITLE_TOOLS.map((tool) => {
              const chosen = tool === viewing
              return (
                <Press
                  key={tool}
                  accessibilityRole="tab"
                  accessibilityLabel={TOOL_NAMES[tool]}
                  accessibilityState={{ selected: chosen }}
                  onPress={() => {
                    if (chosen) return
                    tap()
                    setViewing(tool)
                  }}
                  style={({ pressed }) => ({
                    flex: 1,
                    height: 40,
                    borderRadius: 12,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: chosen ? theme.active : pressed ? theme.hover : 'transparent',
                  })}
                >
                  <ProviderMark providerId={tool} size={18} />
                </Press>
              )
            })}
          </View>
          <ScrollView style={{ maxHeight: 300, marginTop: 6 }}>
            {models.map((model) => {
              const chosen = saved?.provider === viewing && saved.model === model.id
              return (
                <SettingsRow
                  key={model.id || 'default'}
                  raised
                  selected={chosen}
                  title={model.name}
                  sub={model.description}
                  accessibilityLabel={`${TOOL_NAMES[viewing]}, ${model.name}${chosen ? ', in use' : ''}`}
                  trailing={chosen ? <CheckIcon size={15} color={theme.fg} weight="bold" /> : null}
                  onPress={
                    state.busy || chosen
                      ? undefined
                      : () => void setting.save({ provider: viewing, model: model.id })
                  }
                />
              )
            })}
          </ScrollView>
        </>
      ) : null}
      {state.error ? (
        <AppText
          accessibilityRole="alert"
          variant="text-13-regular"
          style={{ color: theme.status.error, textAlign: 'center', marginTop: 8 }}
        >
          {state.error}
        </AppText>
      ) : null}
      <View style={{ marginTop: 10 }}>
        <ActionButton label="Done" tone="quiet" onPress={onClose} />
      </View>
    </Sheet>
  )
}
