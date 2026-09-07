# Browser stack: Vite SPA + React + TanStack Router + TanStack Query

Status: Accepted, 2026-09-06. Recorded from [CAL-18](https://linear.app/calledforth/issue/CAL-18/decision-record-the-browser-stack-vite-spa-vs-tanstack-start-vs-nextjs).

## Decision

Build the canonical OpenManager browser client as an independently hosted static SPA.

Chosen stack:

- React
- Vite 7
- TanStack Router
- TanStack Query
- Vitest and the existing pnpm monorepo tooling

No Next.js and no TanStack Start for this client architecture.

## Context and rationale

OpenManager is an authenticated, long-running, local-first client. The environment server already owns the backend, state, API/WebSocket transport, and privileged operations. The browser app should optimize for client startup, typed routing, cache/reconnect behavior, and shared browser/desktop ergonomics — not SSR or SEO.

TanStack Router gives file-based routes, loaders, and type safety without a full-stack framework. TanStack Query fits server/cache state around environment connections and route data. Staying on Vite matches the existing monorepo and keeps the UI browser-safe so Electron can later load the same application core behind desktop adapters.

## Alternatives considered

| Alternative    | Assessment                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Next.js        | SSR, SEO, RSC, server actions, and an application-server layer are not useful enough here to justify the extra framework model.                                    |
| TanStack Start | We want the TanStack client primitives, but Start’s server layer is unnecessary while the environment server exists. Revisit only if frontend-owned SSR is needed. |

## Consequences

- Shared product UI and the environment client must remain browser-safe.
- Desktop-only capabilities sit behind explicit adapters; Electron globals must not leak into shared code.
- Browser and desktop should share the same application core and environment model over time.
- Hosting is an independently deployed static SPA (see [web-hosting.md](./web-hosting.md)). The environment server does not own the canonical frontend.

## Validation in this repository

The scaffold lives in `apps/web`. It boots in a normal browser without Electron or a Convex URL.

## Related records

- Hosting and origin: [web-hosting.md](./web-hosting.md)
- Environment server runtime: [environment-server-runtime.md](./environment-server-runtime.md)
