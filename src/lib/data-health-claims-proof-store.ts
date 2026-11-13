import "server-only";
import { getSettings, SETTING_KEYS } from "./settings";
import { parseClaimsProof, type ClaimsProof } from "./data-health-claims-proof";

/**
 * The claims proof as the nightly script left it.
 *
 * A settings read and nothing else. `scripts/prove-claims.ts` re-reads every stored daily report
 * and sets it against the claims table, in a process of its own, because that is minutes of libsql
 * calls and every one of them blocks the thread the site answers on. What it leaves behind is a few
 * hundred bytes of JSON, and this is the whole cost of showing it.
 *
 * Null where it has never run, or where the site cannot see it — the two are told apart by
 * `claimsProofUnreadable` below, because they need different people to do different things.
 */
export async function claimsProofNow(): Promise<ClaimsProof | null> {
  if (claimsProofUnreadable()) return null;
  const s = await getSettings();
  return parseClaimsProof((s as Record<string, string | undefined>).claims_proof);
}

/**
 * True where the site structurally cannot read the proof, however faithfully it runs.
 *
 * `getSettings` builds its answer from `SETTING_KEYS` and drops every key not on it, so a proof
 * written to an unregistered key reads as the empty string here — for ever, quietly, and looking
 * exactly like a proof that has never run. One of those wants somebody to start the script; the
 * other wants one line added to `settings.ts`. A screen that cannot tell them apart sends the
 * wrong person to look at the wrong thing.
 */
export function claimsProofUnreadable(): boolean {
  return !(SETTING_KEYS as readonly string[]).includes("claims_proof");
}
