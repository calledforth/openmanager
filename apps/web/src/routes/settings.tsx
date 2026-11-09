import { useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { MonitorIcon, MoonIcon, PlusIcon, SunIcon, XIcon } from '@phosphor-icons/react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Button } from '@openmanager/app-core/components/fluid/ui/button'
import { phosphorIcon } from '@openmanager/app-core/components/fluid/lib/icon-context'
import { Tooltip } from '@openmanager/app-core/components/ui/Tooltip'
import {
  TabsSubtle,
  TabsSubtleItem,
  TabsSubtlePanel,
} from '@openmanager/app-core/components/fluid/ui/tabs-subtle'
import { ProviderIcon } from '@openmanager/app-core/components/providers/ProviderIcon'
import {
  describeProviderHealth,
  type ProviderHealthTone,
} from '@openmanager/app-core/lib/provider-health-view'
import { ComposerStateContext } from '@openmanager/app-core/providers/composer-provider'
import { EnvironmentPlatformCapabilitiesProvider } from '@openmanager/app-core/providers/environment-application'
import {
  EnvironmentClientProvider,
  useEnvironmentClientOptional,
} from '@openmanager/app-core/providers/environment-client'
import { PlatformCapabilitiesContext } from '@openmanager/app-core/providers/platform-provider'
import { isEnvironmentReachable } from '@openmanager/app-core/providers/sidebar-rows'
import { EnvironmentClientError } from '@openmanager/environment-client'
import { SessionStateContext } from '@openmanager/app-core/providers/session-provider'
import { useEnterWhileRunning, type FollowUpAction } from '@openmanager/app-core/logic'
import { AddProjectStartSetting } from '../components/add-project-start-setting'
import { DevicesSettingControl } from '../components/devices-settings'
import {
  NOTIFICATIONS_CHOICES,
  NotificationsSettingControl,
} from '../components/notifications-setting'
import { TitleGenerationSettingControl } from '../components/title-generation-setting'
import {
  EnvironmentConnectForm,
  EnvironmentList,
  RouteOfferPrompt,
  type EnvironmentRenameTarget,
} from '../components/connection-surfaces'
import {
  closeAddEnvironment,
  editAddEnvironment,
  openAddEnvironment,
  sendAddEnvironment,
  trackAddEnvironment,
  useAddEnvironmentDraft,
} from '../lib/add-environment-draft'
import {
  connectionStatusLabel,
  findStoredEnvironment,
  hostOf,
  type StoredEnvironment,
} from '@openmanager/environment-client/connection'
import { UI_FONTS, type UiFontId } from '../lib/fonts'
import { pairingAppUrl } from '../lib/pairing-app-url'
import { useConnection } from '../providers/connection-provider'
import { useEnvironmentClients } from '../providers/environment-client-provider'
import type { AppearanceMode } from '@openmanager/app-core/providers/theme-provider'
import { ThemeFamilyPicker } from '../components/theme-family-picker'
import { useTheme } from '../providers/theme-provider'
import { cn } from '../lib/utils'

const SETTINGS_TABS = [
  { id: 'environments', label: 'Environments' },
  { id: 'devices', label: 'Devices' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'chat', label: 'Chat' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'providers', label: 'Providers' },
] as const

type SettingsTab = (typeof SETTINGS_TABS)[number]['id']

function isSettingsTab(value: unknown): value is SettingsTab {
  return SETTINGS_TABS.some((tab) => tab.id === value)
}

type SettingsSearch = { tab?: SettingsTab; environment?: string }

export const Route = createFileRoute('/settings')({
  // The tab lives in the URL, so a section can be linked to and survives a reload.
  // So does the environment chosen here: the page remounts when a connection
  // comes or goes, and this choice is not the selection, which stays with the
  // open session.
  validateSearch: (search: Record<string, unknown>): SettingsSearch => ({
    ...(isSettingsTab(search.tab) ? { tab: search.tab } : {}),
    ...(typeof search.environment === 'string' ? { environment: search.environment } : {}),
  }),
  component: SettingsPage,
})

const AddIcon = phosphorIcon(PlusIcon)

/** One titled block of a settings tab. */
function SettingsSection({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="mt-8 first:mt-0">
      <h2 className="text-[13px] font-medium text-foreground">{title}</h2>
      {description ? <p className="mt-1 text-[13px] text-muted-foreground">{description}</p> : null}
      {children}
    </section>
  )
}

function ChoiceGroup<T extends string>({
  name,
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  name: string
  label: string
  value: T
  options: ReadonlyArray<{ id: T; label: string }>
  onChange: (id: T) => void
  disabled?: boolean
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const selected = value === option.id
        return (
          <label
            key={option.id}
            className={cn(
              // Selection is a fill, never an outline.
              'cursor-pointer rounded-md px-3 py-1.5 text-[13px] transition-colors duration-100',
              'has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-focus-ring',
              selected
                ? 'bg-active text-foreground'
                : 'text-muted-foreground hover:bg-hover hover:text-foreground',
            )}
          >
            <input
              type="radio"
              className="sr-only"
              name={name}
              value={option.id}
              checked={selected}
              disabled={disabled}
              onChange={() => onChange(option.id)}
            />
            {option.label}
          </label>
        )
      })}
    </div>
  )
}

