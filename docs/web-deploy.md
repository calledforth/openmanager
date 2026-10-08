# Deploying the web client

The web client is a static single-page app on its own origin
([hosting decision](./decisions/web-hosting.md)). This page covers putting the
production build of `apps/web` on Cloudflare Pages, allowing its origin on an
environment server, the headers it is served with, and what browsers do when a
hosted page talks to an environment on `127.0.0.1`.

The static host serves files only. API and WebSocket traffic goes straight
from the browser to the environment's route, never through Pages.

## What gets deployed

`pnpm --filter @openmanager/web build` writes `apps/web/dist`:

- `index.html`, the only HTML page.
- `assets/`, every script, stylesheet, font and WebAssembly file, each with a
  content hash in its name.
- `theme-boot.js`, which applies the saved theme before the first paint. It
  is a file rather than an inline script because the CSP allows no inline
  scripts.
- `_headers`, the response headers below. Vite copies it from
  `apps/web/public/` unchanged.

There is no `404.html` and no `_redirects`. When a project has no top-level
`404.html`, Pages serves `index.html` for any path that is not a file, which
is what a single-page app needs: a reload on `/sessions/<id>`,
`/drafts/<id>`, `/settings` or `/pair` returns the app, and TanStack Router
renders the route. Fragments never reach the host, so a pairing link's token
stays in the browser.

## Deploy to Cloudflare Pages

The account, the Pages project and the domain belong to the owner. Anyone who
can deploy to this origin can read every credential stored in every browser
that uses it (threat model D8), so keep deploy access to the owner.

### Connect the repository (recommended)

In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to
Git**, pick the repository, then set:

| Setting                | Value                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| Production branch      | `main`                                                                                                |
| Framework preset       | None                                                                                                  |
| Build command          | `pnpm --filter @openmanager/web... install --frozen-lockfile && pnpm --filter @openmanager/web build` |
| Build output directory | `apps/web/dist`                                                                                       |
| Root directory         | empty (the repository root, where the lockfile and workspace packages are)                            |

Environment variables, for Production and Preview:

| Variable                  | Value     | Why                                                                                                                |
| ------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------ |
| `NODE_VERSION`            | `22`      | The version CI builds the web app with.                                                                            |
| `PNPM_VERSION`            | `10.30.3` | The `packageManager` version in `package.json`.                                                                    |
| `SKIP_DEPENDENCY_INSTALL` | `1`       | The build command installs only the web app and its workspace packages, not Electron and the rest of the monorepo. |

Never set `VITE_OPENMANAGER_LOCAL_OWNER_CLAIM_KEY` on Pages. Vite would bake it
into the public bundle.

**Save and Deploy** builds `main` and publishes it at
`https://<project>.pages.dev`. A custom domain is added later under the
project's **Custom domains** tab; that is a new origin and needs allowing like
any other (below).

Optional: under **Settings → Build → Build watch paths**, include `apps/web/*`,
`packages/*`, `package.json` and `pnpm-lock.yaml` so server-only commits do not
rebuild the site.

**Preview builds.** Every branch pushed to the repository, and every pull
request from it, gets its own deployment at `<hash>.<project>.pages.dev` and
`<branch>.<project>.pages.dev`. Pull requests from forks are not built. Each
preview is a separate origin: it cannot read the credentials stored by the
production origin, and environments refuse it until it is allowed. Allow a
preview origin only on a test environment, and remove it afterwards. Previews
are public unless **Enable access policy** puts them behind Cloudflare Access;
set preview branches to **None** under **Settings → Build → Branch control** to
turn them off.

### Or upload a local build

Without the Git connection, build locally and upload with Wrangler (it asks
you to log in the first time):

```sh
pnpm --filter @openmanager/web build
npx wrangler pages project create openmanager --production-branch main
npx wrangler pages deploy apps/web/dist --project-name openmanager --branch main
```

The project only needs creating once.

## Allow the origin on the environment

An environment refuses every browser origin it was not told about, on HTTP and
on the WebSocket upgrade. A refused origin gets `403` with no CORS headers, so
the page sees a network failure and the server records `origin.rejected` in
its audit log. Allow the hosted origin exactly, with scheme and no trailing
slash:

```sh
node apps/server/dist/main.js --allowed-origin https://openmanager.pages.dev
```

`OPENMANAGER_ALLOWED_ORIGINS` takes the same values, comma-separated. Repeat
the flag for each origin: the `pages.dev` address, a custom domain, and
`http://localhost:5173,http://127.0.0.1:5173` if you also run `pnpm dev:web`
against this server.

**Background service.** `service install` bakes the flags it is given into
the logon task or systemd unit ([Windows](./windows-startup.md),
[Linux and WSL](./linux-systemd.md)), and a later `install` replaces them.
Run it again with every flag you want kept, plus the origin:

```sh
node apps/server/dist/main.js service install --workspace C:\src\my-repo --allowed-origin https://openmanager.pages.dev
```

