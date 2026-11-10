import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ProviderId } from '@agentpack/contract'
import type { SearchHighlight } from '@openmanager/protocol'
import {
  CommandMenu,
  CommandMenuDialog,
  CommandMenuEmpty,
  CommandMenuInput,
  CommandMenuItem,
  CommandMenuList,
  type CommandMenuItemData,
} from '../fluid/ui/command-menu'
import { ProviderIcon } from '../providers/ProviderIcon'
import { formatRelativeTime, useNow } from '../../lib/relative-time'
import {
  chatSearchStatus,
  matchesWords,
  searchWords,
  snippetRuns,
  useChatSearch,
  withoutLeadingEllipsis,
  type ChatSearchSource,
  type PlacedSearchHit,
} from '../../lib/chat-search'
import { cn } from '../../lib/utils'

/** ⌘⇧F, as "find in files" is in an editor: ⌘F stays the browser's. */
export const SEARCH_SHORTCUT = 'mod+shift+f'

/** One session the palette can list and open, on whichever environment it is. */
export interface SearchableSession {
  environmentId: string
  externalId: string
  title?: string
  providerId: ProviderId
  workspacePath: string
  workspaceName?: string
  updatedAt?: string
}

const RECENT_LIMIT = 8
const TITLE_LIMIT = 8

// Joined on a NUL so ids with spaces cannot collide.
const key = (environmentId: string, externalId: string) => `${environmentId}\u0000${externalId}`
const newestFirst = (a: SearchableSession, b: SearchableSession) =>
  (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')

const listeners = new Set<() => void>()

/** Opens the search palette from anywhere (a ⌘K row, a sidebar button). */
export function requestSearch(): void {
  listeners.forEach((listener) => listener())
}

type Row =
  | { kind: 'session'; session: SearchableSession }
  | { kind: 'message'; session: SearchableSession; hit: PlacedSearchHit }

export interface SearchPaletteDialogProps {
  /**
   * The palette's body, mounted only while it is open: whatever reads the
   * sessions for it then reads nothing while it is shut.
   */
  children: ReactNode
  /** @default SEARCH_SHORTCUT */
  shortcut?: string | null
}

/** The search palette's shell: the shortcut, `requestSearch`, the floating card. */
export function SearchPaletteDialog({
  children,
  shortcut = SEARCH_SHORTCUT,
}: SearchPaletteDialogProps) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const listener = () => setOpen(true)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return (
    <CommandMenuDialog
      title="Search sessions"
      description="Search session titles and what was said in them."
      open={open}
      onOpenChange={setOpen}
      shortcut={shortcut}
      className="max-w-[640px]"
    >
      {children}
    </CommandMenuDialog>
  )
}

export interface SearchPaletteBodyProps {
  /** Every session listed, across the environments. */
  sessions: readonly SearchableSession[]
  /** The environments that can search their messages now. Keep it stable. */
  sources: readonly ChatSearchSource[]
  /** Names each environment, shown on rows when there is more than one. */
  environmentName?: (environmentId: string) => string | undefined
  onOpenSession: (session: SearchableSession) => void
}

/**
 * Search over every environment's sessions: titles and projects match at
 * once from what the sidebar already holds; what was said in them comes from
 * each environment's `search.messages` as typing settles, one row per
 * session at its best message. With nothing typed it lists the recent ones.
 * Mounted fresh each time the palette opens, so the field starts empty.
 *
 * The look is the ⌘K palette's: the same card, the same bare field, the same
 * headings and row heights, so the two read as one family.
 */
