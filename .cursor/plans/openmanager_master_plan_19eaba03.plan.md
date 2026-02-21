---
name: OpenManager Master Plan
overview: Phase-by-phase implementation plan for OpenManager. This entry locks the approved Phase 1 foundation (Convex-first + Electron custom builder bootstrap + strict engineering guardrails).
todos:
  - id: phase1-boundaries
    content: Define Phase 1 module boundaries and repository abstractions for Electron and Convex
    status: pending
  - id: phase1-bootstrap
    content: Bootstrap custom Electron + Vite + electron-builder project skeleton
    status: pending
  - id: phase1-convex
    content: Create initial Convex schema and dev integration
    status: pending
  - id: phase1-guardrails
    content: Set strict TS/lint/test/CI guardrails and security defaults
    status: pending
  - id: phase2-draft
    content: Propose Phase 2 for user review and approval
    status: completed
  - id: phase2-sidecar-runtime
    content: Implement sidecar runtime contracts (spawn, healthcheck, restart, shutdown) and typed handshake payload
    status: pending
  - id: phase2-opencode-client
    content: Implement renderer OpenCode REST/SSE client with reconnection and event normalization
    status: pending
  - id: phase2-session-ux
    content: Implement multi-session management UI and actions (create/list/switch/delete/send/abort)
    status: pending
  - id: phase2-permissions-errors
    content: Implement permission approval flow and resilient error/retry states
    status: pending
  - id: phase3-draft
    content: Propose Phase 3 for user review and approval
    status: completed
  - id: phase3-queue-worker
    content: Implement Convex pending_jobs worker in Electron main with safe retries and state transitions
    status: pending
  - id: phase3-event-mirroring
    content: Harden SSE-to-Convex mirroring with idempotency keys and ordering guarantees
    status: pending
  - id: phase3-mobile-viewer
    content: Deliver viewer-only mobile surface (live updates plus history) backed by Convex subscriptions
    status: pending
  - id: phase3-observability
    content: Add queue and sync observability metrics/logging for retries, duplicates, and lag
    status: pending
  - id: phase4-draft
    content: Propose Phase 4 for user review and approval
    status: completed
  - id: phase4-mobile-send
    content: Enable controlled mobile send-message to existing sessions with queue-backed execution
    status: pending
  - id: phase4-editor-integration
    content: Harden Open in editor flows (VS Code/Cursor detection, fallback behavior, telemetry)
    status: pending
  - id: phase4-diff-revert
    content: Implement diff UX and hybrid revert policy (OpenCode native first, Git checkpoint fallback)
    status: pending
  - id: phase4-policy-rails
    content: Add policy gates preventing unsafe or unsupported revert actions
    status: pending
  - id: phase5-draft
    content: Propose Phase 5 for user review and approval
    status: completed
  - id: phase5-performance
    content: Define and enforce performance budgets for startup, stream latency, and UI responsiveness
    status: pending
  - id: phase5-reliability
    content: Define reliability SLOs and add recovery runbooks for sidecar, queue, and sync failures
    status: pending
  - id: phase5-packaging
    content: Implement Windows-first packaging/signing/update pipeline and release checklist
    status: pending
  - id: phase5-security
    content: Run security verification checklist and harden secret/config handling for release
    status: pending
  - id: phase6-draft
    content: Propose Phase 6 for user review and approval
    status: completed
  - id: phase6-gate
    content: Define hard entry gate for Phase 6 requiring OpenCode track to be 100 percent complete
    status: pending
  - id: phase6-adapter-arch
    content: Design provider adapter architecture supporting both OpenCode and Codex engines
    status: pending
  - id: phase6-codex-runtime
    content: Integrate Codex app-server JSON-RPC runtime with sidecar lifecycle and unified event model
    status: pending
  - id: phase6-parity-ux
    content: Implement full Codex parity in desktop and mobile surfaces including send-message where supported
    status: pending
  - id: phase6-policy-mapping
    content: Map Codex sandbox and approval semantics into unified app policy/permission UX
    status: pending
isProject: false
---

# OpenManager Implementation Plan (Iterative)

## Current Status

