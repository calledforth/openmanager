# Releasing OpenManager

OpenManager uses GitHub Actions and public GitHub Releases. A release tag builds the Windows NSIS
installer, portable executable, updater metadata, blockmap, checksums, and a GitHub artifact
attestation. The installed NSIS build checks GitHub Releases for updates; the portable build must be
updated manually.

## One-time GitHub setup

1. Protect `main` with the **Validate desktop** check from `.github/workflows/ci.yml`.
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
