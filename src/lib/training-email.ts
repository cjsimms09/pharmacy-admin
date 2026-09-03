import "server-only";
import { TRAINING_LABEL } from "./labels";
import { fmt } from "./dates";
import { REPLY_PHRASE } from "./training-replies";
import type { TrainingType } from "@/db/schema";

/**
 * The email staff actually receive.
 *
 * Written as HTML with a plain-text twin, because the two do different jobs and neither is
 * optional. The HTML is what makes it look like it came from an employer rather than from a
 * script — and an email that looks like a script is one people assume is phishing and delete,
 * which is a compliance failure caused entirely by presentation. The plain text is what a phone's
 * notification preview shows and what survives a client that strips markup.
 *
 * Deliberately conservative markup: tables, inline styles, no external images, no web fonts.
 * Outlook, Gmail's clipping and every corporate filter between here and the recipient all
 * disagree about modern CSS, and a layout that collapses on one of them is worse than a plain
 * one that holds everywhere.
 *
 * Nothing in it is a trick. No urgency banners, no read receipts, no images that phone home. It
 * says what is required, why, how long it takes and what happens next — a pharmacy asking its own
 * staff to do something, in the tone of a pharmacy asking its own staff to do something.
 */

export type EmailItem = {
  type: TrainingType;
  title: string;
  minutes: number | null;
  dueOn: string;
  url: string;
  replyCode: string | null;
};

