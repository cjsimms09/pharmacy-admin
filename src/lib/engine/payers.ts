/**
 * One name per payer, for grouping.
 *
 * The claims file names a PBM three ways for one company — "Prime Therapeutics LLC", "Prime Therapeutics", "Prime" —
 * and the aged receivables, the cycles and the Claims screen all group by that name, so the three spellings have to
 * meet. Two rules, in order: the owner's own merges, written as `payer_alias` rules (engine/rules.ts: key = the
 * name as the data spells it, value.canonical = the name to show), and then a short list of spelling families
 * measured on 1 October 2026. Nothing else is folded: "SS&C HEALTH" on an 835 is a processor paying for Humana and
 * for the Argus bridge, not the Wegovy programme that carries "SS&C Health" in its own name, and the two must never
 * meet. A name that is empty, or that is only a BIN and a group, is "Unnamed payer", so it can be seen and named.
 */
import { rules } from "./rules";

const FAMILIES: [RegExp, string][] = [
  [/^PRIME( THERAPEUTICS)?( LLC)?$/, "Prime Therapeutics"],
  [/^CAPITAL ?RX\b/, "Capital Rx"],
  [/^EXPRESS SCRIPTS\b/, "Express Scripts"],
  [/^NAVITUS\b/, "Navitus"],
  [/^MEDONE\b/, "MedOne"],
  [/^LIVINITI\b/, "Liviniti"],
  [/^ELIXIR\b/, "Elixir"],
];

export const UNNAMED = "Unnamed payer";

/** Upper case, "&" kept, every other mark a space, one space between words. */
export function fold(name: string | null | undefined): string {
  return (name ?? "")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}&]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/** Pure: the name to group under, given the alias rules already loaded. */
export function canonicalPayer(name: string | null | undefined, aliases: Map<string, string> = new Map()): string {
  const raw = (name ?? "").trim();
  const f = fold(raw);
  if (!f || /^\d{6}\b/.test(f)) return UNNAMED;
  const alias = aliases.get(f);
  if (alias) return alias;
  for (const [re, to] of FAMILIES) if (re.test(f)) return aliases.get(fold(to)) ?? to;
  return raw;
}

/** The alias rules as a map from folded name to canonical name. */
export async function payerAliases(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const r of await rules("payer_alias")) {
    const to = typeof r.value.canonical === "string" ? r.value.canonical.trim() : "";
    if (to) out.set(fold(r.key), to);
  }
  return out;
}

/** A canonicaliser with the rules loaded once. */
export async function payerNamer(): Promise<(name: string | null | undefined) => string> {
  const aliases = await payerAliases();
  return (name) => canonicalPayer(name, aliases);
}
