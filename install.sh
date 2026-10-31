#!/bin/sh
# Install the AI Agent Remote bridge (herdr-remote) for this user, no sudo:
#   curl -fsSL https://raw.githubusercontent.com/gremia-tech/agent-remote-bridge/main/install.sh | sh
# Downloads the latest release kit for this computer, refuses it unless its SHA-256 matches the
# release's SHA256SUMS, unpacks it under ~/.local/share/agent-remote-bridge/VERSION and links
# ~/.local/bin/herdr-remote. AGENT_REMOTE_VERSION=0.1.N installs a specific release.
set -eu
repo="gremia-tech/agent-remote-bridge"
fail() { printf 'agent-remote install: %s\n' "$1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required"; }
need curl; need uname
case "$(uname -s)" in
  Darwin) os=macos ;;
  Linux) os=linux ;;
  *) fail "unsupported system $(uname -s); download a kit from https://github.com/$repo/releases" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail "unsupported processor $(uname -m)" ;;
esac
# Apple silicon reports x86_64 under Rosetta; prefer the native kit.
if [ "$os" = macos ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi

version="${AGENT_REMOTE_VERSION:-}"
if [ -z "$version" ]; then
  location=$(curl -fsSI "https://github.com/$repo/releases/latest" | tr -d '\r' | sed -n 's/^[Ll]ocation: .*\/tag\/server-v//p' | tail -n 1)
  version="$location"
fi
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "could not find the latest release"

kit="agent-remote-bridge-$version-$os-$arch.zip"
base="https://github.com/$repo/releases/download/server-v$version"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
printf 'Downloading %s\n' "$kit"
curl -fsSL -o "$work/$kit" "$base/$kit" || fail "download failed"
curl -fsSL -o "$work/SHA256SUMS" "$base/SHA256SUMS" || fail "checksum download failed"
expected=$(awk -v f="$kit" '$2 == f || $2 == "*"f {print $1}' "$work/SHA256SUMS")
[ -n "$expected" ] || fail "$kit is not listed in SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$work/$kit" | awk '{print $1}')
else actual=$(shasum -a 256 "$work/$kit" | awk '{print $1}'); fi
[ "$actual" = "$expected" ] || fail "checksum mismatch for $kit; nothing was installed"

target="$HOME/.local/share/agent-remote-bridge/$version"
mkdir -p "$target" "$HOME/.local/bin"
if command -v unzip >/dev/null 2>&1; then unzip -qo "$work/$kit" -d "$work/kit"
elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -e "$work/$kit" "$work/kit"
else fail "unzip or python3 is required"; fi
cp -R "$work/kit/agent-remote/." "$target/"
chmod 755 "$target/herdr-remote"
ln -sf "$target/herdr-remote" "$HOME/.local/bin/herdr-remote"

printf '\nInstalled herdr-remote %s to %s\n' "$version" "$HOME/.local/bin/herdr-remote"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) printf 'Add it to your PATH:  export PATH="$HOME/.local/bin:$PATH"\n' ;; esac
printf '\nNext: run  herdr-remote up  and pair from the AI Agent Remote app on the same Wi-Fi.\n'