`service update` keeps the stored origins, so this is needed only when the
list changes.

**No built-in default.** The server does not allow any hosted origin unless it
is told to. The project has no canonical domain yet, and each owner deploys
their own copy, so a default would allow an origin nobody controls. Revisit
this if OpenManager ever publishes one official web client.

## The first credential on a hosted client

Allowing the origin lets the page talk to the environment; it does not give the
page a credential. There are two ways in.

**On the environment's own computer: paste the owner token.** Open the hosted
app, enter `http://127.0.0.1:43120` (or the port you chose), and paste the
contents of `owner-credential` from the data directory
(`~/.openmanager/owner-credential` by default, `%USERPROFILE%\.openmanager\owner-credential`
on Windows). The browser asks for local network access the first time (see
below). This browser then holds the owner credential, which includes `admin`.

**Any other device: pair it.** In a client that is already connected, open
**Settings → Devices → Pair a device**, tick what the device may do, and pick
the route it should use (the tunnel, for a phone). The link opens `/pair` on
the origin of the app that made it, so make the link from the hosted app,
not from `pnpm dev:web`, whose links point at this computer's loopback
address. The device gets its
own credential, which can be revoked on its own.

`/local-owner` is not a third way. It hands the owner credential only to a
loopback page that also holds the claim key `pnpm dev:web` generates and
shares out of band. A hosted page has no claim key and is not a loopback
origin, so the route answers `403` or `404` whatever origins are allowed. The
connect form says so: in a build without a claim key it asks for the token from
`owner-credential` or a pairing link instead of offering a blank-token claim.

## Response headers

`apps/web/public/_headers` sets these on every response:

| Header                       | Value                                                |
| ---------------------------- | ---------------------------------------------------- |
| `Content-Security-Policy`    | see below                                            |
| `Referrer-Policy`            | `no-referrer`                                        |
| `X-Content-Type-Options`     | `nosniff`                                            |
| `X-Frame-Options`            | `DENY`                                               |
| `Cross-Origin-Opener-Policy` | `same-origin`                                        |
| `Permissions-Policy`         | camera, microphone, geolocation, payment and USB off |
| `Strict-Transport-Security`  | `max-age=31536000`                                   |

It also drops the `Access-Control-Allow-Origin: *` Pages adds by default; no
other site needs to read these files.

**Caching.** Files under `/assets/` get
`Cache-Control: public, max-age=31536000, immutable`: a changed file always
has a new name. Everything else, `index.html` and the single-page fallback
included, keeps Pages' default `public, max-age=0, must-revalidate` with an
`ETag`, so a deploy reaches a reload at once.

### The content security policy

```
default-src 'self';
script-src 'self' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:;
font-src 'self' data:;
connect-src 'self' https: wss: http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*;
worker-src 'none'; frame-src 'none'; object-src 'none';
base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

`script-src` is the directive that protects stored credentials (D8), and it is
strict: only scripts from this origin, no inline script and no `eval`.
`'wasm-unsafe-eval'` lets the code highlighter (Shiki's Oniguruma engine)
compile its bundled WebAssembly; it does not allow JavaScript `eval`. Zod, the
protocol validator, also tries `new Function` once to see whether it can
compile faster parsers, which this policy refuses and reports, so the app turns
that off at startup (`apps/web/src/zod-config.ts`).

`connect-src` is where the policy is loose on purpose. The page must reach:

- loopback environments over `http` and `ws` on any port, since the port is
  the owner's choice;
- tunnel routes over `https` and `wss` on any domain, since every owner
  brings their own (the named tunnel runs on a domain they own).

A static file served to every owner cannot list one owner's domains, so
`connect-src` allows any `https:` and `wss:` host. The cost is that the policy
does not stop an injected script from sending data to a server of its
choosing. That is accepted because `script-src` is what keeps such a script
out in the first place, and a policy that names one domain would break every
other owner's setup. An owner who deploys a private copy can replace
`https: wss:` with their own hosts in `_headers`. `upgrade-insecure-requests`
is left out because it would rewrite `http://127.0.0.1` to `https`.

The rest follows what the app loads:

- `style-src 'unsafe-inline'`: highlighted code and several components set
  `style` attributes. Inline styles cannot run script.
- `img-src data: blob: https:`: attachment previews and artifacts are
  `blob:` URLs fetched with the client's credential, small images are inlined
  as `data:`, link favicons come from Google's favicon service, and Markdown
  from an agent may embed any `https` image. An agent already runs commands on
  the environment, so blocking its images would protect nothing.
- `font-src data:`: Vite inlines the smallest font subsets.
- `worker-src`, `frame-src` and `object-src` are `'none'` because the app uses
  none of them.

`frame-ancestors 'none'` and `X-Frame-Options: DENY` stop other sites from
framing the app to trick a click on a pairing or approval control.

The checks in `apps/web/src/static-hosting.test.ts` keep `index.html` free of
inline scripts and pin the directives above.