export type EmailContext = {
  firstName: string;
  pharmacy: string;
  address: string | null;
  phone: string | null;
  picName: string | null;
  items: EmailItem[];
  today: string;
  reminder: boolean;
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const INK = "#1b2a2a";
const INK2 = "#4b5b5a";
const INK3 = "#74837f";
const LINE = "#d8dfdb";
const ACCENT = "#0e6b5a";
const GROUND = "#f5f7f6";
const CRIT = "#a5312a";

export function subjectFor(ctx: EmailContext): string {
  const soonest = ctx.items.map((i) => i.dueOn).sort()[0];
  const late = soonest < ctx.today;
  const prefix = ctx.reminder ? (late ? "Overdue: " : "Reminder: ") : "";
  if (ctx.items.length === 1) {
    const i = ctx.items[0];
    return `${prefix}${TRAINING_LABEL[i.type]} — due ${fmt(i.dueOn)}${i.replyCode ? ` [${i.replyCode}]` : ""}`;
  }
  return `${prefix}${ctx.items.length} required trainings — first due ${fmt(soonest)}`;
}

/** The opening line, shared by both versions so they cannot drift apart. */
function opener(ctx: EmailContext): string {
  const soonest = ctx.items.map((i) => i.dueOn).sort()[0];
  const late = soonest < ctx.today;
  if (ctx.items.length === 1) {
    const i = ctx.items[0];
    return late
      ? `Your ${TRAINING_LABEL[i.type].toLowerCase()} was due on ${fmt(i.dueOn)} and is still outstanding.`
      : `Your ${TRAINING_LABEL[i.type].toLowerCase()} is due by ${fmt(i.dueOn)}.`;
  }
  return late
    ? `You have ${ctx.items.length} required trainings outstanding. The oldest was due on ${fmt(soonest)}.`
    : `You have ${ctx.items.length} required trainings to complete. The first is due by ${fmt(soonest)}.`;
}

export function textFor(ctx: EmailContext): string {
  const withCodes = ctx.items.filter((i) => i.replyCode);
  const lines: string[] = [
    `${ctx.firstName},`,
    "",
    opener(ctx),
    "",
    "Each one is a short read and a few questions. It works on your phone and you do not",
    "need a password.",
    "",
  ];

  ctx.items.forEach((i, n) => {
    lines.push(
      `${n + 1}. ${TRAINING_LABEL[i.type]}`,
      `   Due ${fmt(i.dueOn)}${i.minutes ? ` · about ${i.minutes} minutes` : ""}${i.dueOn < ctx.today ? " · OVERDUE" : ""}`,
      `   ${i.url}`,
    );
    if (i.replyCode) lines.push(`   Code: ${i.replyCode}`);
    lines.push("");
  });

  if (withCodes.length > 0) {
    lines.push(
      "PREFER TO REPLY?",
      "",
      "Reply to this email from this address with the words",
      "",
      `    ${REPLY_PHRASE}`,
      "",
      withCodes.length === 1
        ? "and the code above. Your reply is kept as your attestation."
        : "and the code of each one you have finished. Leaving this email quoted below is enough —",
      ...(withCodes.length === 1 ? [] : ["all the codes come with it. Your reply is kept as your attestation."]),
      "",
      "The links are the better record: they capture your signature and show you answered the",
      "questions. A reply records that you told us you did it. Both count.",
      "",
    );
  }

  lines.push(
    "The material for each one is attached to this email. It is the same content as the page,",
    "so you can read it there if you prefer. Keep it if you like — we hold a copy.",
    "",
  );

  if (ctx.picName) {
    lines.push(`Any questions, ask ${ctx.picName}.`, "");
  }

  lines.push(
    "This training is required and is part of your job here. Your links are personal to you —",
    "please do not forward them.",
    "",
    ctx.pharmacy,
  );
  if (ctx.address) lines.push(ctx.address);
  if (ctx.phone) lines.push(ctx.phone);

  return lines.join("\n");
}

export function htmlFor(ctx: EmailContext): string {
  const withCodes = ctx.items.filter((i) => i.replyCode);

  const cards = ctx.items
    .map((i) => {
      const late = i.dueOn < ctx.today;
      return `
      <tr><td style="padding:0 0 12px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:6px;">
          <tr><td style="padding:16px 18px;">
            <div style="font:600 15px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK};">${esc(i.title)}</div>
            <div style="font:400 13px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${late ? CRIT : INK2};margin-top:4px;">
              ${late ? "Overdue — was due" : "Due by"} ${esc(fmt(i.dueOn))}${i.minutes ? ` &middot; about ${i.minutes} minutes` : ""}
            </div>
            <div style="margin-top:14px;">
              <a href="${esc(i.url)}" style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;font:600 14px/1 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;padding:11px 20px;border-radius:5px;">Start this training</a>
            </div>
            ${
              i.replyCode
                ? `<div style="font:400 12px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK3};margin-top:12px;">Reply code <span style="font-family:Consolas,Menlo,monospace;color:${INK};">${esc(i.replyCode)}</span></div>`
                : ""
            }
          </td></tr>
        </table>
      </td></tr>`;
    })
    .join("");

  const replyBlock =
    withCodes.length === 0
      ? ""
      : `
      <tr><td style="padding:8px 0 0 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${GROUND};border:1px solid ${LINE};border-radius:6px;">
          <tr><td style="padding:16px 18px;">
            <div style="font:600 14px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK};">Would rather just reply?</div>
            <div style="font:400 13px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK2};margin-top:6px;">
              Reply to this email from this address with the words
              <b style="font-family:Consolas,Menlo,monospace;color:${INK};">${esc(REPLY_PHRASE)}</b>
              ${
                withCodes.length === 1
                  ? `and the reply code above.`
                  : `and the code of each one you have finished — or just leave this email quoted below and they all come with it.`
              }
              Your reply is kept as your attestation.
            </div>
            <div style="font:400 12px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK3};margin-top:10px;">
              The buttons above are the better record: they capture your signature and show you answered the questions.
              A reply records that you told us you did it. Both count.
            </div>
          </td></tr>
        </table>
      </td></tr>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${GROUND};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${GROUND};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${LINE};border-radius:8px;">

  <tr><td style="padding:22px 24px;border-bottom:1px solid ${LINE};">
    <div style="font:600 15px/1.3 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK};letter-spacing:.02em;">${esc(ctx.pharmacy)}</div>
    ${ctx.address ? `<div style="font:400 12px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK3};margin-top:2px;">${esc(ctx.address)}</div>` : ""}
  </td></tr>

  <tr><td style="padding:24px 24px 8px 24px;">
    <div style="font:400 15px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK};">${esc(ctx.firstName)},</div>
    <div style="font:400 15px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK};margin-top:12px;">${esc(opener(ctx))}</div>
    <div style="font:400 14px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK2};margin-top:10px;">
      Each one is a short read and a few questions. It works on your phone, and you do not need a password.
    </div>
  </td></tr>

  <tr><td style="padding:16px 24px 0 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cards}${replyBlock}</table>
  </td></tr>

  <tr><td style="padding:20px 24px 0 24px;">
    <div style="font:400 13px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK2};">
      The full material for each one is attached to this email — the same content as the page, so you can read it
      there if you prefer. Keep it if you like; we hold a copy.
    </div>
    ${
      ctx.picName
        ? `<div style="font:400 13px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK2};margin-top:10px;">Any questions about any of this, ask ${esc(ctx.picName)}.</div>`
        : ""
    }
  </td></tr>

  <tr><td style="padding:20px 24px 24px 24px;">
    <div style="border-top:1px solid ${LINE};padding-top:14px;font:400 12px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK3};">
      This training is required and is part of your job here. Your links are personal to you — please do not forward
      them.
      <div style="margin-top:8px;color:${INK2};">${esc(ctx.pharmacy)}${ctx.phone ? ` &middot; ${esc(ctx.phone)}` : ""}</div>
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}
