# Environment server threat model

The environment server can read code, run shells and drive coding agents. This
document records who can reach it, what they are allowed to do, how each attack
path is closed, and which issue owns the fix. The Wave 2 security issues
(capabilities, authenticated sockets, origin/path enforcement, audit) and the
later Pairing, Cloudflare and Account projects implement against it.

Remote access is in scope now. The Cloudflare tunnel lands in Wave 5 and
account sign-in in Wave 7, but every rule below already assumes a client can be
on the other side of the internet. Nothing built in Wave 2 may depend on the
caller being on the same machine.

## Decisions

These are the rules everything else follows. Each threat below points back to
them.

**D1. The environment server makes every access decision.** Every HTTP request
and every WebSocket command is checked on the server against the caller's own
credential and capabilities. Browser UI restrictions, account records, origin
checks and the tunnel are never a substitute for that check.

**D2. Network position grants nothing.** Loopback, LAN, Tailscale and tunnel
traffic are treated the same. When the Cloudflare tunnel runs, `cloudflared`
connects to the server from `127.0.0.1`, so every internet request looks local.
A rule like "loopback is the owner" would therefore make the internet the owner.
The local owner gets a credential minted by the local process, not trust from
the socket address.

**D3. Every client has its own revocable credential.** A credential identifies
one client (label, device type, created and last-seen time), carries that
client's capabilities and an expiry, and is stored hashed on the server.
Revoking it closes that client's open sockets immediately and leaves every
other client connected. Losing a phone means revoking that phone. The current
environment-wide `<data-dir>/client-token` is a Wave 1 development credential
and is removed once per-client credentials exist.

**D4. Capabilities are deliberate grants.** Access is split into capabilities,
and the owner chooses which ones a client gets. Draft set (CAL-45 fixes the
names and maps them to protocol commands):

| Capability | Allows                                                                    |
| ---------- | ------------------------------------------------------------------------- |
| `read`     | Sessions, history, status, workspace listing, file and git state.         |
| `operate`  | Create, rename and delete sessions; write files; stage, commit, branch.   |
| `agent`    | Send prompts and answer agent approvals and questions.                    |
| `terminal` | Create, attach to, type into and close terminals.                         |
| `admin`    | Create pairing links, list and revoke clients, account link, route setup. |

Pairing never silently grants `agent`, `terminal` or `admin`. The pairing
screen shows each one as a separate choice, unticked until the owner ticks it,
and the link carries exactly that grant. A client can only ever exchange for a
subset of what its link granted. Only the local owner credential starts with
`admin`.

**D5. Agent execution is code execution.** Agents run shell commands, so a
client with `agent` can usually do what a client with `terminal` can. The two
stay separate so the owner can say what a device is for, but the UI presents
both as "can run code on this machine", and neither is treated as the safe
option. A real boundary between them needs the server to enforce a per-client
agent approval policy. That is out of scope for Wave 2 and recorded as a
follow-up.

**D6. Cloud sign-in works like T3 Connect: linking is the consent, not
per-device pairing.** Signing in to an account gives no access to any machine
on its own. The owner links an environment to their account, once, from a
local client that holds `admin`. That link is the explicit authorization, and
it also sets the grant that signed-in devices will receive (the D4 choices,
never `admin`). After linking:

- Any device signed in to the same account can connect to that environment
  without a pairing step.
- The account service asks the environment to mint a one-time credential. The
  environment checks the request is signed by the account service, names the
  linked user, is fresh and has not been used before, and only then issues the
  device **its own** credential, capped at the link's grant.
- Cloud-minted clients appear in the same client list as paired ones and are
  revoked the same way. Unlinking revokes all of them.
- The account service never receives the resulting environment credential.
  Cloud-minted credentials are bound to a key held by the device (DPoP-style
  proof of possession), so neither the account service nor the tunnel can
  replay them.
- The account service stores discovery data only (account, environment id,
  label, route). It never holds messages, files, provider secrets or
  environment credentials.

The trade-off is that account security becomes environment security for linked
environments: a stolen account session reaches every linked environment, up to
the link's grant. The mitigations are the grant cap, the visible client list,
per-device revocation, an audit event on every cloud mint, and unlink. Pairing
by link or QR keeps working with no account at all.

