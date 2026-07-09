# Mobile MVP — Implementation Plan

> Expo (React Native) client for OpenManager. Convex-only client: subscribes to reactive
> queries for data, writes `pending_jobs` for actions. The desktop app remains the sole
> worker that talks to OpenCode.

---

## 0. Locked decisions (confirmed with owner, 2026-07-07)

| Decision | Choice |
|---|---|
| Stack | Expo (React Native), TypeScript, expo-router |
| Styling | NativeWind v4 (+ tailwindcss **3.4.x** — NOT v4; NativeWind requires 3.x) |
| Platform priority | Android first (owner is on Windows; iOS later via Expo Go / EAS) |
| Theme | Dark + light, both ported 1:1 from desktop `globals.css`; system-follow + manual override |
| Scope | Full controller **except session creation**: browse workspaces/sessions, live streaming, send message, approve/deny permissions, abort, delete session |
| Auth | None in MVP (personal deployment; `EXPO_PUBLIC_CONVEX_URL` env) |
| Home UX | Sessions-first: recent sessions across all workspaces, live ones surfaced, workspace filter chips |
| Push notifications | Deferred (design so it slots in later) |

## 1. Where things live

- **New app**: `apps/mobile` → package `@openmanager/mobile` (pnpm workspace `apps/*` already matches).
- **Shared logic**: pure TS moves into `packages/shared/src/lib/` and is imported by BOTH desktop and mobile.
- **`packages/mobile-viewer/`**: placeholder only (a README, no package.json). Its content is superseded; move the doc into `apps/mobile/README.md` (updated) and delete the directory in Phase 5.
- **Convex**: `packages/convex` — **no schema changes are needed or allowed** in this MVP. Mobile consumes existing functions only.

## 2. Ground rules for every implementing agent

1. **pnpm only.** Install with `pnpm --filter @openmanager/mobile add <pkg>` or `pnpm dlx expo install` from `apps/mobile`. Never npm/yarn. Never edit `pnpm-lock.yaml` by hand.
2. **Do not modify** `packages/convex/convex/*` (schema or functions), Electron main (`apps/desktop/src/main`), or desktop behavior — except the explicitly listed Phase 1 refactors.
3. **Respect the design system exactly.** All colors/typography come from the token tables in §4. No invented colors, no Tailwind default palette (`gray-800` etc.), no extra font weights.
4. **Prettier config** at repo root applies (`.prettierrc`: single quotes, no semicolons — match existing desktop code style).
5. After your phase: `pnpm --filter @openmanager/shared typecheck && pnpm --filter @openmanager/desktop typecheck && pnpm --filter @openmanager/mobile typecheck` must pass, plus your phase's acceptance criteria. If you touched desktop files, also `pnpm --filter @openmanager/desktop test`.
6. Reference implementations to mirror (read them before writing code):
   - Streaming reconstruction: `apps/desktop/src/renderer/src/components/chat/ChatView.tsx` (`useRemoteStreamingMessage`, lines ~231–319) + `lib/remote-stream-parts.ts`
   - Optimistic send + message merge: `apps/desktop/src/renderer/src/providers/active-session-provider.tsx`
   - Job submission payloads: `apps/desktop/src/renderer/src/providers/app-ui-provider.tsx` and `apps/desktop/src/main/job-worker.ts` (the parser — source of truth)
   - Part rendering: `apps/desktop/src/renderer/src/components/parts/*`
   - Session list presentation: `apps/desktop/src/renderer/src/components/sidebar/WorkspaceSidebarView.tsx`

## 3. Convex contract (read-only reference — verified against source)

### Queries (subscribe with `useQuery` from `convex/react`)

