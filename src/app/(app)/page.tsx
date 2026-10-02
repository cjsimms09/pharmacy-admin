import { redirect } from "next/navigation";

/**
 * The front door is Today. The old dashboard lives at /dashboard, behind "More" on the new screens, until each of
 * its jobs is on a new screen (docs/REBUILD.md, stage 5). The owner, 2 October 2026, having opened the site after
 * four stages had shipped: "The site looks the same.. have we made any changes?" — because this address still
 * opened the old page.
 */
export default function Home() {
  redirect("/v2/today");
}
