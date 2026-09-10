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
]
