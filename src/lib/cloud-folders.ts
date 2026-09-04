import path from "node:path";
import fs from "node:fs/promises";

/**
 * The synced folders on this computer, found rather than typed.
 *
 * The second copy of a backup is the one that survives the building, and the honest way to get one
 * on a pharmacy computer is a folder that syncs to the cloud on its own. OneDrive is already
 * installed and already signed in on every Windows machine in the country, which makes it the
 * shortest path from "one copy" to "two, one of them off the premises".
 *
 * Asking somebody to find and type C:\Users\wwfprx\OneDrive - Something\Backups is how this ends
 * up never being set. Windows puts the answer in an environment variable, so the site reads it and
 * offers the folder as a button.
 *
 * The distinction between a personal and a work OneDrive is kept because it is not cosmetic. These
 * archives contain the whole record — incidents, staff files, the lot — and Microsoft will sign a
 * business associate agreement for Microsoft 365 business and enterprise accounts but not for a
 * consumer one. That is a decision for the pharmacy, and it can only make it if the site says
 * which kind it found.
 */

export type CloudFolder = {
  label: string;
  /** The sync root itself, not the folder the backups go in. */
  path: string;
  kind: "business" | "personal" | "other";
  /** Whether a business associate agreement is available for this kind of account. */
  baaAvailable: boolean;
};

/** The folder inside a sync root that the archives are written to. */
export function backupFolderIn(root: string): string {
  return path.join(root, "PharmacyAdminBackups");
}

/**
 * Candidate sync roots, from the environment alone.
 *
 * Separated from the disk check so it can be tested without a OneDrive installation, and so the
 * order is explicit: a work account first, because it is the one that can be covered by an
 * agreement.
 */
export function cloudFoldersFromEnv(env: Record<string, string | undefined>): CloudFolder[] {
  const found: CloudFolder[] = [];
  const add = (p: string | undefined, label: string, kind: CloudFolder["kind"], baaAvailable: boolean) => {
    const v = (p ?? "").trim();
    if (!v) return;
    if (found.some((f) => path.resolve(f.path).toLowerCase() === path.resolve(v).toLowerCase())) return;
    found.push({ label, path: v, kind, baaAvailable });
  };

  add(env.OneDriveCommercial, "OneDrive — work or school account", "business", true);
  add(env.OneDriveConsumer, "OneDrive — personal account", "personal", false);
  /*
   * The bare OneDrive variable is whichever one Windows considers primary, so it is only useful
   * when it names a folder the two specific variables did not. Its kind is read off the folder
   * name: a work account's folder is "OneDrive - Contoso", a personal one is plain "OneDrive".
   */
  const primary = (env.OneDrive ?? "").trim();
  if (primary) {
    const business = / - /.test(path.basename(primary));
    add(primary, business ? "OneDrive — work or school account" : "OneDrive", business ? "business" : "personal", business);
  }

  const home = (env.USERPROFILE ?? env.HOME ?? "").trim();
  if (home) {
    add(path.join(home, "Dropbox"), "Dropbox", "other", false);
    add(path.join(home, "Google Drive"), "Google Drive", "other", false);
  }
  return found;
}

/** The candidates that actually exist on this machine. */
export async function detectCloudFolders(env: Record<string, string | undefined> = process.env): Promise<CloudFolder[]> {
  const out: CloudFolder[] = [];
  for (const c of cloudFoldersFromEnv(env)) {
    try {
      const st = await fs.stat(c.path);
      if (st.isDirectory()) out.push(c);
    } catch {
      // A variable pointing at a folder that is not there means the account was removed. Not an
      // error — just not an option.
    }
  }
  return out;
}

/** Whether a configured destination is already inside one of these. */
export function isInside(destination: string, folder: CloudFolder): boolean {
  if (!destination.trim()) return false;
  const d = path.resolve(destination).toLowerCase();
  const r = path.resolve(folder.path).toLowerCase();
  return d === r || d.startsWith(r + path.sep);
}