- Approved phases: **Phase 1, Phase 2, Phase 3, Phase 4, Phase 5, Phase 6**
- Bootstrap choice: **Custom Electron + Vite + electron-builder**
- Phase 2 session scope: **Multi-session from the start**
- Phase 3 mobile scope: **Viewer-only (live updates + history)**
- Phase 4 revert strategy: **OpenCode-native-first, Git-checkpoint fallback**
- Phase 5 release target: **Windows-first**
- Phase 6 gate: **Starts only after OpenCode implementation is 100 percent complete**
- Planning mode: iterative, phase-by-phase approvals before expanding

## Global Agent Execution Directives (Applies Before Every Phase)

### 1) Mandatory pre-phase protocol

Before starting implementation of any phase, the implementing agent must:

1. Read and understand:
  - `docs/ARCHITECTURE.md`
  - `docs/FEATURES.md`
  - This master plan file (current phase scope + DoD)
2. Produce a concise implementation brief covering:
  - exact scope it will implement in that phase
  - assumptions and dependencies
  - risks and mitigation approach
3. Ask clarifying questions if any requirement, schema, integration boundary, or acceptance criteria is ambiguous.
4. Wait for confirmation before coding if critical ambiguity remains.

### 2) Schema-first enforcement (strict)

- For phases that touch Convex/data contracts, the agent must propose the **exact schema** and data flow before implementation.
- Schema proposal must include:
  - tables/collections, key fields, indexes
  - event IDs and idempotency strategy
  - lifecycle states and transitions
  - migration/compatibility notes (if evolving schema)
- Implementation begins only after schema direction is explicitly acknowledged.

### 3) Electron packaging/signing guidance

- Phase 5 includes production packaging/signing/release operations.
- When implementing signing/build pipeline details, the agent should reuse patterns from the user's reference Electron project (to be provided) for GitHub Actions and signing configuration rather than inventing a divergent setup.
- Treat the reference project as the source of truth for signing/release mechanics unless explicitly overridden.

### 4) Frontend scope guidance

- Early phases can use a basic frontend implementation focused on correctness and architecture.
- Major UI refinement is intentionally deferred and will be handled as a dedicated refinement track using frontend-focused skill/workflow later.
- Agents should avoid over-investing in visual polish before core runtime, sync, and reliability milestones are complete.

### 5) Output quality requirement per phase

Before marking a phase complete, the agent must provide:

- a checklist mapping implemented items to this plan's phase scope
- validation evidence against that phase's Definition of Done
- explicit list of deferred items and why they were deferred

## Phase 1 — Foundation Contracts & Project Bootstrap (Approved)

### Objectives

- Establish a Convex-first data foundation so sync is not bolted on later.
- Bootstrap an Electron desktop app with explicit process boundaries.
- Set strict engineering guardrails so later sub-agent implementation remains consistent.

### Scope

- **Repository structure**
  - Define clear module boundaries for desktop shell, renderer app, shared contracts, and Convex functions.
  - Keep future mobile/PWA reuse possible by isolating shared domain types.
- **Electron application foundation**
  - Set up main/preload/renderer separation.
  - Keep IPC minimal and typed (bootstrap-only), with renderer performing direct local OpenCode HTTP/SSE calls after handshake.
  - Add sidecar lifecycle scaffolding interfaces (spawn/health/shutdown contracts), even if full session behavior is in Phase 2.
- **Convex foundation (from day one)**
  - Initialize project and environments.
  - Define initial schema for `workspaces`, `sessions`, `messages`, `pending_jobs` with minimal required fields.
  - Add storage boundary/repository abstraction so UI never writes storage directly.
- **Quality and operational guardrails**
  - Enable TypeScript strict mode.
  - Add linting/formatting/test command conventions.
  - Define baseline CI checks for typecheck + lint + unit tests.
- **Security baseline**
  - Enforce localhost-only OpenCode assumptions.
  - Define secret handling conventions for OpenCode server password and Convex env values.
  - Document explicit non-goals (no inbound port exposure, no PTY parsing).

### Deliverables

- A bootstrapped desktop project skeleton with working app startup pipeline.
- Convex schema and generated client wiring integrated into the app foundation.
- Typed boundary contracts for:
  - sidecar management
  - storage/repository operations
  - event envelope shapes for future SSE mirroring
