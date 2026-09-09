import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value:
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; object-src 'self'; frame-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  },
];

/*
 * The address the site is answering on when it has been deliberately opened to the outside.
 *
 * Read from the environment rather than the record on disk because the launcher knows the tunnel's
 * address before this process starts, and a config file is read once at boot. Empty in every
 * ordinary run, which is the point: nothing about the private case changes.
 */
const publicOrigin = process.env.PUBLIC_ORIGIN ?? "";
const publicHosts = (() => {
  if (!publicOrigin) return [] as string[];
  try {
    const u = new URL(publicOrigin);
    return u.port ? [u.host, u.hostname] : [u.host];
  } catch {
    return [] as string[];
  }
})();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  /*
   * The pharmacy computer compiles the code; it does not check it.
   *
   * Type checking and linting are the largest part of a Next build's peak memory, and the machine
   * this rebuilds on has the dispensing system, the label printer software and a browser open while
   * it runs. Its build died — "build worker exited with code 3221225786", a Windows kill rather than
   * a compile error — and a half-written .next left the pharmacy with no site at all.
   *
   * Nothing is skipped, only moved. `npm run check` runs the typechecker and the whole suite before
   * anything is pushed, and a type error must never be discovered for the first time on the machine
   * people are trying to dispense from: there, the only useful question is whether the code that is
   * already known to be correct will compile.
   */
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  /*
   * ssh2 and mssql are loaded from node_modules at run time rather than bundled: ssh2 probes for
   * its native crypto and cpu-features modules with paths a bundle cannot resolve (the build warned,
   * and the app spun at full CPU ten seconds after starting on the first build that bundled it),
   * and tedious carries the same kind of optional native pieces.
   */
  serverExternalPackages: ["@libsql/client", "imapflow", "mailparser", "ssh2", "ssh2-sftp-client", "mssql", "tedious"],
  experimental: {
    /*
     * Server actions are refused when the browser's Origin does not match the host the app thinks
     * it is serving, and a tunnel makes those two different things: the browser says the tunnel's
     * address, the app behind it sees localhost. Without naming the tunnel here every page renders
     * perfectly and every button does nothing at all — the exact shape of fault that has already
     * cost this pharmacy two days, so it is settled rather than discovered.
     *
     * Only ever the one address currently being tunnelled to, and only while it is. Nothing is
     * broadened for the ordinary case.
     */
    serverActions: { bodySizeLimit: "25mb", ...(publicHosts.length ? { allowedOrigins: publicHosts } : {}) },
    /*
     * Build in this process rather than in a worker of its own.
     *
     * The pharmacy computer's update failed with "Next.js build worker exited with code
     * 3221225786" — 0xC000013A, a Windows process killed rather than a compile error. A separate
     * build worker doubles the memory the build needs at its peak, and that machine has the
     * dispensing system, the label printer software and a browser open while this runs.
     *
     * The build takes somewhat longer in one process. An update that finishes slowly is a working
     * update; one that dies at ninety per cent leaves the pharmacy on last week's code and every
     * fix since sitting on GitHub, which is what happened.
     */
    webpackBuildWorker: false,
  },

  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
