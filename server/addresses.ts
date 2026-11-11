// Where the deck can be reached, sorted by who can get there. The LAN is the
// tablet on the desk. Tailscale is the phone anywhere: every device signed in
// to your tailnet gets an address in 100.64.0.0/10, the traffic is WireGuard
// between them, and nothing else can route to this PC. Both paths go through
// the same paired token on every call.

import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

export interface Addresses {
  lan: string[];
  tailscale: string[];
}

const LAN = /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./;
/** 100.64.0.0/10: a second octet from 64 to 127. */
const TAILSCALE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

/** Pure, so it can be tested without a network. Link-local (169.254) and
 *  public addresses are left out: nobody should be told to open those. */
export function classify(ips: string[]): Addresses {
  const out: Addresses = { lan: [], tailscale: [] };
  for (const ip of ips) {
    if (TAILSCALE.test(ip)) out.tailscale.push(ip);
    else if (LAN.test(ip)) out.lan.push(ip);
  }
  // The home router hands out 192.168.x; 172.x here is usually a Hyper-V or
  // WSL switch, which nothing can reach. Say the real one first.
  out.lan.sort((a, b) => rank(a) - rank(b));
  return out;
}

const rank = (ip: string): number => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);

export function addresses(): Addresses {
  const ips: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
  }
  return classify(ips);
}

/** The https address Tailscale Serve answers on, when it is set up in front
 *  of the bridge (`tailscale serve --bg --https=443 http://127.0.0.1:4771`):
 *  https://<this pc>.<tailnet>.ts.net. Null without Tailscale or without a
 *  serve config. Asks the CLI, so a few hundred milliseconds. */
export function tailscaleHttps(): string | null {
  // The Windows installer puts tailscale.exe under Program Files and does not
  // add it to PATH, so the bare name only works where you added it yourself.
  const bins = ['tailscale', join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')];
  for (const bin of bins) {
    try {
      const out = execFileSync(bin, ['serve', 'status'], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      return serveHttps(out);
    } catch {
      /* not this path, or no Tailscale */
    }
  }
  return null;
}

/** The https address in `tailscale serve status` output. Null for "No serve
 *  config" and for "Serve is not enabled on your tailnet", whose enable link
 *  is on login.tailscale.com, not a ts.net name. Pure, for the test. */
export function serveHttps(out: string): string | null {
  const m = /https:\/\/[\w.-]+\.ts\.net\b/.exec(out);
  return m ? m[0] : null;
}
