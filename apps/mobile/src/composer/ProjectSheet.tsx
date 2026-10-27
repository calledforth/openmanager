import {
  CaretLeftIcon,
  CaretRightIcon,
  CheckIcon,
  DesktopIcon,
  FolderIcon,
  MagnifyingGlassIcon,
} from 'phosphor-react-native'
import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, ScrollView, TextInput, useWindowDimensions, View } from 'react-native'
import {
  folderName,
  visibleFolders,
  type FolderEntry,
  type WorkspaceEntry,
} from '@openmanager/app-core/logic'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { ProjectMark } from '../ui/ProjectMark'
import { Sheet } from '../ui/Sheet'

/** A folder as `filesystem.browse` lists it. */
export interface FolderListing {
  path: string
  parentPath: string | null
  entries: FolderEntry[]
  /** Folders left off the end of a listing too large to send whole. */
  omitted?: number
  readable: boolean
}

/** What the project sheet can ask of the environment. */
export interface ProjectSource {
  /** The environment the groups belong to, by its name. */
  environmentLabel: string
  /** Projects with session activity, newest first. */
  recents: readonly WorkspaceEntry[]
  /** Every project the environment has. */
  workspaces: readonly WorkspaceEntry[]
  current: string | null
  pick: (path: string) => void
  /**
   * `filesystem.browse`; absent when the environment does not offer it.
   * Without a path, the folder the environment starts Add project in.
   */
  browse?: (path?: string) => Promise<FolderListing>
  /** Add the browsed folder as a project and pick it; absent when it cannot. */
  add?: (path: string) => Promise<void>
}

function Option({
  title,
  detail,
  on,
  icon,
  trailing,
  disabledReason,
  onPress,
}: {
  title: string
  detail?: string
  on?: boolean
  icon: React.ReactNode
  trailing?: React.ReactNode
  disabledReason?: string | null
  onPress: () => void
}) {
  const theme = usePhoneTheme()
  const disabled = !!disabledReason
  return (
    <Press
      accessibilityRole="menuitem"
      accessibilityLabel={title}
      accessibilityHint={disabledReason ?? detail}
      accessibilityState={{ selected: on, disabled }}
      disabled={disabled}
      onPress={() => {
        tap()
        onPress()
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 14,
        opacity: disabled ? 0.45 : 1,
        backgroundColor: on ? theme.active : pressed ? theme.hover : 'transparent',
      })}
    >
      {icon}
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText
          variant="text-14-regular"
          numberOfLines={1}
          style={{ color: theme.fg, fontSize: 15 }}
        >
          {title}
        </AppText>
        {disabledReason || detail ? (
          <AppText variant="text-12-regular" numberOfLines={1} style={{ color: theme.faint }}>
            {disabledReason ?? detail}
          </AppText>
        ) : null}
      </View>
      {trailing ?? (on ? <CheckIcon size={16} color={theme.fg} weight="bold" /> : null)}
    </Press>
  )
}

function Heading({ children, icon }: { children: string; icon?: React.ReactNode }) {
  const theme = usePhoneTheme()
  return (
    <View
      accessibilityRole="header"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingTop: 8,
        paddingBottom: 6,
        paddingHorizontal: 12,
      }}
    >
      {icon}
      <AppText variant="text-12-medium" style={{ color: theme.faint, letterSpacing: 0.6 }}>
        {children.toUpperCase()}
      </AppText>
    </View>
  )
}

