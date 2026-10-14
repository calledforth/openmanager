# Server packaging: a self-contained executable from GitHub Releases

Status: Accepted, 2026-10-14.

## Decision

The environment server ships as **one `openmanager` executable per platform**
(Windows x64, Linux x64 and arm64), built as a Node single-executable
application with Node embedded. A `server-v<version>` tag builds the
executables in CI and publishes them as archives on a GitHub Release with a
`SHA256SUMS` file. `install.ps1` (`irm … | iex`) and `install.sh`
(`curl … | sh`) download, verify and unpack a release into a per-version
folder and put an `openmanager` command on `PATH`. `openmanager update`
replaces it and hands the background service over through the existing
`service update`; `openmanager uninstall` removes everything except the data.

This is the shape T3 Code uses for its `t3` CLI.

## Why

- **No prerequisite.** A user of the background environment should not need
  Node, npm, a checkout or a build.
- **The service survives the machine's Node.** The logon task and systemd unit
  previously recorded the `node` that ran `install`. With a version manager
  (nvm, fnm) that path changes or disappears; switching below Node 24 broke the
  service at the next sign-in. The executable is a fixed path the service owns.
- **Nothing native to ship.** The server is plain JavaScript plus Node's
  built-in SQLite. The Claude agent SDK's bundled per-platform `claude` binary
  is never used (the runtime always runs the user's own `claude`), so it is
  left out of the bundle.
- **Updates have a home.** Versions sit side by side in
  `<root>/versions/<version>`, so an update never overwrites the files of the
  running server, and the previous version stays for a manual rollback.

## Alternatives

- **npm package run with `npx`.** Needs Node on the machine, and the npx cache
  is temporary: a service pointing into it breaks when npm cleans it.
  `npm i -g` lives inside the active Node install, so switching Node versions
  hides it. Kept as a possible later channel for developers.
- **Require Node 24+ and ship plain JavaScript.** One archive for every
  platform and no Node to keep patched, but the service would still depend on
  the user's Node path. Rejected for that reason; the checkout path still works
  this way and prints a clear message on Node older than 24.
- **Bundle the server in the desktop installer.** Waits on the desktop moving
  off Convex (Wave 7) and does not cover Linux/WSL machines without a desktop.

## Consequences

- Node security fixes reach users only through a release. CI pins the embedded
  Node (`SEA_NODE_VERSION` in `release-server.yml`); bump it and release.
- `node --build-sea` copies the Node that runs it, so each platform builds on
  its own runner, with Node 25.7 or newer. Releases embed Node 26.
- The Windows executable is not code-signed yet.
- macOS needs a launchd backend before it can be offered; there is no build.
- winget, scoop and Homebrew can be added later as manifests that point at the
  same release archives.
