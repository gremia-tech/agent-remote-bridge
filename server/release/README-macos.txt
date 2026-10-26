AI Agent Remote bridge for macOS
==============================

This small program runs on the Mac where you use Herdr. It lets the AI Agent Remote
iPhone app (TestFlight) see your Herdr workspaces, watch agents and type to them.
Everything stays on your local network: the phone talks straight to your Mac.

You need: Herdr installed and running (or use plain terminals, below), the iPhone app from the TestFlight invite,
and the phone on the same Wi-Fi as the Mac.

1. Put this folder somewhere permanent, e.g. ~/agent-remote, then in Terminal:

     cd ~/agent-remote
     xattr -dr com.apple.quarantine .      # macOS blocks downloaded programs otherwise
     ./herdr-remote up

   Easiest is to run it in a Herdr tab, so it finds the herdr command and keeps running.
   If it can't find Herdr, add  --herdr "$(which herdr)"  (or the full path).

No Herdr? Start it with plain terminals instead:

     ./herdr-remote up --backend plain

   The bridge then runs its own shells (your login shell, as you). It opens one in your
   home folder; add more folders from the phone with "New workspace". Agents you start in
   them (Claude Code, Codex, OpenCode, Gemini and others installed on this Mac) show up
   as agents. Terminals end when the bridge stops; the folders are remembered. The first
   start remembers the choice, so later a plain ./herdr-remote up is enough.

2. Click Allow if macOS asks about incoming connections or devices on your local network.
   The first start creates its private state in ~/.local/share/herdr-remote.

3. On the iPhone, open AI Agent Remote and allow Local Network access. Your Mac shows up
   under "On this network". Tap it, then "Show code on computer": a 6-digit code pops up
   on the Mac (notification and in the terminal). Type it on the phone and check the
   fingerprint matches on both screens. Done; next time it reconnects by itself.

Keep it running while you want to use the phone (and keep the Mac awake). Ctrl+C stops it.

Useful:
  ./herdr-remote devices                 list paired phones
  ./herdr-remote revoke --device UUID    unpair one
  ./herdr-remote up --no-discovery       serve already-paired phones without advertising

Security: anyone on your Wi-Fi can see the Mac advertised, but pairing needs the code that
only appears on your Mac (it expires after 2 minutes / 5 wrong tries). A paired phone in
control mode can type into your terminals like you can, so only pair your own devices.

Licences: the bridge is Apache-2.0 (LICENSE). THIRD_PARTY_NOTICES.md and
BUN-RUNTIME-LICENSE.md cover the bundled libraries and the embedded Bun runtime.
