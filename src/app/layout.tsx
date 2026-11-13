import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/**
 * The typefaces the stylesheet has been asking for since it was written.
 *
 * `globals.css` names Inter first in `--font-sans` and JetBrains Mono in `--font-mono`, and sets
 * `font-feature-settings: "cv11", "ss01"` — both of which are Inter's own character variants. None
 * of it was ever loaded: no `next/font`, no `@font-face`, no stylesheet link anywhere. So every one
 * of the 121 pages has been rendering in Segoe UI with two Inter-only features switched on and
 * doing nothing, and the owner's verdict was "It looks very amateur."
 *
 * He is right, and typography is most of it. A considered palette and a real type scale still look
 * like a Windows dialogue box when they are set in the Windows dialogue box font.
 *
 * Self-hosted at build time rather than fetched from Google at run time, which is what `next/font`
 * does: the files are emitted into the build and served from this machine, so the pharmacy is not
 * making a request to a third party on every page load — and nothing on a screen depends on the
 * network reaching fonts.gstatic.com. `display: "swap"` so text paints in the fallback immediately
 * rather than leaving a blank page if a face is slow.
 *
 * The variables are the ones the stylesheet already reads, so no page or component changes.
 */
const sans = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
  /* The weights the stylesheet actually uses: body, medium, semibold, bold. */
  weight: ["400", "500", "600", "700"],
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: { default: "Pharmacy Admin", template: "%s · Pharmacy Admin" },
  description: "Private pharmacy operations desk",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
