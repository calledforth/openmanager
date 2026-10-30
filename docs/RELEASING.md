# Releasing OpenManager

OpenManager uses GitHub Actions and public GitHub Releases. There are three independent release
trains in this repository:

- **Desktop app**, tags `v*`: the Windows NSIS installer and portable build. Most of this page.
- **Environment server**, tags `server-v*`: the self-contained `openmanager` executable. See
  [Environment server releases](#environment-server-releases) below.
- **Android app**, tags `mobile-v*`: a signed APK on every merge to `dev`. See
  [Mobile releases](#mobile-releases) below.

A desktop release tag builds the Windows NSIS installer, portable executable, updater metadata,
blockmap, checksums, and a GitHub artifact attestation. The installed NSIS build checks GitHub
Releases for updates; the portable build must be updated manually.

## Environment server releases

`.github/workflows/release-server.yml` builds `openmanager` for `win32-x64`, `linux-x64` and
`linux-arm64` (a Node single-executable application; see
[decisions/server-packaging.md](./decisions/server-packaging.md)), smoke-tests each one, and on a
`server-v<version>` tag publishes a GitHub Release with:

- `openmanager-<version>-win32-x64.zip`, `openmanager-<version>-linux-x64.tar.gz`,
  `openmanager-<version>-linux-arm64.tar.gz`
- `install.ps1`, `install.sh` (copies of `scripts/`) and `SHA256SUMS` over all of them
- a build provenance attestation

The release is never marked "latest", so the desktop updater keeps resolving desktop releases. The
install scripts and `openmanager update` find the newest non-draft, non-prerelease `server-v*` tag
themselves. A version with a `-` suffix (`0.3.0-beta.1`) is published as a prerelease and is only
installed when asked for by version.

Pull requests that touch the server build the same archives without publishing; the archives are
attached to the workflow run for 14 days. **Actions → Server Release → Run workflow** does the same
for any branch.

To release:

```sh
git switch -c release/server-0.2.0 origin/main
# bump "version" in apps/server/package.json to 0.2.0, open a PR, merge it
git switch main && git pull --ff-only
git tag -a server-v0.2.0 -m "OpenManager server 0.2.0"
git push origin server-v0.2.0
```

The workflow refuses a tag that does not match `apps/server/package.json`. Never move or reuse a
published tag; fix forward with a new patch version. To ship a newer embedded Node, bump
`SEA_NODE_VERSION` in the workflow and release.

After publishing, check an install from the release on Windows and on Linux or WSL
([install.md](./install.md)), and `openmanager update` from the previous version.

## Mobile releases

`.github/workflows/release-mobile.yml` runs on every merge to `dev` that touches `apps/mobile`,
`packages` or the lockfile. It builds an arm64 Android APK and publishes it, with nothing to do by
hand:

- **The release:** tag `mobile-v<version>`, asset `openmanager-<version>.apk`, always a prerelease
  and never "latest". The version is `app.json`'s with its last part replaced by the workflow's run
  number (`0.1.14`), and the same number becomes Android's `versionCode`. To move to `0.2.x`, edit
  `version` in `apps/mobile/app.json`.
- **The feed:** the `mobile-latest` release holds one file, `latest.json`, which the workflow
  rewrites after the APK is up. The installed app reads that fixed address when it opens, when it
  returns to the front (at most every 30 minutes) and when Settings opens, and offers a newer
  `build` on the home and in Settings. Never delete this release; every installed phone reads it.
- **Cleanup:** only the newest three `mobile-v*` releases stay, and their tags are kept. The
  repository's release feed lists ten entries and the desktop updater reads it, so a release per
  merge must not fill it.

Only these APKs update themselves. `EXPO_PUBLIC_DISTRIBUTION=github` turns on the updater and adds
Android's `REQUEST_INSTALL_PACKAGES` permission (`apps/mobile/app.config.js`); a build without it
has neither. **A Play build must leave it unset:** Play does not allow an app to install its own
updates.

Android asks for confirmation on every update, and once for "Install unknown apps". A build that
cannot start cannot update itself: install the next APK by hand from the Releases page.

### The signing key

Android updates an app in place only when the new APK has the same signature, so **the key can
never change**: a lost key means every phone uninstalls and pairs again. The workflow takes it from
two repository secrets, `ANDROID_KEYSTORE_BASE64` (a PKCS12 keystore, alias `openmanager`) and
`ANDROID_KEYSTORE_PASSWORD`, and refuses to publish an APK whose certificate does not match
`ANDROID_CERT_SHA256`. GitHub secrets cannot be read back, so keep your own copy of the keystore
and password somewhere safe.

## One-time GitHub setup

1. Protect `main` with the **Validate desktop**, **Server / ubuntu-latest / Node 24**,
   **Server / windows-latest / Node 24**, and **Web** checks from `.github/workflows/ci.yml`.
2. Add a tag ruleset for `v*` so only release maintainers can create or delete release tags.
3. Create a GitHub Environment named `release`. Add a required reviewer and restrict it to protected
   branches and tags.
4. For signed stable releases, add these Environment secrets:
   - `WIN_CSC_LINK`: the Windows code-signing certificate as a base64 value or supported secure URL.
   - `WIN_CSC_KEY_PASSWORD`: the certificate password.
5. Ensure Actions may create releases with the repository `GITHUB_TOKEN`. The workflow grants write
   permission only to the publish job.

Do not add a Convex deploy key to GitHub. Packaged applications ask for the public deployment URL at
runtime.

## Test the pipeline without publishing

Open **Actions → Windows Release → Run workflow** and select `main`. A manual run builds and uploads a
14-day workflow artifact but does not create a tag or GitHub Release.

## Publish a prerelease

Use a prerelease to exercise installation and updates before configuring a signing certificate:

```powershell
git switch main
git pull --ff-only
git switch -c codex/release-0.1.1-beta.1
pnpm release:prepare 0.1.1-beta.1
pnpm run ci:desktop
git add package.json apps/desktop/package.json
git commit -m "Prepare v0.1.1-beta.1"
git push -u origin codex/release-0.1.1-beta.1
```

Merge that version PR, update local `main`, and create an annotated or signed tag on the merge commit:

```powershell
git switch main
git pull --ff-only
git tag -a v0.1.1-beta.1 -m "OpenManager v0.1.1-beta.1"
git push origin v0.1.1-beta.1
```

Install the generated `OpenManager-Setup` asset. Repeat with `0.1.1-beta.2` to verify the automatic
download and restart prompt. Prerelease installations stay on the prerelease channel.

## Publish a stable release

Follow the same flow with a stable semantic version such as `0.2.0`. Stable tags are rejected when the
Windows signing secret is missing. The tag must exactly match both package versions and point to a
commit already contained in `origin/main`.

Never move or reuse a published version tag. If a release is bad, publish a newer patch release and
mark the bad GitHub Release accordingly.

## Release readiness checklist

- CI and the manual Windows Release run are green.
- The NSIS installer is code-signed and installs without an unexpected publisher warning.
- Installation, first-run Convex setup, update download, restart, and uninstall have been smoke-tested.
- Release notes call out data migrations, breaking changes, and rollback limitations.
- The app has production icons and publisher metadata.
- Repository rules protect `main`, release tags, Actions workflows, and Environment secrets.
- Crash diagnostics and a user-visible support path are documented before broader distribution.
