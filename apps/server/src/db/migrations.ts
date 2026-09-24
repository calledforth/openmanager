import type { DatabaseSync } from 'node:sqlite'
import type { Migration } from './migrate.ts'

/**
 * Forward-only numbered migrations for `openmanager.sqlite`.
 * Append the next integer version; never edit a migration that has shipped.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'composer_profiles',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS provider_profiles (
          provider_id TEXT PRIMARY KEY NOT NULL,
          agent_info_json TEXT,
          available_models_json TEXT,
          available_modes_json TEXT,
          default_model_id TEXT,
          default_mode_id TEXT,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS workspace_composer_preferences (
          workspace_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          model_id TEXT,
          mode_id TEXT,
          config_values_json TEXT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, provider_id)
        ) STRICT;
      `)
    },
  },
  {
    version: 2,
    name: 'environment_domain_model',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS environment_metadata (
          singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
          environment_id TEXT NOT NULL UNIQUE,
          label TEXT NOT NULL,
          metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS authorized_clients (
          client_id TEXT PRIMARY KEY NOT NULL,
          label TEXT NOT NULL,
          credential_hash BLOB NOT NULL UNIQUE,
          scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER,
          revoked_at INTEGER
        ) STRICT;

        CREATE TABLE IF NOT EXISTS workspaces (
          workspace_id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          availability TEXT NOT NULL DEFAULT 'available'
            CHECK (availability IN ('available', 'missing', 'inaccessible')),
          metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY NOT NULL,
          workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
          parent_session_id TEXT,
          provider_id TEXT NOT NULL,
          provider_session_id TEXT,
          created_by_client_id TEXT REFERENCES authorized_clients(client_id) ON DELETE SET NULL,
          title TEXT,
          title_source TEXT CHECK (
            title_source IS NULL OR title_source IN ('fallback', 'provider', 'user')
          ),
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (parent_session_id, workspace_id)
            REFERENCES sessions(session_id, workspace_id) ON DELETE CASCADE,
          UNIQUE (session_id, workspace_id),
          UNIQUE (provider_id, provider_session_id)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS sessions_workspace_id_idx ON sessions(workspace_id);
        CREATE INDEX IF NOT EXISTS sessions_parent_session_id_idx ON sessions(parent_session_id);
        CREATE INDEX IF NOT EXISTS sessions_created_by_client_id_idx
          ON sessions(created_by_client_id);

        CREATE TABLE IF NOT EXISTS threads (
          thread_id TEXT PRIMARY KEY NOT NULL,
          session_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          provider_thread_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (session_id, workspace_id)
            REFERENCES sessions(session_id, workspace_id) ON DELETE CASCADE,
          UNIQUE (thread_id, session_id),
          UNIQUE (thread_id, workspace_id),
          UNIQUE (session_id, provider_thread_id)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS threads_session_id_idx ON threads(session_id);

        CREATE TABLE IF NOT EXISTS turns (
          turn_id TEXT PRIMARY KEY NOT NULL,
          thread_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          state TEXT NOT NULL
            CHECK (state IN ('running', 'waiting', 'completed', 'interrupted', 'failed')),
          failure_reason TEXT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (thread_id, workspace_id)
            REFERENCES threads(thread_id, workspace_id) ON DELETE CASCADE,
          UNIQUE (turn_id, thread_id, workspace_id)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS turns_thread_id_idx ON turns(thread_id);

        CREATE TABLE IF NOT EXISTS messages (
          message_id TEXT PRIMARY KEY NOT NULL,
          workspace_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          external_id TEXT,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
          is_final INTEGER NOT NULL DEFAULT 0 CHECK (is_final IN (0, 1)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (turn_id, thread_id, workspace_id)
            REFERENCES turns(turn_id, thread_id, workspace_id) ON DELETE CASCADE,
          UNIQUE (message_id, workspace_id),
          UNIQUE (thread_id, ordinal),
          UNIQUE (thread_id, external_id)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS messages_turn_id_idx ON messages(turn_id);

        CREATE TABLE IF NOT EXISTS message_parts (
          part_id TEXT PRIMARY KEY NOT NULL,
          message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          part_type TEXT NOT NULL,
          content_json TEXT NOT NULL CHECK (json_valid(content_json)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (message_id, ordinal)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS message_parts_message_id_idx ON message_parts(message_id);

        CREATE TABLE IF NOT EXISTS interactions (
          interaction_id TEXT PRIMARY KEY NOT NULL,
          turn_id TEXT NOT NULL REFERENCES turns(turn_id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('permission', 'question', 'plan')),
          state TEXT NOT NULL CHECK (state IN ('pending', 'resolved', 'expired', 'cancelled')),
          request_json TEXT NOT NULL CHECK (json_valid(request_json)),
          response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
          resolved_by_client_id TEXT REFERENCES authorized_clients(client_id) ON DELETE SET NULL,
          expires_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          resolved_at INTEGER
        ) STRICT;

        CREATE INDEX IF NOT EXISTS interactions_turn_id_idx ON interactions(turn_id);
        CREATE INDEX IF NOT EXISTS interactions_resolved_by_client_id_idx
          ON interactions(resolved_by_client_id);

        CREATE TABLE IF NOT EXISTS drafts (
          session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
          content_json TEXT NOT NULL CHECK (json_valid(content_json)),
          revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
          updated_by_client_id TEXT REFERENCES authorized_clients(client_id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS drafts_updated_by_client_id_idx
          ON drafts(updated_by_client_id);

        CREATE TABLE IF NOT EXISTS stash_items (
          stash_item_id TEXT PRIMARY KEY NOT NULL,
          workspace_id TEXT REFERENCES workspaces(workspace_id) ON DELETE SET NULL,
          source_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
          content_json TEXT NOT NULL CHECK (json_valid(content_json)),
          revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
          created_by_client_id TEXT REFERENCES authorized_clients(client_id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS stash_items_workspace_id_idx ON stash_items(workspace_id);
        CREATE INDEX IF NOT EXISTS stash_items_source_session_id_idx
          ON stash_items(source_session_id);
        CREATE INDEX IF NOT EXISTS stash_items_created_by_client_id_idx
          ON stash_items(created_by_client_id);

        CREATE TABLE IF NOT EXISTS attachments (
          attachment_id TEXT PRIMARY KEY NOT NULL,
          workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
          message_id TEXT,
          uploaded_by_client_id TEXT REFERENCES authorized_clients(client_id) ON DELETE SET NULL,
          storage_key TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
          metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
          created_at INTEGER NOT NULL,
          FOREIGN KEY (message_id, workspace_id)
            REFERENCES messages(message_id, workspace_id) ON DELETE CASCADE
        ) STRICT;

        CREATE INDEX IF NOT EXISTS attachments_workspace_id_idx ON attachments(workspace_id);
        CREATE INDEX IF NOT EXISTS attachments_message_id_idx ON attachments(message_id);
        CREATE INDEX IF NOT EXISTS attachments_uploaded_by_client_id_idx
          ON attachments(uploaded_by_client_id);

        CREATE TABLE IF NOT EXISTS event_streams (
          scope_key TEXT PRIMARY KEY NOT NULL,
          scope_type TEXT NOT NULL CHECK (scope_type IN ('environment', 'session', 'thread')),
          session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,
          thread_id TEXT,
          epoch TEXT NOT NULL,
          head_sequence INTEGER NOT NULL DEFAULT 0 CHECK (head_sequence >= 0),
          oldest_sequence INTEGER CHECK (oldest_sequence IS NULL OR oldest_sequence >= 1),
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (thread_id, session_id)
            REFERENCES threads(thread_id, session_id) ON DELETE CASCADE,
          CHECK (
            (scope_type = 'environment' AND session_id IS NULL AND thread_id IS NULL) OR
            (scope_type = 'session' AND session_id IS NOT NULL AND thread_id IS NULL) OR
            (scope_type = 'thread' AND session_id IS NOT NULL AND thread_id IS NOT NULL)
          )
        ) STRICT;

        CREATE INDEX IF NOT EXISTS event_streams_session_id_idx ON event_streams(session_id);
        CREATE INDEX IF NOT EXISTS event_streams_thread_id_idx ON event_streams(thread_id);

        CREATE TABLE IF NOT EXISTS event_log (
          scope_key TEXT NOT NULL REFERENCES event_streams(scope_key) ON DELETE CASCADE,
          sequence INTEGER NOT NULL CHECK (sequence >= 1),
          event_id TEXT NOT NULL UNIQUE,
          event_name TEXT NOT NULL,
          event_json TEXT NOT NULL CHECK (json_valid(event_json)),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (scope_key, sequence)
        ) WITHOUT ROWID, STRICT;
      `)
    },
  },
  {
    version: 3,
    name: 'bounded_indexes_and_retention',
    up(database) {
      database.exec(`
        -- Session list for the whole environment, most recent activity first.
        -- Both keyset columns descend so a row-value cursor is one index range.
        CREATE INDEX IF NOT EXISTS sessions_updated_at_idx
          ON sessions(updated_at DESC, session_id DESC);

        -- Session list for one workspace; the composite replaces the plain workspace index.
        DROP INDEX IF EXISTS sessions_workspace_id_idx;
        CREATE INDEX IF NOT EXISTS sessions_workspace_updated_at_idx
          ON sessions(workspace_id, updated_at DESC, session_id DESC);

        -- Threads of a session in creation order, for paginated session history.
        DROP INDEX IF EXISTS threads_session_id_idx;
        CREATE INDEX IF NOT EXISTS threads_session_created_at_idx
          ON threads(session_id, created_at, thread_id);

        -- Turns of a thread in start order; history pages join turn state per message.
        DROP INDEX IF EXISTS turns_thread_id_idx;
        CREATE INDEX IF NOT EXISTS turns_thread_started_at_idx
          ON turns(thread_id, started_at, turn_id);

        -- Age-based retention finds expired rows across every stream without a table scan.
        CREATE INDEX IF NOT EXISTS event_log_created_at_idx
          ON event_log(created_at, scope_key, sequence);

        -- Pruned event IDs keep their cursor and a payload hash so a late retry of a
        -- pruned event still deduplicates instead of being appended and projected again.
        CREATE TABLE IF NOT EXISTS event_id_tombstones (
          event_id TEXT PRIMARY KEY NOT NULL,
          scope_key TEXT NOT NULL REFERENCES event_streams(scope_key) ON DELETE CASCADE,
          sequence INTEGER NOT NULL CHECK (sequence >= 1),
          event_hash BLOB NOT NULL,
          pruned_at INTEGER NOT NULL
        ) WITHOUT ROWID, STRICT;

        CREATE INDEX IF NOT EXISTS event_id_tombstones_scope_key_idx
          ON event_id_tombstones(scope_key);
        CREATE INDEX IF NOT EXISTS event_id_tombstones_pruned_at_idx
          ON event_id_tombstones(pruned_at);
      `)
    },
  },
  {
    version: 4,
    name: 'client_credential_kind_and_expiry',
    up(database) {
      // ALTER TABLE has no IF NOT EXISTS, and a remigration of this version
      // (schema_version reset while the objects exist) must be tolerated.
      const columns = new Set(
        (database.prepare('PRAGMA table_info(authorized_clients)').all() as { name: string }[]).map(
          (column) => column.name,
        ),
      )
      if (!columns.has('kind')) {
        // Who may revoke the row and whether it may carry admin: owner, paired or cloud.
        database.exec(`
          ALTER TABLE authorized_clients
            ADD COLUMN kind TEXT NOT NULL DEFAULT 'paired'
              CHECK (kind IN ('owner', 'paired', 'cloud'))
        `)
      }
      if (!columns.has('expires_at')) {
        // Idle expiry, recomputed on every accepted connection. The default of 0
        // is "already expired": a row inserted without an explicit expiry never
        // authenticates. Rows that predate this column get the 30-day window
        // measured from their last activity.
        database.exec(`
          ALTER TABLE authorized_clients
            ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;
          UPDATE authorized_clients
          SET expires_at = COALESCE(last_seen_at, created_at) + 2592000000
          WHERE expires_at = 0;
        `)
      }
      // The live owner lookup at startup, newest first, and per-kind listing.
      database.exec(`
        CREATE INDEX IF NOT EXISTS authorized_clients_kind_idx
          ON authorized_clients(kind, revoked_at, created_at);
      `)
    },
  },
  {
    version: 5,
    name: 'audit_events',
    up(database) {
      database.exec(`
        -- Durable security audit (CAL-48). Pre-auth refusals have a null
        -- client_id; the identifier is kept after revoke so T16 can still
        -- name the device. Raw credentials and provider secrets are never
        -- stored here; application code redacts before insert.
        CREATE TABLE IF NOT EXISTS audit_events (
          event_id TEXT PRIMARY KEY NOT NULL,
          type TEXT NOT NULL,
          outcome TEXT NOT NULL
            CHECK (outcome IN (
              'rejected', 'denied', 'failed', 'issued', 'revoked', 'exchanged'
            )),
          at INTEGER NOT NULL,
          client_id TEXT,
          command TEXT,
          remote_address TEXT,
          details_json TEXT NOT NULL CHECK (json_valid(details_json))
        ) STRICT;

        -- Newest events across the environment, keyset-paginated by (at, event_id).
        CREATE INDEX IF NOT EXISTS audit_events_at_idx
          ON audit_events(at DESC, event_id DESC);

        -- Per-client trail, same keyset.
        CREATE INDEX IF NOT EXISTS audit_events_client_at_idx
          ON audit_events(client_id, at DESC, event_id DESC);

        -- One event type (path.rejected, token.revoked, …), same keyset.
        CREATE INDEX IF NOT EXISTS audit_events_type_at_idx
          ON audit_events(type, at DESC, event_id DESC);
      `)
    },
  },
  {
    version: 6,
    name: 'workspace_last_used',
    up(database) {
      const columns = new Set(
        (database.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[]).map(
          (column) => column.name,
        ),
      )
      if (!columns.has('last_used_at')) {
        // When a session last started in the workspace (CAL-50); null until one has.
        database.exec('ALTER TABLE workspaces ADD COLUMN last_used_at INTEGER')
      }
    },
  },
  {
    version: 7,
    name: 'turn_command_id',
    up(database) {
      const columns = new Set(
        (database.prepare('PRAGMA table_info(turns)').all() as { name: string }[]).map(
          (column) => column.name,
        ),
      )
      if (!columns.has('command_id')) {
        // The client-minted id of the send that started the turn. Null on turns
        // recorded before this column, which the unique index below tolerates
        // because SQLite treats NULLs as distinct.
        database.exec('ALTER TABLE turns ADD COLUMN command_id TEXT')
      }
      // Both the retry lookup and the guarantee that one command id can only
      // ever have started one turn in a thread.
      database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS turns_thread_command_id_idx
          ON turns(thread_id, command_id);
      `)
    },
  },
  {
    version: 8,
    name: 'session_composer_state',
    up(database) {
      const columns = new Set(
        (database.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(
          (column) => column.name,
        ),
      )
      if (!columns.has('composer_json')) {
        // The session's own model, mode and config selection (CAL-178),
        // projected from `session.composer.updated`. Null until the session
        // has one; such a session still reads the workspace preference.
        database.exec(
          'ALTER TABLE sessions ADD COLUMN composer_json TEXT CHECK (composer_json IS NULL OR json_valid(composer_json))',
        )
      }
    },
  },
  {
    version: 9,
    name: 'artifact_session_and_source',
    up(database) {
      const columns = new Set(
        (database.prepare('PRAGMA table_info(attachments)').all() as { name: string }[])
          .map((column) => column.name),
      )
      if (!columns.has('session_id')) {
        database.exec(`
          ALTER TABLE attachments ADD COLUMN session_id TEXT
            REFERENCES sessions(session_id) ON DELETE CASCADE;
          UPDATE attachments SET session_id = (
            SELECT session_id FROM sessions
            WHERE session_id = json_extract(attachments.metadata_json, '$.sessionId')
              AND workspace_id = attachments.workspace_id
          );
        `)
      }
      if (!columns.has('source')) {
        database.exec(`
          ALTER TABLE attachments ADD COLUMN source TEXT NOT NULL DEFAULT 'prompt'
            CHECK (source IN ('prompt', 'generated'));
          UPDATE attachments SET source = 'generated'
            WHERE json_extract(metadata_json, '$.source') = 'generated';
        `)
      }
      database.exec(`CREATE INDEX IF NOT EXISTS attachments_session_created_idx
        ON attachments(session_id, created_at, attachment_id)`)
    },
  },
  {
    version: 10,
    name: 'provider_prompt_capabilities',
    up(database) {
      const columns = new Set(
        (database.prepare('PRAGMA table_info(provider_profiles)').all() as { name: string }[])
          .map((column) => column.name),
      )
      if (!columns.has('prompt_capabilities_json')) {
        // What the provider's process said it accepts in a prompt at
        // `initialize` (CAL-196). Null until one has completed a handshake.
        // Per-model image support rides `available_models_json`, so no column.
        database.exec(
          'ALTER TABLE provider_profiles ADD COLUMN prompt_capabilities_json TEXT CHECK (prompt_capabilities_json IS NULL OR json_valid(prompt_capabilities_json))',
        )
      }
    },
  },
  {
    version: 11,
    name: 'turn_activity',
    up(database) {
      // A turn's reasoning blocks and tool calls, one row each, keyed by the
      // id the events carry (a reasoning block's message id, a tool call id).
      // Until now they lived only in the event log, so a history page or a
      // snapshot came back as text alone. `ordinal` is drawn from the same
      // thread-wide counter as `messages.ordinal`, so one sort across both
      // tables gives the order text, thoughts and tools happened in.
      database.exec(`
        CREATE TABLE IF NOT EXISTS turn_activity (
          activity_id TEXT PRIMARY KEY NOT NULL,
          workspace_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('reasoning', 'tool')),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          state_json TEXT NOT NULL CHECK (json_valid(state_json)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (turn_id, thread_id, workspace_id)
            REFERENCES turns(turn_id, thread_id, workspace_id) ON DELETE CASCADE,
          UNIQUE (thread_id, ordinal)
        ) STRICT;
      `)
      backfillTurnActivity(database)
    },
  },
]

type RetainedActivityRow = {
  thread_id: string
  sequence: number
  event_name: 'message.reasoning' | 'tool.updated'
  event_json: string
}
type BackfilledActivity = {
  activityId: string
  turnId: string
  kind: 'reasoning' | 'tool'
  createdAt: number
  state: Record<string, unknown>
}
type TextBlock = { type: 'text'; text: string }

/**
 * Rebuild `turn_activity` for turns that already happened from the reasoning
 * and tool events the log still retains. Retention keeps a window of events,
 * so a turn older than that window stays text-only; everything inside it gets
 * its thoughts and tool calls back.
 *
 * Those rows need ordinals among the turn's messages, which were numbered
 * densely before this table existed. Each affected thread's message ordinals
 * are scaled by 1000 (an order-preserving renumbering; history pages compare
 * ordinals, never count them) and the turn's activity is filed in the gap just
 * before its first assistant message, or just after its prompt when the turn
 * produced no text. Interleaving within a turn is not recoverable from rows,
 * so a backfilled turn reads as it did before: thoughts, then tools, then text.
 * A history cursor a client held across the upgrade points below the new
 * numbering and simply yields no older page; its next snapshot repairs it.
 */
