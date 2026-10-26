# Private connection invitations

Core REST/WebSocket API remains protocol version1. Direct one-use invitations remain version1. An invitation with private routing uses version2, with the same URL/pin/code/expiry fields plus a `connection` object; clients unaware of v2 must reject it.

`connection.mode=gateway` requires `gateway.url` (root WSS host path `/v1/tunnel`) and a random32–512byte printable-ASCII `gateway.token`. Optional fields: `certificateSHA256` for an explicitly pinned local outer gateway; complete `basicUsername`/`basicPassword` and/or `accessClientID`/`accessClientSecret` pairs. URL credentials/query/fragment, unknown route kinds, mixed route data, invalid pins and HTTP control bytes are rejected. Public proxy authentication applies only to the outer WSS handshake; the inner host's token is never used as a proxy credential.

`connection.mode=wireguard` requires `wireGuardJSON`, the compact JSON accepted by `app-tunnel.Start`. Runner IP/port must exactly match the invitation's HTTPS endpoint. The runtime pins the server WG peer, restricts the tunnel peer route to that one IP, and restricts CONNECT to that one IP/port. Standard single-peer WireGuard files can be imported into this constrained form; broad AllowedIPs narrow to the chosen runner, DNS/ListenPort are not applied, and script hooks/multi-peer/duplicate fields fail closed.

The app verifies and displays the endpoint/route before pairing. Private transport settings and the resulting device credential live only in ThisDeviceOnly Keychain. They must not enter preferences, analytics, URLs used for HTTP requests, logs, shared screenshots or source control. The pairing QR itself carries credentials and must be treated as a short-lived secret.

Every app-created CONNECT listener binds only127.0.0.1 on an ephemeral port, requires fresh random proxy Basic credentials and accepts only the configured authority. The proxy configuration belongs to the app's private URLSession and forbids direct failover. No system VPN profile, route or DNS changes occur. Both REST and inner live WSS use this same route and independently pinned host TLS.

Gateway upgrade request: `GET /v1/tunnel`, WebSocket subprotocol `ai-agent-remote.tunnel.v1`, private token in `X-AI-Remote-Gateway-Token`. The gateway authenticates before admitting a fixed-upstream binary byte stream. It does not parse shell commands or decrypted host HTTP. It closes both directions on error/buffer overflow, never retries bytes, never trusts identity-forwarding headers, and never accepts a client-selected upstream.

Background/disconnect cancels pending enrollment and route creation, clears control locally and closes private routes. Explicit control release receives at most400ms grace before route teardown; an uncertain release remains subject to the host lease expiry. Foreground resume rebuilds observation but never reacquires control or replays uncertain mutations.
