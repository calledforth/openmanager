# Web composer parity audit

Status: Accepted, 2026-09-19. Recorded from [CAL-181](https://linear.app/calledforth/issue/CAL-181/audit-the-web-composer-against-desktop-and-close-remaining-gaps).

Desktop and web render the same composer (`MessageInput` → `MessageInputView` in `packages/app-core`). Gaps live in the host adapters: desktop's `composer-state-provider` is full ACP + Convex; web's `EnvironmentComposerStateProvider` publishes empty catalogs, empty `agentEvents`, and no-op setters until the picker tickets land.

## Checklist

| Feature | Verdict | Notes |
| --- | --- | --- |
| Provider / model / mode / config pickers | Covered | Empty catalogs, so the pickers do not render. Wiring is [CAL-179](https://linear.app/calledforth/issue/CAL-179/wire-the-web-composer-pickers-provider-model-mode-and-config-options); workspace memory is [CAL-180](https://linear.app/calledforth/issue/CAL-180/remember-composer-preferences-per-workspace); health/discovery is [CAL-184](https://linear.app/calledforth/issue/CAL-184/surface-provider-discovery-and-health-on-web). Live events already exist ([CAL-178](https://linear.app/calledforth/issue/CAL-178/keep-catalog-and-session-composer-state-live-across-clients)). |
| Slash commands | Filed | Shared `/` popup works; environment never feeds `available_commands_update`. [CAL-190](https://linear.app/calledforth/issue/CAL-190/feed-slash-commands-to-the-web-composer). Placeholder advertises `/ for workflows` only when commands exist. |
| Usage display | Filed | `ContextMeter` renders only when `chrome.usage` is set. Environment has no usage event. [CAL-191](https://linear.app/calledforth/issue/CAL-191/feed-usage-context-meter-to-the-web-composer). |
| Todos / plan strip | Working on web | `ComposerTodos` reads `plan` parts from `streamingStore`. Plan review / Build uses `respondToInteraction` (Wave 4 · Approvals, questions & plans; [CAL-76](https://linear.app/calledforth/issue/CAL-76/implement-resolve-commands-for-approvals-questions-and-plans), [CAL-79](https://linear.app/calledforth/issue/CAL-79/preserve-plan-build-and-follow-up-turn-semantics-per-provider)). |
| Queued follow-ups | Working on web | Same as desktop: Send is hidden while a turn runs; there is no follow-up queue UI on either host. Failed sends retry through the environment outbox. Server-side `AgentRuntime` can queue prompts, but neither client exposes that. |
| Interrupt | Working on web | Stop calls `turn.interrupt`. Esc now matches the Stop tooltip (this change). |
| Keyboard shortcuts | Working on web | Enter send, Shift+Enter newline, `/` menu nav, Cmd/Ctrl+L focus composer, Esc stop. Cmd/Ctrl+B sidebar collapse is desktop-only and not a composer control. |
| Per-provider quirks | Covered | Shared guards (hide `auto` without classifier support, effort pill, Build/Plan toggle) are inert until catalogs land via CAL-179 / CAL-184. |
| Text drafts | Covered | localStorage drafts already work. Server drafts / stash are Wave 4 · Composer drafts & stash ([CAL-81](https://linear.app/calledforth/issue/CAL-81/separate-per-session-draft-records-from-environment-stash-items)–[CAL-85](https://linear.app/calledforth/issue/CAL-85/expose-offline-and-unsynchronized-draftstash-state)). |
| Attachments | Covered | Attach button is disabled with an explanation. Uploads are Wave 4 · Attachments & artifacts ([CAL-91](https://linear.app/calledforth/issue/CAL-91/replace-the-convex-storage-path-in-the-composer-attach-flow)). |
| Interactions | Covered | Permissions, questions and plan review already resolve through the environment ([CAL-75](https://linear.app/calledforth/issue/CAL-75/model-pending-interaction-payload-time-state-and-resolver)–[CAL-79](https://linear.app/calledforth/issue/CAL-79/preserve-plan-build-and-follow-up-turn-semantics-per-provider)). |

## Silent no-ops closed here

- Esc was advertised on Stop and did nothing on either host. It now interrupts a running turn (or cancels plan review).
- `/ for workflows` is no longer promised in the placeholder when the command list is empty.

Pickers, the config menu, and the usage meter already hide themselves when they have nothing to show. The attach button stays visible but disabled, with a host-specific reason — not silent.

## Not a web-only gap

`@ to mention` appears in the placeholder on both hosts and has no mention picker on either. `StepMeta` (per-message tokens) is unused on both. A follow-up queue during a live turn does not exist on either.
