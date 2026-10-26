AI Agent Remote bridge for Linux
================================

This small program runs on the computer where you use Herdr. It lets the AI Agent Remote
phone app see your Herdr workspaces, watch agents and type to them. Everything stays on
your local network: the phone talks straight to your computer.

You need: Herdr installed and running (or use plain terminals, below), openssl, avahi-utils (avahi-publish) for the phone
to find the computer, the phone app, and the phone on the same Wi-Fi.

1. Put this folder somewhere permanent, e.g. ~/agent-remote, then:

     cd ~/agent-remote
     ./herdr-remote up

   Easiest is to run it in a Herdr tab, so it finds the herdr command and keeps running.
   If it can't find Herdr, add  --herdr "$(which herdr)"  (or the full path).
   Allow TCP port 8443 from your LAN if a firewall is active.

No Herdr? Start it with plain terminals instead:

     ./herdr-remote up --backend plain

   The bridge then runs its own shells (your login shell, as you). It opens one in your
   home folder; add more folders from the phone with "New workspace". Agents you start in
   them (Claude Code, Codex, OpenCode, Gemini and others installed on this computer) show up
   as agents. Terminals end when the bridge stops; the folders are remembered. The first
   start remembers the choice, so later a plain ./herdr-remote up is enough.

2. The first start creates its private state in ~/.local/share/herdr-remote.

3. In the app, your computer shows up under "On this network". Tap it, then
   "Show code on computer": a 6-digit code pops up here (notification and terminal).
   Type it on the phone and check the fingerprint matches on both screens.

To keep it running in the background, see herdr-remote.service in this folder:
  mkdir -p ~/.config/systemd/user && cp herdr-remote.service ~/.config/systemd/user/
  (edit ExecStart to this folder) then: systemctl --user enable --now herdr-remote

Useful:
  ./herdr-remote devices                 list paired phones
  ./herdr-remote revoke --device UUID    unpair one
  ./herdr-remote up --no-discovery       serve already-paired phones without advertising

Security: anyone on your Wi-Fi can see the computer advertised, but pairing needs the code
that only appears here (it expires after 2 minutes / 5 wrong tries). A paired phone in
control mode can type into your terminals like you can, so only pair your own devices.

Licences: the bridge is Apache-2.0 (LICENSE). THIRD_PARTY_NOTICES.md and
BUN-RUNTIME-LICENSE.md cover the bundled libraries and the embedded Bun runtime.
