# @openmanager/app-core

The shared browser-safe React application layer for OpenManager web and desktop.
It starts with the renderer's views, styles, syntax highlighting and Storybook;
focused application providers and environment-client integration can grow here.

## Consuming the package

This private workspace package exports TypeScript source, like the existing
shared packages, so Vite consumers retain HMR and bundle only what they use.
Import components from `@openmanager/app-core/components/...`, and import
`@openmanager/app-core/styles/globals.css` once in the host's stylesheet.
The shared stylesheet explicitly registers its Tailwind sources; hosts must
also register their own source directory. Wrap themed components in `ThemeProvider`.

`pnpm --filter @openmanager/app-core build` independently typechecks and bundles
the public entry with Vite. `pnpm storybook` and `pnpm storybook:build` run here.
`pnpm ci:app-core` checks types, boundaries, component tests, the library build,
and Storybook. CI runs this alongside desktop validation.

## Migration boundary

Views never import desktop code, Convex, Electron, or agent runtime modules.
ESLint enforces this for source and stories. Browser builds provide an additional
check on the modules reached through shared helpers.

Desktop still owns the connected ChatView/MessageInput/WorkspaceSidebar wrappers,
live plan subscriptions, settings, window chrome, telemetry and updates.
Application state is split into four domain providers whose contracts live
here (`providers/platform-provider`, `providers/session-provider`,
`providers/composer-provider`, `providers/active-thread-provider`) while the
Convex/Electron-backed implementations stay in desktop; see
`docs/application-providers.md`. Permission/question/plan contexts follow the
same pattern. This keeps one context identity without moving any
Convex hooks across the boundary. `ViewActionsContext` supplies only child-session
navigation and workspace icons; it is a small extraction seam, not a replacement
environment client. The sidebar receives host settings as a React slot.

## Environment client

`providers/environment-client` binds `@openmanager/environment-client` to React:
`EnvironmentClientProvider` supplies a client, and hooks such as `useSessionList`,
`useActiveThread`, `usePendingInteractions` and `useEnvironmentCommands` are the
only way views read environment data or send commands. Hosts choose the
implementation: the WebSocket client for web and desktop, the mock for tests and
Storybook, and a temporary Convex/Electron adapter in desktop during migration.
`tests/environment-client.test.tsx` shows the mock driving the sidebar, chat and
composer without a server.

The desktop's temporary Convex/Electron adapter lives in
`apps/desktop/src/renderer/src/environment` and is mounted behind a backend flag;
`docs/compatibility-adapters.md` describes it and how to delete it. Keep
compatibility implementations outside this package so retiring Convex does not
require moving the shared application again. Protocol
definitions, server persistence, agent execution and native mobile UI retain their
own packages/apps.