- A `Definition of Done` checklist to gate transition to Phase 2.

### Definition of Done (Phase 1)

- Desktop app launches and renders baseline shell screen.
- Convex connectivity is operational in development environment.
- Create/read operations for `workspaces` are wired through repository boundary.
- Main/preload/renderer contracts are typed and documented.
- CI baseline validates typecheck + lint + test commands.
- Security defaults documented and enforced in dev configuration.

## Phase 2 — OpenCode Runtime Activation & Multi-Session Desktop Flow (Approved)

### Objectives

- Activate the OpenCode sidecar and establish reliable desktop runtime behavior.
- Deliver end-to-end desktop session lifecycle with live streaming updates.
- Start with multi-session UX immediately (approved decision), not single-session-first.

### Scope

- **Main process runtime activation**
  - Implement spawn logic for `opencode serve` with env handling and lifecycle hooks.
  - Add health probing, readiness timeout, crash detection, and controlled restart policy.
  - Emit one typed bootstrap handshake to renderer containing server URL + auth password.
- **Renderer direct OpenCode integration**
  - Build typed API client for key endpoints (`/global/health`, `/session`, `/session/:id/message`, `/session/:id/abort`, permission endpoint).
  - Open and maintain `/global/event` SSE subscription with reconnect strategy (backoff + jitter + resume semantics where possible).
  - Normalize SSE event envelopes into internal domain events.
- **Session lifecycle + multi-session UX**
  - Implement session list, create, switch, delete/archive, send message, and abort.
  - Support multiple concurrent sessions across workspaces in UI state model from the start.
  - Ensure session-scoped streaming rendering so events route to the correct conversation panel.
- **Permission and failure paths**
  - Surface OpenCode permission requests as explicit UI actions (approve/deny).
  - Handle sidecar-down, network interruption, malformed event payload, and API non-2xx responses.
  - Add user-safe fallbacks: retry actions, reconnect indicator, and non-destructive failure messaging.
- **Convex alignment during Phase 2**
  - Continue write-through persistence through the existing repository boundary.
  - Mirror core session/message records required for future multi-device activation without blocking local UX.

### Deliverables

- Running desktop flow: app starts sidecar, renderer connects, user can manage multiple sessions, and streaming works end-to-end.
- Typed OpenCode client modules and event normalization layer ready for later Convex mirroring hardening.
- Permission approval flow operational in UI.
- Error/reconnect behavior documented with explicit state transitions.

### Definition of Done (Phase 2)

- Sidecar boots reliably and recovers from one crash scenario via configured restart behavior.
- Renderer establishes SSE stream and renders token/event updates in correct session threads.
- User can create/switch between multiple active sessions and send prompts to each.
- Permission prompts can be approved/denied and effects are reflected in session state.
- Core failure paths show deterministic UI states (reconnecting, failed, retriable).
- Data writes continue through repository boundary and include Convex-backed records for workspaces/sessions/messages.

## Phase 3 — Convex Queue Activation & Cross-Device Consistency (Approved)

### Objectives

- Activate real cross-device flow by introducing a robust Convex-backed job queue worker.
- Guarantee consistency under retries/reconnects with idempotent event mirroring.
- Ship a viewer-only mobile surface first to reduce risk and keep UX stable.

### Scope

- **Electron main as local agent worker**
  - Subscribe to Convex `pending_jobs` and claim work safely.
  - Forward claimed jobs to local OpenCode endpoints and manage lifecycle transitions.
  - Persist job state transitions (`pending` -> `running` -> `done|failed`) with retry metadata.
- **Event mirroring hardening**
  - Mirror key SSE events into Convex with deterministic event IDs.
  - Enforce dedupe and ordering rules to prevent duplicate message chunks after reconnect.
  - Introduce bounded buffering/flush strategy for chunked output writes.
- **Cross-device consistency controls**
  - Define conflict policy for stale/late updates (last-write policy by monotonic event sequence).
  - Add reconnection reconciliation pass for missed events.
  - Ensure desktop direct stream and Convex stream can coexist without double-rendering in clients.