/**
 * The environment this page's settings act on: the one chosen here, else the
 * selected one. Choosing here moves nothing else.
 */
function useSettingsEnvironment(): StoredEnvironment | undefined {
  const { environments, selectedId } = useConnection()
  const { environment } = Route.useSearch()
  return (
    findStoredEnvironment(environments, environment) ??
    findStoredEnvironment(environments, selectedId)
  )
}

const NEVER = () => () => undefined

/** Still on its way, so saying it isn't connected would only flash. */
const ON_ITS_WAY: ReadonlySet<string> = new Set(['connecting', 'reconnecting', 'ready'])

/** The choice itself. With one environment saved there is nothing to choose. */
function EnvironmentChoice({
  chosen,
  within = false,
}: {
  chosen: StoredEnvironment | undefined
  /** Inside a section of its own, rather than one headed "Applies to". */
  within?: boolean
}) {
  const navigate = useNavigate()
  const { environments, links } = useConnection()
  const client = useEnvironmentClients().clients[chosen?.environmentId ?? '']
  const read = () => client?.getState().connection.phase === 'connected'
  const connected = useSyncExternalStore(client?.subscribe ?? NEVER, read, read)
  const link = links.find((item) => item.environmentId === chosen?.environmentId)
  const unreachable = chosen && !connected && !(link && ON_ITS_WAY.has(link.ui.kind))
  if (environments.length < 2) return null
  const labels = environments.map((item) => item.label)
  // Two machines with the same host name must not read the same here: what
  // follows can revoke a device.
  const options = environments.map(({ environmentId, label, routes }) => ({
    id: environmentId,
    label:
      labels.indexOf(label) === labels.lastIndexOf(label) || !routes[0]
        ? label
        : `${label} (${hostOf(routes[0].endpoint)})`,
  }))
  const choice = (
    <>
      <ChoiceGroup
        name="settings-environment"
        label="Applies to"
        value={chosen?.environmentId ?? ''}
        options={options}
        onChange={(environment) =>
          void navigate({
            to: '/settings',
            search: (previous) => ({ ...previous, environment }),
            replace: true,
          })
        }
      />
      {unreachable ? (
        <p className="mt-2 text-[13px] text-muted-foreground">
          {chosen.label} isn’t connected right now.
        </p>
      ) : null}
    </>
  )
  if (within) return choice
  return <SettingsSection title="Applies to">{choice}</SettingsSection>
}

/**
 * Hands the settings under it the environment they act on. The open
 * environment's providers are already around this page and are left to speak
 * for it; for any other, what they say about the open one is put out of reach,
 * and only what its own client can say stands in for it.
 */
