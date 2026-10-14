#!/bin/sh
# Installs the OpenManager environment server on Linux (including WSL) from a
# GitHub Release.
#
#   curl -fsSL https://raw.githubusercontent.com/calledforth/openmanager/main/scripts/install.sh | sh
#
# Needs only sh, tar, curl or wget, and sha256sum or shasum: the release is a
# single `openmanager` executable with Node built in. Running it again upgrades
# in place and moves an installed background service to the new version.
#
# Environment overrides:
#   OPENMANAGER_VERSION           install this version (for example 0.2.0) instead of the newest
#   OPENMANAGER_INSTALL_DIR       install folder (default ${XDG_DATA_HOME:-~/.local/share}/openmanager)
#   OPENMANAGER_BIN_DIR           folder for the openmanager command (default ~/.local/bin)
#   OPENMANAGER_RELEASE_BASE_URL  mirror of https://github.com/calledforth/openmanager/releases/download
set -eu

repo=calledforth/openmanager

step() { printf '  %s\n' "$1"; }
fail() {
  printf 'OpenManager install: %s\n' "$1" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) ;;
  Darwin) fail "macOS is not supported yet." ;;
  *) fail "no build for $(uname -s)." ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "no build for a $(uname -m) processor." ;;
esac
# The executable is Node's official glibc build; musl distros (Alpine) cannot run it.
if ldd --version 2>&1 | grep -qi musl; then
  fail "this system uses musl libc (Alpine?); OpenManager needs a glibc distribution."
fi

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL -H 'User-Agent: openmanager-install' -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q --header='User-Agent: openmanager-install' -O "$2" "$1"; }
else
  fail "needs curl or wget."
fi
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "needs sha256sum or shasum."
fi
command -v tar >/dev/null 2>&1 || fail "needs tar."

tmp=$(mktemp -d)
staging=
trap 'rm -rf "$tmp" ${staging:+"$staging"}' EXIT INT TERM

version=${OPENMANAGER_VERSION:-}
if [ -z "$version" ]; then
  step "Finding the newest release..."
  # Newest first; desktop releases share the list, so read on until a page
  # has a server one. Unauthenticated listings never include drafts, and
  # prerelease versions carry a '-'.
  version=
  page=1
  while [ -z "$version" ] && [ "$page" -le 5 ]; do
    fetch "https://api.github.com/repos/$repo/releases?per_page=100&page=$page" "$tmp/releases.json" ||
      fail "could not ask GitHub for the newest release. Set OPENMANAGER_VERSION to skip the lookup."
    version=$(grep -o '"tag_name": *"server-v[0-9][0-9.]*"' "$tmp/releases.json" |
      sed 's/.*"server-v\([0-9.]*\)"/\1/' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
    [ "$(grep -o '"tag_name"' "$tmp/releases.json" | wc -l)" -lt 100 ] && break
    page=$((page + 1))
  done
  [ -n "$version" ] || fail "GitHub lists no published OpenManager server release yet."
fi
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' ||
  fail "'$version' is not a version number."

root=${OPENMANAGER_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/openmanager}
base_url=${OPENMANAGER_RELEASE_BASE_URL:-https://github.com/$repo/releases/download}
base_url=${base_url%/}
version_dir="$root/versions/$version"
archive="openmanager-$version-linux-$arch.tar.gz"

if [ -f "$version_dir/.install-complete" ] && [ "$(cat "$version_dir/.install-complete")" = "$version" ]; then
  step "OpenManager $version is already downloaded."
else
  step "Downloading $archive..."
  fetch "$base_url/server-v$version/SHA256SUMS" "$tmp/SHA256SUMS" ||
    fail "could not download the checksums of $version."
  expected=$(grep -E "^[0-9a-fA-F]{64}[[:space:]]+\*?$archive\$" "$tmp/SHA256SUMS" | cut -c1-64 | tr 'A-F' 'a-f')
  [ -n "$expected" ] || fail "SHA256SUMS of $version does not list $archive."
  fetch "$base_url/server-v$version/$archive" "$tmp/$archive" || fail "could not download $archive."
  actual=$(sha256 "$tmp/$archive")
  [ "$actual" = "$expected" ] ||
    fail "checksum mismatch for $archive (expected $expected, got $actual). Nothing was installed."

  step "Unpacking..."
  # Unpack and test-run beside the target, not in $TMPDIR (often mounted
  # noexec), so the final move is also a rename on one filesystem.
  staging="$root/versions/.staging-$$"
  rm -rf "$staging"
  mkdir -p "$staging"
  tar -xzf "$tmp/$archive" -C "$staging"
  chmod 755 "$staging/openmanager"
  reported=$("$staging/openmanager" --version) ||
    fail "the downloaded executable does not run here."
  [ "$reported" = "$version" ] || fail "the downloaded executable reports '$reported', expected $version."
  printf '%s' "$version" >"$staging/.install-complete"
  rm -rf "$version_dir"
  mv "$staging" "$version_dir"
  staging=
fi

# Writes the launcher and moves an installed service to this version.
"$version_dir/openmanager" activate || fail "activating the new version failed; see the message above."

cat <<EOF

Next: run the environment server in the background with systemd:

  openmanager service install

Add --tunnel-hostname and --allowed-origin for remote access. Guide:
  https://github.com/$repo/blob/main/docs/install.md
EOF