export function SearchPaletteBody({
  sessions,
  sources,
  environmentName,
  onOpenSession,
}: SearchPaletteBodyProps) {
  const [query, setQuery] = useState('')
  const search = useChatSearch(query, sources)
  const now = useNow()
  const showEnvironment = new Set(sessions.map((session) => session.environmentId)).size > 1

  const { items, rows } = useMemo(() => {
    const words = searchWords(query)
    const rows = new Map<string, Row>()
    const items: CommandMenuItemData[] = []
    const add = (value: string, row: Row, group: string) => {
      rows.set(value, row)
      items.push({
        value,
        label: row.session.title ?? 'Untitled',
        group,
        onSelect: () => onOpenSession(row.session),
      })
    }
    if (words.length === 0) {
      for (const session of [...sessions].sort(newestFirst).slice(0, RECENT_LIMIT)) {
        add(
          `recent:${key(session.environmentId, session.externalId)}`,
          { kind: 'session', session },
          'Recent',
        )
      }
      return { items, rows }
    }
    const titled = new Set<string>()
    for (const session of sessions
      .filter((s) => matchesWords(words, s.title, s.workspaceName))
      .sort(newestFirst)
      .slice(0, TITLE_LIMIT)) {
      titled.add(key(session.environmentId, session.externalId))
      add(
        `session:${key(session.environmentId, session.externalId)}`,
        { kind: 'session', session },
        'Sessions',
      )
    }
    const byKey = new Map(sessions.map((s) => [key(s.environmentId, s.externalId), s]))
    for (const hit of search.hits) {
      const id = key(hit.environmentId, hit.sessionId)
      const session = byKey.get(id)
      // A session already listed by its title is not listed twice; one the
      // sidebar does not hold (yet) cannot be opened from here.
      if (!session || titled.has(id)) continue
      add(`message:${id}`, { kind: 'message', session, hit }, 'Messages')
    }
    return { items, rows }
  }, [query, sessions, search.hits, onOpenSession])

  const status = chatSearchStatus(query, search, sources.length, environmentName)
  const typed = query.trim() !== ''
  const searching = typed && search.pending

  return (
    <CommandMenu items={items} filter={keepAll} query={query} onQueryChange={setQuery}>
      {/* No icon in the field, as in ⌘K: the placeholder says what this is,
          and the text then starts where the headings under it do. */}
      <CommandMenuInput
        icon={null}
        placeholder="Search sessions and messages…"
        className="text-[15px] leading-6"
      />
      <CommandMenuList
        className="gap-0 px-1.5 pb-1.5 pt-0.5"
        renderItem={(item) => {
          const row = rows.get(item.value)
          if (!row) return null
          return (
            <SearchRow
              value={item.value}
              row={row}
              now={now}
              environment={
                showEnvironment ? environmentName?.(row.session.environmentId) : undefined
              }
            />
          )
        }}
      >
        {/* "Searching…" holds the place "Nothing matches" will take, at the
            same height, so the card does not jump when the answer lands;
            fainter, because it is passing. */}
        <CommandMenuEmpty className={cn(searching && 'text-faint')}>
          {!typed
            ? 'No sessions yet.'
            : searching
              ? 'Searching…'
              : `Nothing matches “${query.trim()}”.`}
        </CommandMenuEmpty>
      </CommandMenuList>
      {status && (
        <div
          role="status"
          aria-live="polite"
          className="shrink-0 px-4 pb-2.5 pt-1 text-[12px] text-muted-foreground"
        >
          {status}
        </div>
      )}
    </CommandMenu>
  )
}

const keepAll = () => true

/**
 * A row for a session, or for a session at the message that matched. Both
 * share one grid: the mark in a 20px line box, the title line at the same
 * height, the trailing meta in another, so on a two-line row the mark, the
 * title and the meta all sit on the first line.
 */
function SearchRow({
  value,
  row,
  now,
  environment,
}: {
  value: string
  row: Row
  now: number
  environment?: string
}) {
  const { session } = row
  const when = formatRelativeTime(row.kind === 'message' ? row.hit.at : session.updatedAt, now)
  const snippet = row.kind === 'message' ? withoutLeadingEllipsis(row.hit) : null
  return (
    <CommandMenuItem
      value={value}
      className={cn(
        'gap-3 px-3 text-[14px] text-foreground',
        row.kind === 'message' ? 'h-auto items-start py-2' : 'h-11',
      )}
    >
      {/* The mark alone, as on a sidebar card; the name is for hover and
          assistive tech. */}
      <span className="flex h-5 shrink-0 items-center" title={session.providerId}>
        <ProviderIcon providerId={session.providerId} className="h-4 w-4 opacity-80" />
        <span className="sr-only">{session.providerId}</span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2 leading-5">
          <span className="truncate">{session.title ?? 'Untitled'}</span>
          {session.workspaceName && (
            <span className="shrink-0 truncate text-muted-foreground/70">
              {session.workspaceName}
            </span>
          )}
        </span>
        {row.kind === 'message' && snippet && (
          <span className="mt-0.5 line-clamp-2 text-[13px] leading-5 text-muted-foreground">
            {/* "You:" the way a chat list previews the last line: whose words
                these are, without a second column for it. */}
            {row.hit.role === 'user' && <span className="text-muted-foreground/70">You: </span>}
            <Highlighted text={snippet.text} highlights={snippet.highlights} />
          </span>
        )}
      </span>
      {/* Ages right-aligned in a column of their own, so the environment
          names line up too instead of ending wherever "2h" or "12h" lets
          them. Dates ("Oct 3") are wider and simply take their room. */}
      <span className="flex h-5 shrink-0 items-center gap-3 text-[12px] text-muted-foreground/70">
        {environment && <span className="max-w-[10rem] truncate">{environment}</span>}
        {when && <span className="min-w-[3ch] text-right tabular-nums">{when}</span>}
      </span>
    </CommandMenuItem>
  )
}

/** The snippet with its matched runs at full strength. */
function Highlighted({
  text,
  highlights,
}: {
  text: string
  highlights: readonly SearchHighlight[]
}) {
  return (
    <>
      {snippetRuns(text, highlights).map((run) =>
        run.match ? (
          <mark key={run.start} className="bg-transparent font-medium text-foreground">
            {run.text}
          </mark>
        ) : (
          run.text
        ),
      )}
    </>
  )
}