| Function | Args | Use |
|---|---|---|
| `api.workspaces.list` | `{}` | All workspaces (name, path, machineId) |
| `api.sessions.listForSidebar` | `{ workspacePaths: string[] }` | Sessions across workspaces, sorted by `updatedAt` desc. Returns `{ workspacePath, externalId, title?, status, clientId?, updatedAt }[]` |
| `api.sessions.getByExternalId` | `{ externalId }` | Session detail |
| `api.messages.listMetadata` | `{ sessionExternalId }` | `{ _id, externalId, role, sequenceNum, isFinal }[]` ordered by sequenceNum |
| `api.messages.getContent` | `{ externalId }` | `{ content, metadata: { parts?, runtime? }, isFinal, role }` — fetch only when `isFinal === true` or `role === 'user'` |
| `api.streamChunks.getLatestChunk` | `{ messageExternalId }` | Reactive head of the append-only chunk stream |
| `api.streamChunks.getChunksSince` | `{ messageExternalId, afterIndex }` | Gap fill / late join (imperative `convex.query(...)`, not a subscription) |
| `api.permissions.getPendingForSession` | `{ sessionExternalId }` | Latest pending permission or `null`. Shape: `{ requestId, permission?, toolName, description, input?, patterns?, alwaysPatterns? }` |
| `api.jobs.listPending` | `{ clientId }` | Pending job count for a desktop worker (reachability hint) |

### Mutations (actions from mobile)

| Action | Call | Payload notes |
|---|---|---|
| Send message | `api.jobs.submitMessage({ workspacePath, sessionExternalId, content, clientId })` | Server builds the job payload. `clientId` = mobile's persisted id; routing uses `session.clientId` when set |
| Abort | `api.jobs.submit({ workspacePath, type: 'abort', payload: JSON.stringify({ workspacePath, sessionExternalId }), clientId, sessionExternalId })` | Worker reads `parsed.sessionExternalId` |
| Resolve permission | `api.jobs.submit({ workspacePath, type: 'resolve_permission', payload: JSON.stringify({ workspacePath, sessionExternalId, permissionId, approved }), clientId, sessionExternalId })` | `permissionId` = `requestId` from `getPendingForSession`; `approved: boolean` |
| Delete session | `api.jobs.submit({ workspacePath, type: 'delete_session', payload: JSON.stringify({ workspacePath, sessionExternalId }), clientId, sessionExternalId })` | |

**Routing rule (from `jobs.submit`):** `targetClientId = session.clientId ?? args.clientId`. A session whose `clientId` is unset can never be reached from mobile (the job would target the mobile client itself) → UI must disable composer/abort for such sessions with a "not connected to a desktop" notice. Jobs stay `pending` while the desktop is offline → show a subtle "queued" state on optimistic messages.

### Streaming reconstruction algorithm (must match desktop exactly)

1. Subscribe `getLatestChunk(messageExternalId)` for any assistant message with `isFinal !== true`.
2. If `latest.chunkIndex === lastSeen + 1` (or `0` when nothing seen): append `chunkText` to content, apply `latest.partUpdate.part` via `applyPartUpdate` (ordinal-stable upsert from shared lib).
3. On gap or late join: imperatively `getChunksSince({ afterIndex: lastSeen ?? -1 })`, sort by `chunkIndex`, append all, apply each `partUpdate`.
4. Reset all local state when `messageExternalId` changes; drop streaming state once metadata flips `isFinal` (but cache last-known parts/content to avoid a flash while `getContent` resolves — see `ResolvedMessage` in ChatView.tsx).
5. `content` for text fallback = concatenated `chunkText`; rich rendering uses `parts` when present.

## 4. Design tokens (source of truth: `apps/desktop/src/renderer/src/styles/globals.css`)

### 4.1 Colors — copy these hex values EXACTLY

