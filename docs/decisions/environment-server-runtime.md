# Environment server runtime: Node 24 LTS

Status: Accepted, 2026-09-06.

## Decision

Use Node.js 24 LTS with TypeScript for the standalone environment server.
Compile production source to ESM JavaScript; use Node's native TypeScript
stripping and file watcher for development. Source uses erasable TypeScript;
the compiler rewrites relative `.ts` imports to `.js` for the production build.
Native stripping does not typecheck code, so typechecking remains a separate gate.
Keep pnpm, TypeScript, and Vitest consistent with the existing monorepo.
The server package declares the supported major version and uses Node 24 types.
The existing desktop CI/runtime versions are not changed by this decision.

## Context and rationale

The environment server coordinates local agent processes, streams their events,
and will own local persistence and developer resources. The existing
`@agentpack/runtime` is TypeScript and already uses Node child processes,
streams, filesystem APIs, provider SDKs, and Windows process handling. Node
preserves those implementations without introducing a runtime compatibility
layer or a second service boundary.

Node 24 is LTS at the decision date; Node 26 is still Current. Node recommends
LTS releases for production. This is a compatibility and maintenance decision,
not a claim that Node has the lowest idle memory or the highest throughput.
No comparative performance benchmark was performed for this scaffold.

## Alternatives considered

| Alternative | Assessment                                                                                                                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bun         | Potential future experiment. Its Node compatibility documentation lists remaining differences; provider SDKs, subprocess lifecycle, SQLite, and PTYs need project-specific validation before substitution.                                                 |
| Deno        | Supports Node/npm code, but native addons and some APIs require extra compatibility setup. Its toolchain provides limited immediate benefit over the existing pnpm/Vitest workflow.                                                                        |
| Go or Rust  | Could be evaluated for deployment or measured resource constraints. Reusing the existing TypeScript provider runtime would require an additional JS process and internal protocol, or a port of the runtime. That cost is not justified by evidence today. |

## Consequences and validation

- Keep blocking CPU work and large synchronous operations away from the event
  loop so they cannot stall streaming, cancellation, and heartbeats.
- Measure idle CPU, memory, wakeups, and active streaming responsiveness with
  real providers before promising performance budgets or changing runtimes.
- Validate subprocess startup, cancellation, and cleanup on Windows, WSL, and
  Linux as the runtime bridge and packaging work land.
- Revisit packaging once SQLite and PTY dependencies are selected. This decision
  does not promise a single executable or prescribe a SQLite driver.
- Deployments must supply a supported Node 24 runtime until packaging provides
  one. Track Node security updates and reassess the supported LTS major before
  its support window ends.
- This decision leaves the browser framework and web hosting/origin choices to
  [web-browser-stack.md](./web-browser-stack.md) and [web-hosting.md](./web-hosting.md).

## Sources

- [Node release schedule and production guidance](https://nodejs.org/en/about/previous-releases)
- [Node event-loop guidance](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)
- [Bun Node compatibility](https://bun.com/docs/runtime/nodejs-compat)
- [Deno Node/npm compatibility](https://docs.deno.com/runtime/fundamentals/node/)
- Repository: `packages/agent-runtime/package.json`,
  `packages/agent-runtime/src/session/ChildProcessConnection.ts`, and
  `packages/agent-runtime/src/session/claude/ClaudeProbeRuntime.ts`.