function EnvironmentScope({
  environmentId,
  children,
}: {
  environmentId: string | undefined
  children: ReactNode
}) {
  const open = useEnvironmentClientOptional()
  const client = useEnvironmentClients().clients[environmentId ?? ''] ?? null
  if (client === open) return children
  return (
    <EnvironmentClientProvider client={client}>
      <SessionStateContext.Provider value={null}>
        <ComposerStateContext.Provider value={null}>
          {client ? (
            <EnvironmentPlatformCapabilitiesProvider>
              {children}
            </EnvironmentPlatformCapabilitiesProvider>
          ) : (
            <PlatformCapabilitiesContext.Provider value={null}>
              {children}
            </PlatformCapabilitiesContext.Provider>
          )}
        </ComposerStateContext.Provider>
      </SessionStateContext.Provider>
    </EnvironmentClientProvider>
  )
}

/**
 * Settings an environment keeps for itself, under the choice of which. Given a
 * section, the choice sits inside it, under its heading: beside the list of
 * environments, a second heading of its own would read as a second list.
 */
function EnvironmentSettings({
  section,
  children,
}: {
  section?: { title: string; description: (name: string) => string }
  children: (environment: StoredEnvironment | undefined, name: string) => ReactNode
}) {
  const chosen = useSettingsEnvironment()
  const name = chosen?.label ?? 'this environment'
  const scoped = (
    // By environment: nothing typed or open for one may reach the next.
    <EnvironmentScope key={chosen?.environmentId} environmentId={chosen?.environmentId}>
      {children(chosen, name)}
    </EnvironmentScope>
  )
  if (section) {
    return (
      <SettingsSection title={section.title} description={section.description(name)}>
        <EnvironmentChoice chosen={chosen} within />
        {scoped}
      </SettingsSection>
    )
  }
  return (
    <>
      <EnvironmentChoice chosen={chosen} />
      {scoped}
    </>
  )
}

const PROVIDER_TONE_CLASS: Record<ProviderHealthTone, string> = {
  ready: 'bg-emerald-400',
  warning: 'bg-amber-400',
  error: 'bg-red-400',
  muted: 'bg-[var(--basis-text-faint)]',
}

/**
 * Provider health as the environment reports it, with the same wording as the
 * desktop settings menu. Settings also renders with no environment connected,
 * where there are no providers to describe and the section stays out.
 */
