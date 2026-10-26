# AI Agent Remote bridge

The open-source host for **AI Agent Remote**, an iPhone/Android companion for
Herdr, the terminal workspace manager for coding agents (Orca, or plain terminals with no multiplexer, work too). The bridge runs on your computer and lets
the phone app browse workspaces, watch panes and coding agents, read agent
transcripts, and (with an explicit control lease) type into terminals. The phone
talks directly to your computer over TLS with a pinned certificate; there is no
hosted service.

## Quick start (same Wi-Fi)

Requires Herdr, OpenSSL and [Bun](https://bun.sh) 1.3.9+ (on Linux also `avahi-utils`
for discovery).

```sh
cd server
bun install --frozen-lockfile
bun src/cli.ts up
```

Open the app: your computer appears under **On this network**. Tap it, choose
**Show code on computer** and type the 6-digit code that pops up here.

Keep it running with `deploy/systemd/herdr-remote.service` (Linux user service) or
`deploy/launchd/dev.herdr.remote.plist.example` (macOS LaunchAgent).

No Herdr? `bun src/cli.ts up --backend plain` runs the bridge's own shells instead: folders
become workspaces (add more from the phone), and agents started in them (Claude Code,
Codex, OpenCode, Pi, Gemini, Qwen and others) are recognised. Only the backend you choose runs.

A single-file binary works the same way:
`bun build src/cli.ts --compile --outfile herdr-remote`, then `./herdr-remote up`.

## More

- [`server/README.md`](server/README.md): security model, pairing (QR or nearby code),
  devices and revocation, limits, tests. It mentions Docker/WireGuard/Orca deployment
  guides that are not part of this repository yet.
- [`protocol/v1.md`](protocol/v1.md): the REST/WebSocket contract the apps use.

## Licence

Apache-2.0 (see `LICENSE`). Bundled third-party code keeps its own licence; see
`server/THIRD_PARTY_NOTICES.md` and `server/licenses/`. The mobile apps are
distributed separately.

## Releases

Every push to `main` that changes the bridge runs the tests and publishes a release with
ready-to-run kits for macOS (Apple silicon and Intel) and Linux (x86-64 and ARM64):
`.github/workflows/server.yml`, packaging in `server/scripts/package-release.sh`.
