import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Pharmacy Admin", template: "%s · Pharmacy Admin" },
  description: "Private pharmacy operations desk",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