| Token | Dark (default) | Light |
|---|---|---|
| `canvasBg` | `#141414` | `#f8f8f8` |
| `surface` | `#1c1c1c` | `#fcfcfc` |
| `surfaceElevated` | `#212121` | `#f3f3f3` |
| `surfaceHover` | `#2a2a2a` | `#f3f3f3` |
| `tabActiveBg` | `#242424` | `#e7e7e7` |
| `border` | `#363636` | `#dedede` |
| `borderMuted` | `#2e2e2e` | `#e7e7e7` |
| `text` | `#d0d0d0` | `#2d2d2d` |
| `textStrong` | `#e0e0e0` | `#000000` |
| `textMuted` | `#8f8f8f` | `#5f5f5f` |
| `textFaint` | `#6b6b6b` | `#747474` |
| `actionBg` | `#e5e5e5` | `#2a2a2a` |
| `actionFg` | `#111111` | `#f3f3f3` |
| `actionHover` | `#f4f4f4` | `#1f1f1f` |
| `destructive` | `hsl(0 62% 50%)` → `#c92a2a`-ish; compute exact: `hsl(0,62%,50%)` = `#cf3030` | same |
| `destructiveFg` | `hsl(0 0% 95%)` = `#f2f2f2` | same |

Semantic aliases (match desktop `@theme` block): `background=canvasBg`, `card=surface`, `popover=surfaceElevated`, `primary=textStrong`, `mutedForeground=textMuted`, `accent=surfaceHover`, `input=surface`.

### 4.2 Typography

Fonts: **Geist** (sans) and **JetBrains Mono** (mono). Weights used: 400 (body — desktop uses variable 450; use static 400 on mobile), 500 (labels/nav), 600 (rare, section bars). Load via `expo-font`; prefer `@expo-google-fonts/geist` + `@expo-google-fonts/jetbrains-mono`; if the Geist package doesn't exist, vendor TTFs from vercel/geist releases into `apps/mobile/assets/fonts/`.

Type scale (RN needs absolute lineHeight in px — precomputed):

| Variant | size | weight | lineHeight | Use |
|---|---|---|---|---|
| `text-10-medium` | 10 | 500 | 16 | micro pills/chips |
| `text-11-regular/medium` | 11 | 400/500 | 17.6 | compact controls |
| `text-12-regular` | 12 | 400 | 15.6 (lh 1.3) | session titles, secondary rows |
| `text-12-medium` | 12 | 500 | 19.2 | |
| `text-13-regular/medium` | 13 | 400/500 | 20.8 | default UI density, composer |
| `text-14-regular/medium` | 14 | 400/500 | 22.4 | tool rows, secondary content |
| `text-16-medium` | 16 | 500 | 28 | section titles |
| `text-20-medium` | 20 | 500 | 38, letterSpacing -0.4 | display |
| `chat-assistant` / `chat-prose` | 14 | 400 | 24.5 (lh 1.75) | assistant markdown body |
| `chat-user` | 14 | 400 | 22.75 (lh 1.625) | user bubbles |
| mono/code | 13 | 400 | 20.8 | code, tool output |

Other constants: radius `6` (0.375rem), letterSpacing `0.14` (0.01em @14px) for UI text, markdown emphasis (`strong`) = weight 400 + `textStrong` color (color-based emphasis, NOT bold).

### 4.3 Component look (Basis style — monochrome, bordered, flat)

- Flat surfaces, 1px borders (`border`/`borderMuted`), radius 6, no shadows/elevation, no colored accents — hierarchy via the gray ramp only.
- Primary action buttons: `actionBg` background + `actionFg` text (inverted monochrome).
- Running/streaming indicator: pulsing/shimmering text or dot using `textStrong`↔`textMuted` (see `.shimmer-text` / `custom-loader` in globals.css; port with `react-native-reanimated` opacity loop).
- Session status mapping (from `WorkspaceSidebarView.tsx`): `running | busy | waiting` → active (animated dot); anything else → idle (static faint dot). `waiting` additionally implies a pending permission → highlight.

---

## Phase 0 — Expo scaffold in the pnpm workspace

**Goal:** `apps/mobile` exists, boots, bundles, and coexists with desktop.