**D7. Browsers use bearer credentials, not cookies.** Under the hosting decision
(CAL-19) the web app is served from its own origin and talks cross-origin to
each environment, so an environment cookie would be a third-party cookie, which
browsers increasingly block. Credentials are held by the web app (IndexedDB),
sent in the `Authorization` header or the WebSocket subprotocol, and never put
in a URL. The one exception is the single-use pairing token, which travels in
the URL fragment (`#`) so it is never sent to the hosted app's server and is
stripped from history after use. Using bearer credentials removes classic CSRF
and moves the risk to script injection on the web app's origin (D8).

**D8. The hosted web app is part of the trusted base.** Anyone who can ship
JavaScript to the canonical web origin can read every stored environment
credential in every browser that uses it. The Pages/Vercel account, the build
pipeline and every script the page loads are therefore security-critical. The
page runs under a strict CSP with no inline or third-party scripts, and deploy
access is limited to the owner. Binding browser credentials to a
non-extractable WebCrypto key (as in D6) is the later hardening step.

**D9. Clients refer to workspaces by ID, never by root path.** The server
registers workspace roots and gives them IDs. Clients send a workspace ID plus
a path relative to it. The server resolves the real path (following symlinks
and Windows junctions, and handling case-insensitivity, UNC, 8.3 short names
and `\\wsl$`) and rejects anything that lands outside the registered root.
Absolute paths from clients are rejected. This boundary covers OpenManager's
own file, git, upload and terminal APIs. It does not cover what a provider CLI
reads by itself; that is governed by the provider's own permission mode.

**D10. Provider secrets stay on the environment.** Provider API keys and
logins and environment signing keys never leave the environment: they are never
sent to clients, written to audit or structured logs, or stored by the account
service. Client credentials are held only by their client and, as hashes, by
the server; they are never logged.

**D11. Pre-authentication endpoints return only what's needed to connect.**
`/health` and `/bootstrap` answer without a credential. `/bootstrap` returns
environment identity, protocol version and supported auth methods. Provider
details and anything else describing the machine sit behind authentication.

## Accepted risks

These are deliberately not defended against. Revisit them if the product
changes.

- **Malware running as the same OS user.** It can read the data directory,
  including stored credentials and provider logins, directly.
- **A compromised provider CLI or agent.** It runs with the user's permissions
  and can read outside any workspace. D9 does not constrain it.
- **Cloudflare terminates TLS.** Tunnel traffic, including credentials and code,
  is visible to Cloudflare.
- **Account service compromise.** It holds the key that signs mint requests, so
  a compromise can mint credentials for every linked environment, up to each
  link's grant (never `admin`). Unlink is the recovery path.
- **An unlocked, already-authorized device in someone else's hands.** Revoking
  that client is the recovery path.

## Assets

| Asset             | Why it matters                                                      |
| ----------------- | ------------------------------------------------------------------- |
| Code and files    | Source code, including private repositories and uncommitted work.   |
| Secrets           | Provider logins and API keys, environment keys, client credentials. |
| Terminals         | An interactive shell as the user.                                   |
| Agent control     | Prompts and approvals, which amount to shell access (D5).           |
| Session history   | Conversations, which routinely contain code, secrets and plans.     |
| Access management | Pairing, revocation and account links; controls every other asset.  |

## Actors

| ID  | Actor                                       | Starting position                                                               |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------- |
| A1  | Owner on the local machine                  | Holds the local owner credential (CAL-49).                                      |
| A2  | Paired or cloud-connected client            | Holds its own scoped credential; may be lost, stolen or over-granted.           |
| A3  | Stolen cloud-account session                | Signed in as the owner on the account service; holds no environment credential. |
| A4  | Unauthenticated internet                    | Can reach the tunnel hostname, or has found a leaked pairing link.              |
| A5  | Malicious website                           | Runs in the owner's browser and can send requests to `127.0.0.1` or rebind DNS. |
| A6  | Whoever can ship code to the hosted web app | Pages/Vercel account, build pipeline, or a script the page loads.               |
| A7  | Compromised account service                 | Can sign mint requests for linked environments.                                 |

## Threats and owners

Each threat names the decision that closes it and the issue that implements the
fix. Issues in other projects own the parts that land with their feature.