function ProvidersPanel({ name }: { name: string }) {
  const platform = useContext(PlatformCapabilitiesContext)
  const activeWorkspacePath = useContext(SessionStateContext)?.activeWorkspacePath ?? null
  const rows = useMemo(() => {
    const now = Date.now()
    return (platform?.providers ?? []).map((provider) => {
      const health = describeProviderHealth(platform?.providerHealthByProvider[provider.id], now)
      // A probe this client just asked for reads as checking straight away.
      const checking = platform?.agentUiStatusByProvider[provider.id] === 'probing'
      const agentInfo = platform?.acpAgentInfoByProvider[provider.id]
      return {
        id: provider.id,
        displayName: provider.displayName,
        name: agentInfo?.name
          ? `${agentInfo.name}${agentInfo.version ? ` ${agentInfo.version}` : ''}`
          : provider.displayName,
        health: checking
          ? { ...health, label: 'Checking…', tone: 'muted' as const, canRetry: false }
          : health,
      }
    })
  }, [platform])
  if (!platform) {
    return (
      <SettingsSection title="Providers">
        <p className="mt-2 text-[13px] text-muted-foreground">
          Connect to an environment to see its providers.
        </p>
      </SettingsSection>
    )
  }

  return (
    <SettingsSection title="Providers" description={`The coding agents ${name} can run.`}>
      {rows.length === 0 ? (
        <p className="mt-2 text-[13px] text-muted-foreground">
          {name} has not reported any providers.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-3 rounded-lg bg-hover/70 px-3 py-2.5">
              <ProviderIcon providerId={row.id} className="h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-foreground">{row.name}</div>
                <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  <span
                    aria-hidden
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      PROVIDER_TONE_CLASS[row.health.tone],
                    )}
                  />
                  <span className="truncate">
                    {row.health.label}
                    {row.health.detail ? ` · ${row.health.detail}` : ''}
                  </span>
                </div>
              </div>
              {row.health.canRetry ? (
                <Button
                  type="button"
                  variant="tertiary"
                  aria-label={`Retry ${row.displayName}`}
                  onClick={() => void platform.retryProvider(row.id, activeWorkspacePath ?? '')}
                >
                  Retry
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {platform.error ? (
        <p role="alert" className="mt-2 text-[12px] text-destructive">
          {platform.error}
        </p>
      ) : null}
    </SettingsSection>
  )
}

/** The tool that names an environment's sessions, kept by the environment. */
function SessionTitlesSetting({ name }: { name: string }) {
  return (
    <TitleGenerationSettingControl
      section={(field) => (
        <SettingsSection
          title="Session titles"
          description={`Names each session from its first message, using a model on ${name}.`}
        >
          {field}
        </SettingsSection>
      )}
    />
  )
}

function EnvironmentsPanel() {
  const {
    ui,
    environments,
    selectedId,
    inUseEndpoint,
    connect,
    selectEnvironment,
    removeEnvironment,
    chooseRoute,
    removeRoute,
    addRoute,
    checkRoutes,
    changeEnvironment,
    confirmRoute,
    declineRoute,
  } = useConnection()
  const { clients } = useEnvironmentClients()
  // Connected, on a server that knows the command: the name comes from the
  // server itself, and the server is who renames.
  const renameTarget = (environmentId: string): EnvironmentRenameTarget | undefined => {
    const client = clients[environmentId]
    if (!client?.supports('renameEnvironment') || !isEnvironmentReachable(client)) return undefined
    const label = client.getState().environment?.name
    if (!label) return undefined
    return {
      label,
      rename: async (next) => {
        try {
          await client.commands.renameEnvironment(next)
        } catch (error) {
          if (error instanceof EnvironmentClientError && error.code === 'capability_missing') {
            throw new Error('This device needs admin access to rename the environment.', {
              cause: error,
            })
          }
          throw error
        }
      },
    }
  }
  // Kept above this page, which remounts when connecting drops the old client.
  const draft = useAddEnvironmentDraft()
  // With nothing saved the form is the whole point of the section.
  const formOpen = draft.open || environments.length === 0
  useEffect(() => {
    trackAddEnvironment(ui.kind === 'ready', inUseEndpoint)
  }, [ui.kind, inUseEndpoint])
  const status =
    ui.kind === 'confirm_route'
      ? 'A new route is waiting for your answer'
      : connectionStatusLabel(ui)

  return (
    <>
      <SettingsSection title="Environments" description={status}>
        {ui.kind === 'confirm_route' ? (
          <RouteOfferPrompt
            className="mt-3"
            state={ui}
            handlers={{ onConfirmRoute: confirmRoute, onDeclineRoute: declineRoute }}
          />
        ) : null}
        <EnvironmentList
          environments={environments}
          selectedId={selectedId}
          inUseEndpoint={inUseEndpoint}
          renameTarget={renameTarget}
          onSelect={selectEnvironment}
          onRemove={removeEnvironment}
          onDisconnect={changeEnvironment}
          onChooseRoute={chooseRoute}
          onRemoveRoute={removeRoute}
          onAddRoute={addRoute}
          onCheckRoutes={checkRoutes}
        />
        {formOpen && ui.kind !== 'confirm_route' ? (
          <div className="mt-2 rounded-lg bg-hover/70 p-3">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-medium text-foreground">Add environment</h3>
              {environments.length > 0 ? (
                <Tooltip content="Cancel">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-compact"
                    aria-label="Cancel adding an environment"
                    onClick={closeAddEnvironment}
                  >
                    <XIcon />
                  </Button>
                </Tooltip>
              ) : null}
            </div>
            <EnvironmentConnectForm
              className="mt-2.5"
              initialEndpoint={draft.endpoint}
              initialCredential={draft.credential}
              onDraftChange={editAddEnvironment}
              onConnect={(endpoint, credential) => {
                sendAddEnvironment(endpoint)
                connect(endpoint, credential)
              }}
              submitLabel="Add environment"
            />
          </div>
        ) : environments.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="compact"
            className="mt-2"
            leadingIcon={AddIcon}
            onClick={openAddEnvironment}
          >
            Add environment
          </Button>
        ) : null}
      </SettingsSection>
      <ConnectedEnvironmentSettings />
    </>
  )
}

/** Settings an environment keeps for all of its clients. */
function ConnectedEnvironmentSettings() {
  return (
    <EnvironmentSettings
      section={{
        title: 'Add project starts in',
        description: (name) => `Where Add project opens on ${name}, on every device.`,
      }}
    >
      {() => <AddProjectStartSetting section={(field) => field} />}
    </EnvironmentSettings>
  )
}

/** Who can reach an environment, kept by the environment itself. */
function DevicesPanel() {
  const { selectedId, inUseEndpoint, links, replaceCredential } = useConnection()
  return (
    <EnvironmentSettings>
      {(environment, name) => {
        const environmentId = environment?.environmentId
        return (
          <DevicesSettingControl
            environmentName={environment?.label}
            pairing={
              environment
                ? {
                    environmentId: environment.environmentId,
                    routes: environment.routes,
                    inUseEndpoint:
                      environmentId === selectedId
                        ? inUseEndpoint
                        : (links.find((link) => link.environmentId === environmentId)?.endpoint ??
                          null),
                    appUrl: pairingAppUrl(),
                  }
                : undefined
            }
            section={(body) => (
              <SettingsSection
                title="Devices"
                description={`Who can reach ${name}. Revoking a device disconnects it at once.`}
              >
                {body}
              </SettingsSection>
            )}
            onCredentialRotated={
              environmentId
                ? (credential) => replaceCredential(environmentId, credential)
                : undefined
            }
          />
        )
      }}
    </EnvironmentSettings>
  )
}

const APPEARANCE_MODES: ReadonlyArray<{ id: AppearanceMode; label: string; icon: typeof SunIcon }> =
  [
    { id: 'light', label: 'Light', icon: SunIcon },
    { id: 'dark', label: 'Dark', icon: MoonIcon },
    { id: 'system', label: 'System', icon: MonitorIcon },
  ]

/** Light, Dark and System as three icons in one quiet track; the mode in use is filled. */
function ModePicker({
  value,
  onChange,
}: {
  value: AppearanceMode
  onChange: (mode: AppearanceMode) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Mode"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-hover/70 p-0.5"
    >
      {APPEARANCE_MODES.map((option) => {
        const selected = option.id === value
        const Icon = option.icon
        return (
          <Tooltip key={option.id} content={option.label}>
            <label
              className={cn(
                'flex size-8 cursor-pointer items-center justify-center rounded-md transition-colors duration-100',
                'has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-focus-ring',
                selected
                  ? 'bg-active text-foreground'
                  : 'text-muted-foreground hover:bg-hover hover:text-foreground',
              )}
            >
              <input
                type="radio"
                className="sr-only"
                name="appearance-mode"
                value={option.id}
                checked={selected}
                aria-label={option.label}
                onChange={() => onChange(option.id)}
              />
              <Icon aria-hidden size={16} weight={selected ? 'fill' : 'regular'} />
            </label>
          </Tooltip>
        )
      })}
    </div>
  )
}

/** Each face as a tile that shows it: "Aa" set in the font, its name beneath. */
const FONT_FAMILIES: Record<UiFontId, string> = {
  geist: 'var(--font-geist-sans)',
  inter: 'var(--font-inter-sans)',
  'public-sans': 'var(--font-public-sans)',
  system: 'var(--font-system-sans)',
}

function FontPicker({ value, onChange }: { value: UiFontId; onChange: (font: UiFontId) => void }) {
  return (
    <div role="radiogroup" aria-label="Font" className="mt-3 grid grid-cols-4 gap-1.5">
      {UI_FONTS.map((font) => {
        const selected = font.id === value
        return (
          <label
            key={font.id}
            className={cn(
              // Selection is a fill, never an outline.
              'flex cursor-pointer flex-col items-center gap-1 rounded-lg px-2 pb-2 pt-3 transition-colors duration-100',
              'has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-focus-ring',
              selected ? 'bg-active' : 'bg-hover/70 hover:bg-hover',
            )}
          >
            <input
              type="radio"
              className="sr-only"
              name="font"
              value={font.id}
              checked={selected}
              aria-label={font.label}
              onChange={() => onChange(font.id)}
            />
            <span
              aria-hidden
              className={cn(
                'text-[22px] leading-7',
                selected ? 'text-foreground' : 'text-muted-foreground',
              )}
              style={{ fontFamily: FONT_FAMILIES[font.id] }}
            >
              Aa
            </span>
            <span
              className={cn(
                'truncate text-[12px]',
                selected ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {font.label}
            </span>
          </label>
        )
      })}
    </div>
  )
}

function AppearancePanel() {
  const { mode, setMode, scheme, family, setFamily, font, setFont } = useTheme()
  return (
    <>
      <section>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-[13px] font-medium text-foreground">Theme</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {mode === 'system' ? 'Follows this device’s light or dark setting.' : null}
              {mode === 'light' ? 'Always light.' : null}
              {mode === 'dark' ? 'Always dark.' : null}
            </p>
          </div>
          <ModePicker value={mode} onChange={setMode} />
        </div>
        <ThemeFamilyPicker value={family.id} scheme={scheme} onChange={setFamily} />
      </section>
      <SettingsSection title="Font">
        <FontPicker value={font} onChange={setFont} />
      </SettingsSection>
    </>
  )
}

const ENTER_WHILE_RUNNING_CHOICES: ReadonlyArray<{ id: FollowUpAction; label: string }> = [
  { id: 'queue', label: 'Queue' },
  { id: 'steer', label: 'Steer' },
]

function ChatPanel() {
  const [enterWhileRunning, setEnterWhileRunning] = useEnterWhileRunning()
  return (
    <SettingsSection
      title="While a turn runs, Enter…"
      description="Steer adds your message to the running turn. Agents that can’t steer queue it instead."
    >
      <ChoiceGroup
        name="enter-while-running"
        label="While a turn runs, Enter"
        value={enterWhileRunning}
        options={ENTER_WHILE_RUNNING_CHOICES}
        onChange={setEnterWhileRunning}
      />
    </SettingsSection>
  )
}

function NotificationsPanel() {
  return (
    <SettingsSection
      title="Session notifications"
      description="A browser notification when a session in any environment finishes, needs your input, or stops with an error — unless it is the session you are looking at. Kept on this device only."
    >
      <NotificationsSettingControl
        choices={(value, onChange, disabled) => (
          <ChoiceGroup
            name="notifications"
            label="Session notifications"
            value={value}
            options={NOTIFICATIONS_CHOICES}
            onChange={onChange}
            disabled={disabled}
          />
        )}
      />
    </SettingsSection>
  )
}

const PANELS: Record<SettingsTab, () => ReactNode> = {
  environments: EnvironmentsPanel,
  devices: DevicesPanel,
  appearance: AppearancePanel,
  chat: ChatPanel,
  notifications: NotificationsPanel,
  providers: () => (
    <EnvironmentSettings>
      {(_, name) => (
        <>
          <ProvidersPanel name={name} />
          <SessionTitlesSetting name={name} />
        </>
      )}
    </EnvironmentSettings>
  ),
}

function SettingsPage() {
  const navigate = useNavigate()
  const tab = Route.useSearch().tab ?? 'environments'
  const selectedIndex = SETTINGS_TABS.findIndex((item) => item.id === tab)
  const Panel = PANELS[tab]

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto px-4 pb-10 pt-4 sm:px-8">
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="text-[18px] font-medium text-foreground">Settings</h1>
        <TabsSubtle
          aria-label="Settings sections"
          idPrefix="settings"
          size="compact"
          className="mt-4"
          selectedIndex={selectedIndex}
          onSelect={(index) =>
            void navigate({
              to: '/settings',
              search: (previous) => ({ ...previous, tab: SETTINGS_TABS[index]!.id }),
              replace: true,
            })
          }
        >
          {SETTINGS_TABS.map((item, index) => (
            <TabsSubtleItem key={item.id} index={index} label={item.label} />
          ))}
        </TabsSubtle>
        {SETTINGS_TABS.map((item, index) => (
          <TabsSubtlePanel
            key={item.id}
            index={index}
            selectedIndex={selectedIndex}
            idPrefix="settings"
            className="mt-8"
          >
            <Panel />
          </TabsSubtlePanel>
        ))}
      </div>
    </div>
  )
}