## Hosted page to an environment on this device

A hosted page is `https://` on a public origin. Reaching `http://127.0.0.1`
from it runs into two browser rules: mixed content (an `https` page loading
`http`) and local network access (a public page reaching this device). Tested
on 2026-10-07 with this build served from a public quick-tunnel origin
(`https://*.trycloudflare.com`) against an environment on `127.0.0.1`:

| Browser           | Version tested             | `http`/`ws` to `127.0.0.1` from the hosted page                                                                                                                                                                                           |
| ----------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edge              | 154 (installed)            | Asks first: "_site_ wants to Access other apps and services on this device", **Block** / **Allow**, while the app shows _Connecting_. With the permission granted, `fetch` and the WebSocket worked; with it denied, both failed at once. |
| Chromium (Chrome) | 153 (Playwright build)     | Same rule as Edge. Headless, where no prompt can be answered, `fetch` and the WebSocket failed at once.                                                                                                                                   |
| Firefox           | 155 (Playwright build)     | Same kind of permission. Without it, `fetch` and the WebSocket waited on the prompt; with it granted, both worked.                                                                                                                        |
| Safari            | not tested (no macOS here) | Blocked as mixed content, with no prompt. Playwright's WebKit 26.6 build on Windows refused both `http://127.0.0.1` and `ws://127.0.0.1` with "requested insecure content … was blocked".                                                 |

Granting and denying were done through Playwright and the DevTools protocol;
the Edge prompt itself was seen in a normal window. The app ran with no CSP
violations in Edge and Firefox through connecting, reloading `/settings`,
`/playground/connection` and a `/drafts/<id>` page, and loading `blob:`,
`data:` and `https` images.

What the vendors document:

- **Chrome** gates a public page's requests to loopback and private addresses
  behind a permission since Chrome 142, and WebSockets since Chrome 147.
  Current versions call the loopback half of it `loopback-network`; the first
  versions called it `local-network-access`. `http://127.0.0.1` and
  `http://localhost` count as potentially trustworthy, so they are not mixed
  content. ([Chrome blog](https://developer.chrome.com/blog/local-network-access),
  [Chrome 147 notes](https://developer.chrome.com/release-notes/147))
- **Edge** turned the same check on in Edge 143, with the same enterprise
  policies (`LocalNetworkAccessAllowedForUrls`,
  `LocalNetworkAccessBlockedForUrls`).
  ([Microsoft docs](https://learn.microsoft.com/en-us/deployedge/ms-edge-local-network-access))
- **Firefox** has treated `localhost` and `127.0.0.1` as potentially
  trustworthy since Firefox 84 and `ws://` loopback since 68. Its own local
  network access prompt has been rolling out to desktop users through 2026
  (secondary sources put the default at Firefox 153).
  ([MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/84),
  [admin docs](https://firefox-admin-docs.mozilla.org/reference/policies/localnetworkaccess/))
- **Safari** treats `http://127.0.0.1` from an `https` page as mixed content
  and blocks it ([WebKit bug 171934](https://bugs.webkit.org/show_bug.cgi?id=171934)),
  and has no permission to grant. Safari, and every browser on iOS, has to use
  the tunnel route.

What OpenManager does with that:

- **While the prompt is open**, the bootstrap request on the route in use
  waits on it and the app shows _Connecting_; it does not move to the tunnel
  until the person answers. A route search or a health probe that meets the
  open prompt gives up after a few seconds and reads the route as unreachable.
- **Allowed:** the loopback route works like it does in `pnpm dev:web`.
- **Blocked:** the loopback route fails at once and route search moves to the
  next saved route, normally the tunnel; the environment, its token and its
  sessions stay as they were. With no other route, the app shows **Local
  access blocked** and says where to allow it, instead of claiming the
  environment is offline. The client reads the browser's `loopback-network`
  permission to tell the two apart, because the failed request itself looks
  the same as nothing listening
  ([environment routes](./environment-routes.md#the-route-in-use-fallback-and-reconnect)).
  It never asks for the older combined `local-network-access` permission:
  that query crashes the page in older Chrome, and `try` cannot catch it.
- **Closed without answering, Safari, or a Chrome too old to know
  `loopback-network`:** the browser reports nothing the page can read, so the
  loopback route reads as _Environment offline_. That wording
  asks the person to check both the server and that the browser lets the page
  reach this device.

## Check a build locally

Serve the build with the same header and fallback rules Pages uses, no
account needed:

```sh
pnpm --filter @openmanager/web build
npx wrangler pages dev apps/web/dist --port 8788
```

Start an environment with `--allowed-origin http://127.0.0.1:8788` and open
that address. To see the hosted-page behaviour above, the page has to be on a
public `https` origin: `cloudflared tunnel --url http://127.0.0.1:8788` gives
a temporary `https://*.trycloudflare.com` address to allow and open instead.
Stop the tunnel when done.
