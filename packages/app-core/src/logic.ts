/**
 * The DOM-free half of app-core: provider contracts, environment-backed
 * providers, stores and pure helpers, without the web UI or its styles.
 * React Native (Metro) loads this entry; the web and desktop keep `.` and the
 * per-module subpaths.
 *
 * Everything reachable from here must stay free of CSS, `react-dom`, Radix,
 * base-ui, motion, Shiki, pdf.js, Phosphor and browser globals. ESLint enforces
 * it over this file's whole import graph (`scripts/logic-graph.mjs`), and
 * `tests/logic-entry.test.ts` imports it under Node.
 */

// Providers: contracts and the environment-backed implementations.
export * from './providers/active-thread-provider'
export * from './providers/composer-provider'
export * from './providers/draft-pages'
export * from './providers/draft-provider'
export * from './providers/environment-application'
export * from './providers/environment-client'
export * from './providers/environment-composer'
export * from './providers/environment-drafts'
export * from './providers/permission-provider'
export * from './providers/plan-provider'
export * from './providers/platform-provider'
export * from './providers/question-provider'
export * from './providers/session-provider'
export * from './providers/sidebar-provider'
export * from './providers/view-actions'

// Stores and view-model helpers.
export * from './lib/artifact-preview'
export * from './lib/attachments'
export * from './lib/environment-thread'
export * from './lib/provider-health-view'
export * from './lib/relative-time'
export * from './lib/stream-continuity'
export * from './lib/streaming-messages-store'
export * from './lib/theme-families'
export * from './lib/workspace-availability'

// Pure logic that lives beside the components it serves.
export * from './components/chat/composerDrafts'
export * from './components/chat/composerDraftStore'
export * from './components/chat/favoriteModels'
export * from './components/chat/modelConfig'
export * from './components/chat/modelLabel'
export * from './components/chat/providerModelGroups'
export * from './components/chat/slashCommands'
export * from './components/chat/timelinePositions'
export * from './components/parts/turn-work-group'
export * from './components/questions/askedQuestion'
export * from './components/questions/questionFlow'
export * from './components/questions/useQuestionFlow'
export * from './components/sidebar/sidebar-sessions'
export * from './components/workspace/folder-browser'
