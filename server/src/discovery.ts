import { spawn, type ChildProcess } from "node:child_process";
import { networkInterfaces, hostname } from "node:os";

/** Bonjour service type the iOS app browses for. */
export const SERVICE_TYPE = "_agentremote._tcp";

export interface Advertisement { url: string; hostId: string; certificateSHA256: string; name: string; port: number; pairing: boolean; }

function which(command: string): string | null { return Bun.which(command); }

/**
 * Advertise this bridge on the local network with the system mDNS responder
 * (avahi on Linux, dns-sd on macOS). The record is a hint only: the app still
 * pins the advertised certificate and needs a code shown on this computer to pair.
 */
export function advertise(ad: Advertisement, log: (message: string) => void = () => {}): { close(): void } {
  const txt = [`v=1`, `id=${ad.hostId}`, `pin=${ad.certificateSHA256}`, `url=${ad.url}`, `pair=${ad.pairing ? "code" : "off"}`];
  const name = ad.name.replace(/[^\p{L}\p{N} ._'-]/gu, "").slice(0, 60) || "AI Agent Remote";
  const avahi = which("avahi-publish"), dnssd = which("dns-sd");
  const command = avahi ? [avahi, "-s", name, SERVICE_TYPE, String(ad.port), ...txt]
    : dnssd ? [dnssd, "-R", name, SERVICE_TYPE, "local", String(ad.port), ...txt] : null;
  if (!command) { log("Local network discovery is unavailable: install avahi-utils (Linux) or use macOS dns-sd."); return { close() {} }; }
  let child: ChildProcess | undefined, closed = false, timer: ReturnType<typeof setTimeout> | undefined, failures = 0;
  const start = () => {
    if (closed) return;
    const started = Date.now();
    child = spawn(command[0]!, command.slice(1), { stdio: ["ignore", "ignore", "ignore"] });
    child.once("error", () => {});
    child.once("exit", () => {
      if (closed) return;
      failures = Date.now() - started > 60_000 ? 0 : failures + 1;
      if (failures === 3) log("Local network discovery keeps stopping. Check that the avahi daemon (Linux) or mDNSResponder is running.");
      timer = setTimeout(start, Math.min(60_000, 2000 * 2 ** Math.min(failures, 5)));
    });
  };
  start();
  return { close() { closed = true; if (timer) clearTimeout(timer); child?.kill("SIGTERM"); } };
}

/** Name this computer answers to over mDNS, e.g. "studio.local". */
export function localHostname(): string {
  // macOS answers mDNS as its LocalHostName, which can differ from the BSD hostname.
  let name = hostname();
  if (process.platform === "darwin") { try { const out = Bun.spawnSync(["scutil", "--get", "LocalHostName"]).stdout.toString().trim(); if (out) name = out; } catch {} }
  const base = name.split(".")[0]!.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "computer";
  return `${base}.local`;
}

const privateIPv4 = (address: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(address);
/** Private LAN/VPN IPv4 addresses, for certificate SANs. Container bridges are skipped. */
export function lanAddresses(): string[] {
  const result: string[] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (/^(docker|br-|veth|virbr|lo)/.test(name)) continue;
    for (const entry of entries ?? []) if (entry.family === "IPv4" && !entry.internal && privateIPv4(entry.address)) result.push(entry.address);
  }
  return [...new Set(result)];
}