1. From repo root: `pnpm dlx create-expo-app@latest apps/mobile --template default` (expo-router TS template, latest SDK). Then in `apps/mobile/package.json`: `"name": "@openmanager/mobile"`, `"private": true`, add `"typecheck": "tsc --noEmit"`.
2. Remove template example screens/assets; leave a minimal `app/_layout.tsx` + `app/index.tsx` ("OpenManager" placeholder).
3. Dependencies: `pnpm --filter @openmanager/mobile add convex@catalog: @openmanager/convex@workspace:* @openmanager/shared@workspace:*`, plus `pnpm dlx expo install @react-native-async-storage/async-storage` (run inside `apps/mobile`).
4. Monorepo Metro config (`apps/mobile/metro.config.js`): extend `expo/metro-config`; set `watchFolders = [repoRoot]`, `resolver.nodeModulesPaths = [apps/mobile/node_modules, repoRoot/node_modules]`, ensure `resolver.unstable_enablePackageExports = true` (needed for `@openmanager/convex/_generated/api` exports map).
5. **pnpm linker:** try the default isolated linker first. If Metro cannot resolve RN/expo packages, add `node-linker=hoisted` to root `.npmrc`, `pnpm install`, and then re-verify the DESKTOP app still works (`pnpm typecheck`, `pnpm --filter @openmanager/desktop test`). Report which path was taken.
6. Env: `apps/mobile/.env` with `EXPO_PUBLIC_CONVEX_URL=https://elegant-elephant-887.convex.cloud` (same as root `.env.local`); make sure `.env` is gitignored and add `.env.example`.
7. Root `package.json` scripts: `"mobile": "pnpm --filter @openmanager/mobile start"`, `"mobile:android": "pnpm --filter @openmanager/mobile exec expo run:android"`; extend root `typecheck` chain with the mobile filter.
8. Smoke-wire Convex: in `_layout.tsx`, create `ConvexReactClient(process.env.EXPO_PUBLIC_CONVEX_URL!, { unsavedChangesWarning: false })` + `ConvexProvider`; in `index.tsx` render the count from `useQuery(api.workspaces.list)` to prove end-to-end connectivity.

**Acceptance:** `pnpm --filter @openmanager/mobile exec expo export --platform android` succeeds (proves Metro resolves workspace deps); all three typechecks pass; desktop tests pass if `.npmrc` changed.

## Phase 1 — Shared extraction + theme/typography foundation

**Goal:** shared streaming/tool logic lives in `packages/shared`; mobile has the full token system, fonts, theming, and text primitives.

**1a. Shared extraction (touches desktop — be surgical):**
- Move `apps/desktop/src/renderer/src/lib/remote-stream-parts.ts` → `packages/shared/src/lib/remote-stream-parts.ts` (and its test `remote-stream-parts.test.ts` stays in desktop or moves alongside if shared has no test runner — keep the test running either way). Update desktop imports (`ChatView.tsx`, test) to `@openmanager/shared/lib/remote-stream-parts`.
- Split `ToolRegistry.ts`: pure metadata (canonical name mapping, `getTitle`/`getSubtitle` label logic) → `packages/shared/src/lib/tool-meta.ts`; the lucide-react icon mapping stays in desktop. Then make `toolPresenter.ts` import pure parts from shared. Move `toolPresenter.ts`'s pure model-building into `packages/shared/src/lib/tool-presenter.ts` if it has no DOM/React imports after the split. `MessageParts.test.tsx` must still pass unchanged.
- Do NOT change any behavior; this is a pure move/re-export refactor.

**1b. Mobile theme system:**
- `tailwind.config.js` (tailwindcss **3.4.x**) + NativeWind v4 (`nativewind`, babel preset, `withNativeWind` metro wrapper, `global.css`). Colors reference CSS variables; themes provided via NativeWind `vars()`.
- `src/theme/tokens.ts`: `basisDark` / `basisLight` objects with the §4.1 hex values, exported as `vars()` sets.
- `src/theme/ThemeProvider.tsx`: context with `mode: 'system' | 'dark' | 'light'`, resolves against `useColorScheme()`, persists override in AsyncStorage, applies `vars(activeTokens)` on the root `View`. Expose `useTheme()`.
- Fonts: load Geist 400/500/600 + JetBrains Mono 400/500 in `_layout.tsx` with splash-screen hold until loaded. Tailwind `fontFamily`: `sans` → Geist-Regular etc.
- `src/components/ui/AppText.tsx`: typed `variant` prop implementing the §4.2 scale exactly (size/weight/lineHeight/letterSpacing per variant). All later phases MUST use it instead of raw `<Text>`.
- Demo screen section (temporary, behind dev flag or on index): render the type ramp + color swatches in both themes for eyeball verification.

