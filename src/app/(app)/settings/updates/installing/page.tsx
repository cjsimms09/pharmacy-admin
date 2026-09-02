import { InstallingWatcher } from "../watcher";

export const metadata = { title: "Installing update" };
export const dynamic = "force-dynamic";

/** Shown while the launcher pulls, rebuilds and restarts. The watcher polls until the app is back. */
export default function InstallingPage() {
  return <InstallingWatcher />;
}
