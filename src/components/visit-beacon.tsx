"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Counts a visit to an old page, so stage 5 of the rebuild can know which pages a month has not needed. One small
 * request per page view, with the cookie the page already has; nothing else leaves the browser. Only mounted in the
 * old layout: the new screens are not up for retirement.
 */
export function VisitBeacon() {
  const pathname = usePathname();
  useEffect(() => {
    if (!pathname) return;
    try {
      const body = JSON.stringify({ path: pathname });
      if (!navigator.sendBeacon?.("/api/visit", new Blob([body], { type: "application/json" }))) {
        void fetch("/api/visit", { method: "POST", body, headers: { "Content-Type": "application/json" }, keepalive: true }).catch(() => undefined);
      }
    } catch {
      /* a count that fails to land is not worth a broken page */
    }
  }, [pathname]);
  return null;
}
