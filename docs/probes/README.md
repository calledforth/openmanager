# Provider wire probes

Throwaway scripts used to establish the reasoning/thinking findings in
[`../claude-codex-integration-plan.md` §3a](../claude-codex-integration-plan.md). They spawn a
real provider CLI, run one prompt against this repo, and print a timestamped timeline of the
stream plus a raw `.jsonl` dump next to the script.

They are diagnostics, not tests — nothing imports them and CI does not run them.

| Script | Probes | Notes |
|---|---|---|
| `cursor-acp-probe.cjs` | `cursor-agent acp` | `PROBE_MODEL` takes the bracketed config id, e.g. `'composer-2.5[fast=true]'`. Set `CURSOR_AGENT_VERSION_DIR` after a cursor-agent upgrade. |
| `claude-stream-probe.cjs` | `claude -p --output-format stream-json --include-partial-messages` | `PROBE_MODEL` optional (`sonnet`, `opus`). Runs in `--permission-mode plan`. |
| `codex-app-server-probe.cjs` | `codex app-server` | Already spawns with `-c model_reasoning_summary="detailed" -c show_raw_agent_reasoning=true`; drop those to see the empty-summary default. |

```sh
node docs/probes/cursor-acp-probe.cjs
PROBE_MODEL='composer-2.5[fast=true]' node docs/probes/cursor-acp-probe.cjs
node docs/probes/claude-stream-probe.cjs
node docs/probes/codex-app-server-probe.cjs
```

All three accept `PROBE_PROMPT` to override the default prompt and `PROBE_OUT` to name the raw
dump. Re-run them before implementing either backend — the CLIs are version-sensitive and two
of the three surfaces are explicitly experimental. Results as of 2026-07-25 were taken on
cursor-agent `2026.07.23-e383d2b`, `claude` 2.1.220, `codex-cli` 0.144.6.
