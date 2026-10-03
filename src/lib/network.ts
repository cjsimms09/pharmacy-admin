import "server-only";
import os from "node:os";

export type LanAddress = { address: string; label: string; url: string };

/**
 * Addresses other computers on the pharmacy's own network can use to reach this app.
 * Only private (RFC1918) IPv4 addresses are offered — never a public address.
 */
export function lanAddresses(port = process.env.PORT ?? "3000"): LanAddress[] {
  const out: LanAddress[] = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (!isPrivate(a.address)) continue;
      out.push({ address: a.address, label: name, url: `http://${a.address}:${port}` });
    }
  }
  // Wi-Fi/Ethernet adapters first, virtual adapters (VirtualBox, WSL, Hyper-V) last.
  const virtual = /virtual|vmware|vbox|hyper-v|wsl|docker|loopback/i;
  return out.sort((x, y) => Number(virtual.test(x.label)) - Number(virtual.test(y.label)));
}

function isPrivate(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}
