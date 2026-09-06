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

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ["@libsql/client", "imapflow", "mailparser"],
  experimental: {
    serverActions: { bodySizeLimit: "25mb" },
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
