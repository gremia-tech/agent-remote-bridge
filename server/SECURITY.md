# Security model

The bridge gives a paired phone the same power over your terminals as you have at your keyboard, so it is built to let only the phones you pair in, and to keep everything in between unable to read or change what flows. This note says how, and what remains. It describes our own review, not an independent audit.

## What protects a connection

- **End-to-end TLS pinned to this computer.** The bridge creates its own certificate. A phone learns its exact SHA-256 fingerprint from the QR code you scan (or the code shown on this computer for nearby pairing) and accepts no other certificate: no certificate authority, no "trust anyway". The phones require TLS 1.3.
- **Per-device credentials.** Pairing issues each phone a random 256-bit token; the bridge stores only its hash. A device is read-only or may control terminals, and `herdr-remote revoke` (or the console) cuts it off at once, including live sessions.
- **Explicit control.** Typing needs a control lease for that pane, checked against the program currently running in it, and keystrokes are never replayed after a dropped connection.
- **Relays carry ciphertext only.** Through a relay, the phone's TLS still ends at this computer. The relay, a proxy or a CDN in front of it can see when you connect and how much data flows, and can drop connections; it cannot read terminals or type into them. Each phone gets its own relay credential, and a revoked phone is also refused at the relay when it runs with `--personal-only`. Relayed connections are never treated as this computer's local network.
- **Certificate renewal keeps pairings.** Thirty days before the certificate expires, the bridge creates a successor and signs its fingerprint with the current key. Phones that connect before the switch verify that statement and move over; others pair again.
- **Local console.** The web console listens on 127.0.0.1 only, admits a browser through a one-time link that only your user account can mint, and checks Host, Origin and a CSRF token on every change.

## Trust boundary

The bridge runs as your user, and anyone who controls your account controls it, as with SSH. A phone with control access is equivalent to a shell as you. Keep phones locked and revoke lost ones.

## Known limits

- Device tokens are bearer secrets sent inside the pinned TLS on each request; device-bound keys that never leave the phone's secure hardware are planned.
- Bridges still accept TLS 1.2 from older app versions.
- The relay's shared phone token stays valid unless the relay runs with `--personal-only` (older pairings and the Android app use it).
- A reverse proxy on the same machine makes remote connections look local; leave discovery off in that setup.

Report problems privately to the maintainers rather than in a public issue.