| ID  | Threat                                                                                                                                                  | Actors     | Closed by | Owner                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------- | -------------------------------------- |
| T1  | Unauthenticated HTTP or WebSocket access to state or commands.                                                                                          | A4, A5     | D1, D3    | CAL-46, CAL-111 (through the tunnel)   |
| T2  | Tunnel traffic arrives from `127.0.0.1` and is treated as the local owner; local-only endpoints trust forwarded headers.                                | A4         | D2        | CAL-49, CAL-47, CAL-109                |
| T3  | A pairing link is reused, leaked through history or a screenshot, or brute-forced.                                                                      | A4         | D4, D7    | CAL-102, CAL-106, CAL-107, CAL-47      |
| T4  | Pairing hands a device more than intended, or every device ends up with `admin`.                                                                        | A2         | D4        | CAL-45, CAL-103, CAL-107               |
| T5  | A client credential is stolen (lost phone, logs, URLs) and used until someone notices.                                                                  | A2, A6     | D3, D7    | CAL-45, CAL-46, CAL-104, CAL-105       |
| T6  | A stolen account session controls machines.                                                                                                             | A3         | D6        | CAL-146, CAL-147, CAL-144              |
| T7  | The account service mints credentials it shouldn't, or replays the ones it helped mint.                                                                 | A7         | D6        | CAL-146 (residual risk accepted)       |
| T8  | A website in the owner's browser sends cross-site requests to the local server (CSRF).                                                                  | A5         | D7        | CAL-47, CAL-46                         |
| T9  | DNS rebinding: a page on an attacker hostname resolving to `127.0.0.1` makes same-origin requests that carry no `Origin` header.                        | A5         | D11       | CAL-47                                 |
| T10 | Injected or malicious script on the hosted web origin reads stored credentials.                                                                         | A6         | D8        | **None yet, new issue proposed below** |
| T11 | Path traversal (`..`, symlinks, junctions, absolute paths) reaches files outside a workspace.                                                           | A2         | D9        | CAL-51, CAL-118, CAL-86, CAL-47        |
| T12 | Workspace substitution: a client sends a different root than the one registered.                                                                        | A2         | D9        | CAL-50, CAL-51, CAL-57, CAL-47         |
| T13 | Capability escalation: a command runs without the right capability, a token is exchanged for a broader grant, or agent approval is used to get a shell. | A2         | D4, D5    | CAL-45, CAL-46, CAL-131                |
| T14 | Flooding of pairing, prompt or other mutating endpoints.                                                                                                | A4, A2     | D1        | CAL-47                                 |
| T15 | Secrets leak to clients, logs, audit records or the account service.                                                                                    | A2, A3, A7 | D10       | CAL-45, CAL-48, CAL-144                |
| T16 | Misuse goes unnoticed, or can't be traced to a client.                                                                                                  | all        | D3        | CAL-48                                 |

## Where the code is today

This is the Wave 1 starting point the issues above replace:

- The server listens on `127.0.0.1` only (`apps/server/src/server.ts`).
- One environment-wide token is created at `<data-dir>/client-token` and
  accepted as a Bearer header or an `openmanager.auth.<token>` WebSocket
  subprotocol (`apps/server/src/credential.ts`, `apps/server/src/websocket.ts`).
  There is no client identity, capability check or per-client revocation. That
  is T4, T5 and T13.
- HTTP and WebSocket requests are checked against an exact origin allowlist,
  but only when an `Origin` header is present (`websocket.ts:86`,
  `server.ts:103`). There is no `Host` check, so the DNS-rebinding case (T9) is
  open.
- `/bootstrap` is unauthenticated and includes the provider snapshot, which D11
  moves behind authentication.

## Follow-up work this document creates

Proposed, not yet filed:

- **New issue: harden the hosted web app origin (T10).** Strict CSP with no
  inline or third-party scripts, restricted deploy access, pinned dependencies,
  and a later step binding browser credentials to a non-extractable key.
- **CAL-45 scope addition (D5):** state that `agent` and `terminal` carry the
  same risk, and record per-client agent approval policy as a later
  enforcement step.
- **CAL-47 scope addition (T9, T2):** a `Host` header allowlist, and rejection
  of forwarded host and protocol headers on local-only endpoints.
- **CAL-46 scope addition (D11):** trim `/bootstrap` to the pre-auth fields.
- **CAL-147 wording:** replace "signed-in user without pairing cannot read
  sessions/files" with "a signed-in user cannot reach an environment that is
  not linked, and a linked environment grants no more than the link's grant,
  never `admin`".
- **CAL-146:** record the D6 model (the link is the consent, and signed-in
  devices enroll without per-device approval) as the first-release policy.
