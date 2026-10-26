#!/usr/bin/env bash
# Build one standalone bridge kit: scripts/package-release.sh VERSION BUN_TARGET OUT_DIR
# e.g. 0.1.14 bun-darwin-arm64 dist  ->  dist/agent-remote-bridge-0.1.14-macos-arm64.zip
# macOS kits are ad-hoc signed when packaged on a Mac (codesign), which they need to run.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$1 target=$2 out=$(mkdir -p "$3" && cd "$3" && pwd)
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Bad version: $version" >&2; exit 2; }
case $target in
  bun-darwin-arm64) name=macos-arm64 os=macos ;;
  bun-darwin-x64) name=macos-x64 os=macos ;;
  bun-linux-x64) name=linux-x64 os=linux ;;
  bun-linux-arm64) name=linux-arm64 os=linux ;;
  *) echo "Unsupported target: $target" >&2; exit 2 ;;
esac
runtime=$(bun --version)
license="licenses/Bun-$runtime.md"
[[ -f $license ]] || { echo "Add the Bun $runtime runtime licence as $license first" >&2; exit 1; }
stage=$(mktemp -d)/agent-remote
mkdir -p "$stage"
bun build src/cli.ts --compile --target="$target" --define HERDR_REMOTE_VERSION="\"$version\"" --outfile "$stage/herdr-remote" >/dev/null
if [[ $os == macos && $(uname) == Darwin ]]; then
  codesign --force --sign - "$stage/herdr-remote"
  codesign --verify --strict "$stage/herdr-remote"
fi
cp LICENSE THIRD_PARTY_NOTICES.md "$stage/"
cp "$license" "$stage/BUN-RUNTIME-LICENSE.md"
cp "release/README-$os.txt" "$stage/README.txt"
[[ $os == linux ]] && cp release/herdr-remote.service "$stage/"
zip_name="agent-remote-bridge-$version-$name.zip"
(cd "$(dirname "$stage")" && rm -f "$out/$zip_name" && zip -qr "$out/$zip_name" agent-remote)
rm -rf "$(dirname "$stage")"
echo "$out/$zip_name"
