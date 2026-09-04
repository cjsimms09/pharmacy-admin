import "server-only";
import { like } from "drizzle-orm";
import { db, schema } from "@/db";
import { getSettings } from "./settings";

/**
 * What Claude has actually cost, and what the next press will.
 *
 * The question was "how much is this button push going to cost me in API?", and a pharmacist
 * ought to be able to answer that without asking anybody. Every model call this system makes
 * already writes its token counts into the audit log — it has from the beginning — so the numbers
 * exist. They were simply never added up and shown.
 *
 * Estimates are given in tokens first and money second, because the tokens are a fact about this
 * system and the money is a fact about a price list that changes. The rate is a setting with a
 * sensible default rather than a constant compiled in, so a price change is a number somebody
 * types rather than a new version of the software.
 */

/** How the tokens are recorded, by every call, in the audit details. */
const TOKENS = /tokens in=(\d+) out=(\d+)/;

/**
 * Default rates, in dollars per million tokens.
 *
 * The Opus-class figures, because that is what the site is set to out of the box. They are a
 * starting point and are meant to be corrected in settings — nothing here should be read as a
 * quotation.
 */
export const DEFAULT_RATE_IN = 15;
export const DEFAULT_RATE_OUT = 75;

export type Rates = { in: number; out: number; model: string };

export async function rates(): Promise<Rates> {
  const s = await getSettings();
  const n = (v: string | undefined, fallback: number) => {
    const x = Number((v ?? "").trim());
    return Number.isFinite(x) && x >= 0 ? x : fallback;
  };
  return {
    in: n(s.ai_price_in, DEFAULT_RATE_IN),
    out: n(s.ai_price_out, DEFAULT_RATE_OUT),
    model: s.ai_model || "claude-opus-5",
  };
}

export function costOf(tokensIn: number, tokensOut: number, r: Rates): number {
  return (tokensIn * r.in) / 1_000_000 + (tokensOut * r.out) / 1_000_000;
}

export const dollars = (n: number): string =>
  n === 0 ? "$0.00" : n < 0.01 ? "under a cent" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export type Spend = {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  /** Broken down, because "what is this spending money on" is the next question. */
  byAction: { action: string; calls: number; tokensIn: number; tokensOut: number; cost: number }[];
  since: string | null;
};

/**
 * What has been spent, from the log the site already keeps.
 *
 * Counted from the audit events rather than from a separate tally, so it cannot drift from what
 * actually happened and there is nothing extra to keep in step. A call whose tokens were never
 * recorded — an older row, or one that failed before the response came back — counts as a call
 * with no tokens rather than being dropped, so the call count stays honest.
 */
export async function spend(days = 90): Promise<Spend> {
  const rows = await db.query.auditEvents.findMany({ where: like(schema.auditEvents.action, "ai.%") });
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const mine = rows.filter((r) => (r.at ?? "") >= cutoff);
  const r = await rates();

  const by = new Map<string, { calls: number; tokensIn: number; tokensOut: number }>();
  let tokensIn = 0;
  let tokensOut = 0;

  for (const row of mine) {
    const m = TOKENS.exec(row.details ?? "");
    const i = m ? Number(m[1]) : 0;
    const o = m ? Number(m[2]) : 0;
    tokensIn += i;
    tokensOut += o;
    const cur = by.get(row.action) ?? { calls: 0, tokensIn: 0, tokensOut: 0 };
    by.set(row.action, { calls: cur.calls + 1, tokensIn: cur.tokensIn + i, tokensOut: cur.tokensOut + o });
  }

  return {
    calls: mine.length,
    tokensIn,
    tokensOut,
    cost: costOf(tokensIn, tokensOut, r),
    byAction: [...by.entries()]
      .map(([action, v]) => ({ action, ...v, cost: costOf(v.tokensIn, v.tokensOut, r) }))
      .sort((a, b) => b.cost - a.cost),
    since: mine.map((x) => x.at).sort()[0] ?? null,
  };
}

/**
 * What one section costs to read against the requirements.
 *
 * Measured rather than guessed. The prompt is a fixed instruction of about 430 tokens, a summary
 * of what this system does of about 970, the pharmacy's description, and the section itself.
 * The reply is a verdict and any findings — short where a section is adequate, longer where it
 * comes with replacement text.
 *
 * Deliberately the upper end of typical. An estimate that turns out low is worse than useless on
 * a question about money.
 */
export const AUDIT_TOKENS = { in: 1_800, out: 450 };
/** Writing a policy from an empty heading. The same prompt, and a longer answer. */
export const DRAFT_TOKENS = { in: 1_700, out: 750 };

export type Estimate = { audits: number; drafts: number; tokensIn: number; tokensOut: number; cost: number };

export async function estimate(audits: number, drafts: number): Promise<Estimate> {
  const r = await rates();
  const tokensIn = audits * AUDIT_TOKENS.in + drafts * DRAFT_TOKENS.in;
  const tokensOut = audits * AUDIT_TOKENS.out + drafts * DRAFT_TOKENS.out;
  return { audits, drafts, tokensIn, tokensOut, cost: costOf(tokensIn, tokensOut, r) };
}

/**
 * The sentence that goes next to the button.
 *
 * Says what it will do, what it will cost, and — the part that stops the figure being alarming —
 * that it is a once-a-year job rather than a monthly one. A section is read against the rules
 * annually; once the manual is current, pressing this again costs nothing because there is
 * nothing due.
 */
export async function estimateSentence(audits: number, drafts: number): Promise<string> {
  if (audits === 0 && drafts === 0) return "Nothing is due to be read or written, so this costs nothing.";
  const e = await estimate(audits, drafts);
  const bits = [
    audits ? `${audits} section${audits === 1 ? "" : "s"} to read against the rules` : "",
    drafts ? `${drafts} to write` : "",
  ].filter(Boolean);
  return `${bits.join(" and ")} — about ${dollars(e.cost)} of API use in total, spread over as many presses as it takes. Each section is read once a year, so this is an annual cost, not a monthly one.`;
}