function backfillTurnActivity(database: DatabaseSync): void {
  const retained = database
    .prepare(
      `SELECT streams.thread_id, log.sequence, log.event_name, log.event_json
       FROM event_log AS log
       JOIN event_streams AS streams ON streams.scope_key = log.scope_key
       WHERE streams.scope_type = 'thread'
         AND log.event_name IN ('message.reasoning', 'tool.updated')
       ORDER BY streams.thread_id, log.sequence`,
    )
    .all() as RetainedActivityRow[]
  if (retained.length === 0) return

  const selectTurn = database.prepare(
    'SELECT workspace_id FROM turns WHERE turn_id = ? AND thread_id = ?',
  )
  const turnMessages = database.prepare(
    `SELECT role, ordinal FROM messages WHERE turn_id = ? AND thread_id = ? ORDER BY ordinal`,
  )
  const scaleUp = database.prepare(
    'UPDATE messages SET ordinal = ordinal * 1000 + 1000000000000 WHERE thread_id = ?',
  )
  const scaleDown = database.prepare(
    'UPDATE messages SET ordinal = ordinal - 1000000000000 WHERE thread_id = ?',
  )
  const insert = database.prepare(
    `INSERT OR IGNORE INTO turn_activity (
       activity_id, workspace_id, thread_id, turn_id, kind, ordinal, state_json,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  // Fold the retained events per thread into one entry per activity id, in
  // the order each id first appeared, the same way the projector does live.
  const byThread = new Map<string, Map<string, BackfilledActivity>>()
  for (const row of retained) {
    const event = JSON.parse(row.event_json) as {
      timestamp: string
      payload: Record<string, unknown>
    }
    const payload = event.payload
    const turnId = String(payload.turnId ?? '')
    if (!turnId) continue
    const activityId = String(
      row.event_name === 'message.reasoning' ? payload.messageId : payload.toolCallId,
    )
    if (!activityId) continue
    let thread = byThread.get(row.thread_id)
    if (!thread) {
      thread = new Map()
      byThread.set(row.thread_id, thread)
    }
    const existing = thread.get(activityId)
    const createdAt = Date.parse(event.timestamp)
    if (row.event_name === 'message.reasoning') {
      const previous = (existing?.state ?? {}) as {
        content?: Array<Record<string, unknown>>
        tokens?: number
      }
      const blocks = previous.content ?? []
      const last = blocks.at(-1) as TextBlock | undefined
      const content = payload.content as Record<string, unknown> | undefined
      const merged =
        content === undefined
          ? blocks
          : last?.type === 'text' && content.type === 'text'
            ? [...blocks.slice(0, -1), { type: 'text', text: last.text + String(content.text) }]
            : [...blocks, content]
      const tokens = payload.tokens as number | undefined
      const total =
        tokens === undefined ? previous.tokens : Math.max(previous.tokens ?? 0, tokens)
      thread.set(activityId, {
        activityId,
        turnId,
        kind: 'reasoning',
        createdAt: existing?.createdAt ?? createdAt,
        state: {
          messageId: activityId,
          turnId,
          phase: payload.phase,
          content: merged,
          ...(total === undefined ? {} : { tokens: total }),
        },
      })
    } else {
      const { title, kind, status } = payload as Record<string, unknown>
      thread.set(activityId, {
        activityId,
        turnId,
        kind: 'tool',
        createdAt: existing?.createdAt ?? createdAt,
        state: {
          ...(existing?.state ?? {}),
          toolCallId: activityId,
          turnId,
          ...(title === undefined ? {} : { title }),
          ...(kind === undefined ? {} : { kind }),
          ...(status === undefined ? {} : { status }),
        },
      })
    }
  }

  for (const [threadId, entries] of byThread) {
    const byTurn = new Map<string, BackfilledActivity[]>()
    for (const entry of entries.values()) {
      const turn = selectTurn.get(entry.turnId, threadId) as { workspace_id: string } | undefined
      if (!turn) continue
      const list = byTurn.get(entry.turnId) ?? []
      list.push({ ...entry, state: { ...entry.state, workspaceId: turn.workspace_id } })
      byTurn.set(entry.turnId, list)
    }
    if (byTurn.size === 0) continue
    scaleUp.run(threadId)
    scaleDown.run(threadId)
    for (const [turnId, list] of byTurn) {
      const messages = turnMessages.all(turnId, threadId) as Array<{
        role: string
        ordinal: number
      }>
      if (messages.length === 0) continue
      const firstAssistant = messages.find((message) => message.role === 'assistant')
      // Up to 999 rows fit in the gap; a turn with more keeps its newest.
      const kept = list.slice(-999)
      const start = Math.max(
        0,
        firstAssistant
          ? firstAssistant.ordinal - kept.length
          : messages[messages.length - 1]!.ordinal + 1,
      )
      kept.forEach((entry, index) => {
        const { workspaceId, ...state } = entry.state as { workspaceId: string } & Record<
          string,
          unknown
        >
        insert.run(
          entry.activityId,
          workspaceId,
          threadId,
          turnId,
          entry.kind,
          start + index,
          JSON.stringify(state),
          entry.createdAt,
          entry.createdAt,
        )
      })
    }
  }
}
