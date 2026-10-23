"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-fetches the page while Claude is drafting in the background, so the result just appears. */
export function AutoRefresh({ seconds = 8 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}
