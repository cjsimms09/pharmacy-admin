import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { retiredArea, KEPT } from "@/lib/retired";

export const dynamic = "force-dynamic";
export const metadata = { title: "Retired" };

/** One sentence where a retired page was, and the way back. Nothing is deleted: the data behind it is kept. */
export default async function RetiredPage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  await requireUser();
  const { from } = await searchParams;
  const area = from ? retiredArea(from) : null;
  return (
    <div className="mx-auto max-w-xl py-10">
      <h1>This page was retired on 2 October 2026</h1>
      <p className="mt-2 text-sm text-ink-2">
        {area ? `It was part of ${area}.` : "It is not part of what the site is for."} The site now does six things: {KEPT.join("; ")}. Its data is kept.
      </p>
      <p className="mt-4">
        <Link href="/" className="btn btn-primary">
          Back to Today
        </Link>
      </p>
    </div>
  );
}