- **Mobile surface (viewer-only)**
  - Provide read path for live session updates and historical conversation timeline.
  - Exclude message-send and new-session creation in this phase (explicitly deferred).
  - Show clear capability boundaries in UI copy.
- **Operational readiness**
  - Track queue lag, retry counts, duplicate drops, and stream catch-up duration.
  - Add failure alarms/logging hooks for worker offline or backlog growth.

### Deliverables

- Convex job queue worker running in Electron main with stable claim/execute/complete behavior.
- Reliable mirrored session timeline in Convex consumable by non-desktop clients.
- Viewer-only mobile experience with live updates and history playback.
- Consistency and observability docs for retry, ordering, and reconciliation behavior.

### Definition of Done (Phase 3)

- Jobs submitted remotely remain `pending` and are processed when desktop worker is online.
- Duplicate SSE events do not create duplicate timeline entries after reconnect/retry.
- Viewer-only mobile client can observe active sessions and complete history in near real time.
- Queue and sync health metrics are available for troubleshooting lag/failure conditions.
- Capability boundaries are enforced: mobile cannot send messages or start sessions in this phase.

## Phase 4 — Controlled Interactivity, Diff UX, and Revert Policy (Approved)

### Objectives

- Move from viewer-only to controlled remote interaction without weakening safety guarantees.
- Deliver practical development ergonomics (editor-open flows + usable diff surfaces).
- Establish a durable revert strategy: OpenCode-native primitives first, Git checkpoint fallback.

### Scope

- **Mobile interactivity upgrade**
  - Allow mobile users to send messages only to existing active sessions.
  - Route all remote sends through Convex queue + desktop worker execution path.
  - Keep new-session creation on mobile out of scope until workspace capability model is hardened.
- **Editor integration hardening**
  - Implement robust "Open in editor" command routing for VS Code/Cursor with graceful fallback.
  - Validate workspace path handling and failure messages when editor binaries are unavailable.
  - Add lightweight instrumentation for launch success/failure rates.
- **Diff workflow UX**
  - Provide session-scoped diff timeline and selectable change groups.
  - Define source strategy for diffs (OpenCode endpoint where available; fallback derivation path documented).
  - Ensure cross-device read consistency for diff metadata persisted in Convex.
- **Hybrid revert strategy (approved)**
  - Prefer OpenCode native session primitives when they can express the requested rollback safely.
  - If native primitives are unavailable/incomplete, use Git checkpoint-based rollback.
  - Add policy layer deciding allowed revert operations by environment state (clean/dirty repo, checkpoint availability).
- **Safety rails**
  - Require explicit confirmations for destructive rollback actions.
  - Block unsupported revert paths and provide deterministic alternatives.
  - Keep audit trail of revert attempts and outcomes in session metadata.

### Deliverables

- Mobile can send messages to existing sessions through queue-backed execution.
- Reliable Open in editor actions across configured editors with clear error handling.
- Diff view UI tied to session history and mirrored metadata.
- Revert engine policy doc and initial implementation using hybrid decision rules.

### Definition of Done (Phase 4)

- Mobile send-message works for active sessions and is reflected in desktop + mobile timelines.
- Editor integration succeeds for configured editors and fails gracefully with actionable UI states.
- Diff UI can display session changes with stable ordering and cross-device parity.
- Revert requests execute through OpenCode-native path when possible; Git fallback executes only under valid checkpoint preconditions.
- Unsafe rollback attempts are blocked by policy gates and logged.

## Phase 5 — Production Hardening, Release Operations, and SLOs (Approved)

### Objectives

- Move from functional prototype to stable Windows-first product release.
- Establish measurable performance and reliability targets before shipping.
- Add operational workflows so failures are diagnosable and recoverable.

### Scope

- **Performance hardening**
  - Define budgets for cold start, sidecar readiness, first-token latency, and steady-state UI responsiveness.
  - Profile renderer event throughput under multi-session streaming load.
  - Add backpressure strategy for high-volume event bursts (batching/coalescing without UX degradation).
- **Reliability engineering**
  - Define SLOs for sidecar uptime, queue processing success, and stream continuity.
  - Add chaos-style test cases for sidecar crash, network flap, Convex reconnect storms, and duplicate job delivery.
  - Document deterministic recovery paths with user-visible status transitions.