/** The folder browser, the sheet's second page: walk down, back up, use one. */
function FolderBrowser({
  source,
  onBack,
  onDone,
}: {
  source: ProjectSource
  onBack: () => void
  onDone: () => void
}) {
  const theme = usePhoneTheme()
  // Where the environment starts Add project (its setting, else home), as web's browser does.
  const [path, setPath] = useState<string | undefined>(undefined)
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  useEffect(() => {
    let live = true
    setListing(null)
    setFailure(null)
    source.browse!(path).then(
      (next) => {
        if (live) setListing(next)
      },
      (error: unknown) => {
        if (live) setFailure(error instanceof Error ? error.message : 'Could not list that folder.')
      },
    )
    return () => {
      live = false
    }
  }, [path, source.browse])
  const folders = listing ? visibleFolders(listing.entries, '') : []
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 }}>
        <Press
          accessibilityRole="button"
          accessibilityLabel="Back to projects"
          onPress={onBack}
          style={({ pressed }) => ({
            width: 32,
            height: 32,
            borderRadius: 16,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? theme.active : theme.hover,
          })}
        >
          <CaretLeftIcon size={16} color={theme.fg} />
        </Press>
        <AppText
          variant="text-13-regular"
          numberOfLines={1}
          style={{ flex: 1, color: theme.muted }}
        >
          {listing?.path ?? path ?? ''}
        </AppText>
      </View>
      {failure ? (
        <AppText variant="text-13-regular" style={{ color: theme.status.error, padding: 12 }}>
          {failure}
        </AppText>
      ) : !listing ? (
        <ActivityIndicator style={{ padding: 16 }} color={theme.muted} />
      ) : (
        <View>
          {listing.parentPath ? (
            <Option
              title=".."
              icon={<FolderIcon size={16} color={theme.muted} />}
              onPress={() => setPath(listing.parentPath!)}
            />
          ) : null}
          {!listing.readable ? (
            <AppText variant="text-13-regular" style={{ color: theme.muted, padding: 12 }}>
              The environment may not list this folder.
            </AppText>
          ) : null}
          {folders.map((entry) => (
            <Option
              key={entry.path}
              title={entry.name}
              icon={<FolderIcon size={16} color={theme.muted} />}
              trailing={<CaretRightIcon size={14} color={theme.faint} />}
              onPress={() => setPath(entry.path)}
            />
          ))}
          {listing.omitted ? (
            <AppText variant="text-12-regular" style={{ color: theme.faint, padding: 12 }}>
              {listing.omitted === 1
                ? '1 more folder is not listed here.'
                : `${listing.omitted} more folders are not listed here.`}
            </AppText>
          ) : null}
          <Press
            accessibilityRole="button"
            accessibilityLabel={`Use ${folderName(listing.path)}`}
            accessibilityHint={source.add ? undefined : 'This environment cannot add projects'}
            accessibilityState={{ disabled: !source.add || adding, busy: adding }}
            disabled={!source.add || adding}
            onPress={() => {
              tap()
              setAdding(true)
              source.add!(listing.path).then(onDone, (error: unknown) => {
                setAdding(false)
                setFailure(error instanceof Error ? error.message : 'Could not add the project.')
              })
            }}
            style={({ pressed }) => ({
              marginTop: 8,
              alignItems: 'center',
              paddingVertical: 11,
              borderRadius: 14,
              backgroundColor: source.add
                ? pressed
                  ? theme.actionHover
                  : theme.actionBg
                : theme.hover,
              opacity: adding ? 0.6 : 1,
            })}
          >
            <AppText
              variant="text-14-medium"
              style={{ color: source.add ? theme.actionFg : theme.faint }}
            >
              {source.add
                ? `Use ${folderName(listing.path)}`
                : 'This environment cannot add projects'}
            </AppText>
          </Press>
        </View>
      )}
    </View>
  )
}

/**
 * The project picker for a new session: search, recents, then the
 * environment's projects under its name, and Browse a folder… at the end,
 * which opens the folder browser as a second page of the same sheet.
 */
export function ProjectSheet({
  source,
  onClose,
  browse = false,
}: {
  source: ProjectSource
  onClose: () => void
  /** Open on the folder browser (Add project), rather than the list. */
  browse?: boolean
}) {
  const theme = usePhoneTheme()
  const { height } = useWindowDimensions()
  const [query, setQuery] = useState('')
  const [browsing, setBrowsing] = useState(browse && !!source.browse)
  const needle = query.trim().toLowerCase()
  const matches = (entry: WorkspaceEntry) =>
    !needle ||
    entry.name.toLowerCase().includes(needle) ||
    entry.path.toLowerCase().includes(needle)
  const recents = useMemo(() => source.recents.slice(0, 3), [source.recents])
  const pick = (entry: WorkspaceEntry) => {
    source.pick(entry.path)
    onClose()
  }
  const unavailable = (entry: WorkspaceEntry) =>
    entry.availability && entry.availability !== 'available'
      ? 'Not on disk on the environment right now'
      : entry.missing
        ? 'Not on disk on the environment right now'
        : null
  const row = (entry: WorkspaceEntry) => (
    <Option
      key={entry.path}
      title={entry.name}
      detail={entry.path}
      on={entry.path === source.current}
      icon={<ProjectMark workspaceId={entry.path} name={entry.name} size={16} />}
      disabledReason={unavailable(entry)}
      onPress={() => pick(entry)}
    />
  )
  return (
    <Sheet onDismiss={onClose} onBack={browsing ? () => setBrowsing(false) : onClose}>
      <ScrollView style={{ maxHeight: height * 0.62 }} keyboardShouldPersistTaps="handled">
        {browsing && source.browse ? (
          <FolderBrowser source={source} onBack={() => setBrowsing(false)} onDone={onClose} />
        ) : (
          <View>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                marginHorizontal: 4,
                marginBottom: 6,
                paddingHorizontal: 12,
                borderRadius: 14,
                backgroundColor: theme.hover,
              }}
            >
              <MagnifyingGlassIcon size={16} color={theme.faint} />
              <TextInput
                accessibilityLabel="Search projects"
                value={query}
                onChangeText={setQuery}
                placeholder="Search projects"
                placeholderTextColor={theme.faint}
                autoCorrect={false}
                autoCapitalize="none"
                style={{
                  flex: 1,
                  paddingVertical: 10,
                  color: theme.fg,
                  fontFamily: 'Geist-Regular',
                  fontSize: 14,
                }}
              />
            </View>
            {!needle && recents.length > 0 ? (
              <>
                <Heading>Recent</Heading>
                {recents.map(row)}
              </>
            ) : null}
            <Heading icon={<DesktopIcon size={13} color={theme.faint} />}>
              {source.environmentLabel}
            </Heading>
            {source.workspaces.filter(matches).map(row)}
            <Option
              title="Browse a folder…"
              icon={<FolderIcon size={16} color={theme.muted} />}
              trailing={<CaretRightIcon size={14} color={theme.faint} />}
              disabledReason={source.browse ? null : 'This environment cannot browse its folders'}
              onPress={() => setBrowsing(true)}
            />
          </View>
        )}
      </ScrollView>
    </Sheet>
  )
}