**Acceptance:** typechecks pass; desktop tests pass (refactor safety); `expo export` passes; screenshot-able token demo exists.

## Phase 2 — Data layer (hooks + actions, no UI)

**Goal:** all Convex data access behind typed hooks in `apps/mobile/src/data/`, mirroring desktop semantics.

- `src/data/client-id.ts`: `getMobileClientId()` → `mobile-<uuid>` persisted in AsyncStorage.
- `src/data/useSessionsOverview.ts`: `workspaces.list` → `sessions.listForSidebar(paths)`; expose `{ sessions, workspaces, isLoading }`; derive `isActive = status in {running, busy, waiting}`.
- `src/data/useSession.ts`: `sessions.getByExternalId` + `isReachable = !!session.clientId`.
- `src/data/useSessionMessages.ts`: port the message-merge from `active-session-provider.tsx` — `listMetadata` subscription + optimistic user messages (sequenceNum = max+n, cleared as persisted user count grows, reset on session change).
- `src/data/useMessageContent.ts`: `getContent` gated on `isFinal || role === 'user'`, skip for optimistic ids.
- `src/data/useRemoteStreamingMessage.ts`: faithful port of the ChatView hook (§3 algorithm) using `useQuery` + `useConvex().query` for gap fill, importing `applyPartUpdate`/`createPartOrdinalState` from `@openmanager/shared/lib/remote-stream-parts`. Include the last-known-parts/content caching for the finalize transition.
- `src/data/actions.ts`: `sendMessage`, `abortSession`, `resolvePermission`, `deleteSession` per §3 payload table (exact JSON keys).
- `src/data/usePendingPermission.ts`: `permissions.getPendingForSession` subscription.
- Unit tests (Jest via `jest-expo`, or plain vitest on pure functions if simpler) for: optimistic merge logic and chunk-append/gap-fill reducer (extract pure reducers so they're testable without Convex).

**Acceptance:** typecheck passes; unit tests pass; a temporary debug screen (or the index placeholder) can list sessions and live-log streaming content for a running session (verified against a real running desktop session if available, otherwise against stored data).

## Phase 3 — Sessions home screen

**Goal:** the sessions-first home per locked UX.

- `app/index.tsx`: full-screen list (FlatList) of sessions from `useSessionsOverview`, newest `updatedAt` first, active sessions get an animated status indicator and sort to the top within recency.
- Header: "OpenManager" wordmark (text-16-medium), settings gear → theme sheet.
- Workspace filter chips row (horizontal scroll, `text-11-medium`, chip = surfaceElevated bg / border, active chip = tabActiveBg + textStrong). "All" default.
- `SessionCard`: surface bg, borderMuted 1px, radius 6, padding 12–14; title (`text-13-medium`, textStrong, 1-line ellipsis; fallback "Untitled session"), workspace name (`text-11-regular`, textMuted), relative time (`text-11-regular`, textFaint), status dot left of title (active = pulsing textStrong dot via reanimated; `waiting` = dot + "needs approval" pill in destructive-muted styling; idle = static faint dot).
- Long-press on card → action sheet with "Delete session" (confirm dialog → `deleteSession`).
- Empty state (`text-13-regular` textMuted, centered): "No sessions yet — start one from the desktop app."
- Settings sheet (modal route `app/settings.tsx`): theme selector (System/Dark/Light), read-only Convex deployment URL, app version.
- Navigation: tap card → `/session/[externalId]` passing `workspacePath` as param.

**Acceptance:** typecheck + `expo export`; screens verified in both themes; visual style checked against §4 (no non-token colors — grep the diff for hex literals outside tokens.ts).

## Phase 4 — Chat screen (the core)

**Goal:** full-screen session view: timeline, live streaming, part renderers, composer, permission banner, abort.

- `app/session/[externalId].tsx`: header = back chevron, session title (`text-13-medium`, 1-line), status indicator; overflow menu (delete session). Below: message timeline + composer, `KeyboardAvoidingView`.
- Timeline: FlatList over `useSessionMessages`; auto-stick to bottom when user is within ~96px of the end (port desktop's `shouldAutoScroll` behavior); never yank scroll while the user has scrolled up.
- `UserMessage`: right-aligned block, surfaceElevated bg, radius 6, `chat-user` type; optimistic ones get a subtle "queued" opacity + clock glyph until acked.
- `AssistantMessage`: full-width, `chat-assistant` type; renders `parts` when available else plain content. Part renderers mirror desktop `components/parts/*`:
  - `TextPart`: markdown via `react-native-markdown-display`, styles mapped to tokens (§4.2 chat-prose; inline code = JetBrains Mono + `primary` color, transparent bg; code blocks = surface bg + borderMuted + mono 13; `strong` = weight 400 + textStrong — color emphasis, not bold; blockquote = 3px left border `primary`, italic, textMuted). No syntax highlighting in MVP.
  - `ThinkingPart`: collapsed-by-default row "Thought for a moment" style, `text-12-regular` textMuted, expandable to italic muted text.
  - `ToolCallPart` / tool rows: single-line rows — icon (lucide-react-native equivalents of desktop's registry icons), verb + detail from shared `tool-presenter`, running = shimmer/pulse, error = destructive tint; tap to expand output (mono 12/13, scrollable, max-height).
  - Streaming assistant tail: `useRemoteStreamingMessage`, animated "working" shimmer row while parts are empty.
- Composer: bottom-pinned, input field (surface bg, border, radius 6, `text-13-regular`, placeholder textFaint), send button = monochrome action style (actionBg/actionFg). While session active: show Stop button (destructive-outline) wired to `abortSession`. If `!isReachable`: composer disabled + inline notice "This session isn't connected to a desktop client."
- `PermissionBanner`: when `usePendingPermission` returns a row — pinned above composer: toolName (`text-13-medium` textStrong), description (`text-12-regular` textMuted, expandable input details in mono), Deny (bordered, transparent) / Approve (actionBg) → `resolvePermission`; optimistic hide after submit.

**Acceptance:** typecheck + `expo export` + unit tests still green; end-to-end verified against a live desktop session (send from phone → desktop executes → streaming renders on phone; permission approve round-trip; abort works). If no live desktop is available during implementation, verify rendering against existing Convex history and leave the live check to the orchestrator.

## Phase 5 — Consolidation, docs, cleanup

- Delete `packages/mobile-viewer/`; write `apps/mobile/README.md` (setup, env, `pnpm mobile`, Expo Go instructions for Android, architecture recap + Convex contract pointer).
- Root `README.md`: add mobile app to Architecture/UI-layout sections and scripts table.
- Root `typecheck`/`format` scripts include mobile; `pnpm ci` green.
- Sweep: no leftover debug screens, no hardcoded deployment URL outside env files, no non-token colors (`grep -rn '#[0-9a-fA-F]\{6\}' apps/mobile/src` should only hit `tokens.ts`), all text through `AppText`/markdown styles.
- Future-proofing notes file section (in mobile README): where push notifications and auth would plug in.

## Review protocol (orchestrator)

After Phase 5: full-diff review focused on (1) streaming-reconstruction fidelity vs desktop, (2) job payload key exactness, (3) token/typography parity, (4) RN pitfalls (list perf, keyboard, safe areas). Vital fixes applied via follow-up subagents; cosmetic nits logged, not churned.