- **Observability**
  - Centralize structured logs for sidecar lifecycle, queue transitions, SSE reconnects, and revert operations.
  - Add metrics dashboard baselines for lag, retries, duplicate drops, and job completion time.
  - Add release-gate alerts for regression thresholds.
- **Windows-first packaging and release ops**
  - Build installer/package pipeline for Windows first (portable + installer decision captured in release checklist).
  - Define code signing and update channel strategy for initial release train.
  - Produce QA matrix for supported Windows environments and WSL-assisted workflows.
- **Security verification**
  - Validate localhost-only assumptions and no unintended inbound exposure.
  - Audit secret handling for OpenCode password and Convex credentials across dev/build/release.
  - Run permission/revert safety regression suite before release candidate.

### Deliverables

- Performance budget document with pass/fail thresholds integrated into release checks.
- Reliability/SLO definitions with automated verification points.
- Windows-first build + signing + release checklist pipeline.
- Operational runbooks for top failure classes.

### Definition of Done (Phase 5)

- App meets agreed startup and responsiveness budgets under representative workload.
- Reliability SLOs are measured and meet threshold across test scenarios.
- Windows release pipeline can produce signed artifact and execute smoke tests.
- Critical failure scenarios have tested runbooks and clear user-facing recovery states.
- Security checklist passes with no open high-risk findings.

## Phase 6 — Full Codex Integration Parity (Approved, Gated)

### Entry Gate (mandatory)

- Phase 6 begins only when OpenCode implementation is fully complete and stable.
- Required gate evidence:
  - All OpenCode phase deliverables accepted.
  - OpenCode desktop + mobile pathways validated against defined SLOs.
  - No open P0/P1 defects in OpenCode track.

### Objectives

- Add complete Codex support to the same app architecture with parity to OpenCode experience.
- Preserve unified UX while respecting protocol and sandbox model differences.
- Deliver desktop and mobile compatibility for Codex sessions, including send-message where feature parity exists.

### Scope

- **Provider-agnostic architecture**
  - Implement engine adapter contracts so OpenCode and Codex can plug into shared domain flows.
  - Normalize session/thread, turn/message, and event semantics into one internal model.
  - Isolate protocol specifics in engine drivers (OpenCode REST/SSE vs Codex app-server JSON-RPC).
- **Codex runtime integration**
  - Add Codex sidecar lifecycle management and health/readiness pipeline.
  - Integrate Codex app-server messaging and streaming event handling.
  - Implement reliable reconnect and in-flight recovery semantics for Codex event streams.
- **Parity UX**
  - Desktop: create/manage Codex sessions with same baseline controls as OpenCode.
  - Mobile: viewer + send-message compatibility for Codex sessions where the corresponding OpenCode capability exists.
  - Ensure provider switchability per workspace/session without breaking history views.
- **Policy and security mapping**
  - Map Codex sandbox and approval behaviors into unified permission UX.
  - Expose provider-specific constraints clearly without fragmenting primary interaction patterns.
  - Preserve outbound-only security posture and explicit trust boundaries.
- **Data/sync alignment**
  - Extend Convex schema/indexing where required for dual-engine metadata.
  - Maintain idempotent event mirroring guarantees across both engines.
  - Prevent cross-provider event collisions through namespaced identifiers.

### Deliverables

- Engine adapter layer with working OpenCode + Codex drivers.
- Codex runtime integration in desktop app with stable session lifecycle and streaming.
- Mobile compatibility for Codex session viewing and send-message parity path.
- Unified policy model handling OpenCode and Codex permission/sandbox differences.

### Definition of Done (Phase 6)

- Codex sessions are fully operable in desktop with parity to established OpenCode baseline controls.
- Codex session updates sync through Convex and render correctly on mobile clients.
- Send-message flow for Codex works where parity is defined, with consistent queue semantics.
- Provider-specific permission/sandbox constraints are enforced and clearly communicated in UX.
- Dual-engine architecture passes regression tests without breaking OpenCode behavior.

## Next Step

- Plan is now comprehensive through the approved gated Codex expansion track. Next iteration (optional) can define a separate Phase 7 for cross-platform rollout and advanced orchestration.

