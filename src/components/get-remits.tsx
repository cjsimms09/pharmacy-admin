"use client";

import { useState } from "react";

/**
 * One press to start the 835s: opens the portal and hands over the instruction for Claude.
 *
 * The owner: "There needs to be a button on the site that says get 835 remit, I hit it and Claude
 * chrome starts the downloading each for the month automatically."
 *
 * ── What this can honestly do ──
 *
 * It cannot summon Claude. This site is a server that renders pages; nothing in it can reach into a
 * Claude window and start it working, and a button that pretended otherwise would be worse than no
 * button — he would press it, watch nothing happen, and stop trusting the page.
 *
 * What it removes is everything except the asking. One press opens the portal at the remittances
 * list and puts the whole instruction, with the right month already in it, on the clipboard. He
 * signs in, pastes one line into Claude, and the clicking through every remittance is done for him.
 *
 * The month comes from the page, which worked it out from what is already in — so the sentence he
 * pastes is never wrong about which month, and he never has to hold one in his head.
 */
export function GetRemits({ portal, month, folder }: { portal: string; month: string; folder: string }) {
  const [said, setSaid] = useState("");

  /*
   * All three, in one sentence, because they come from the same portal in the same sitting.
   *
   * The owner: "the fetch remit button might as well got fetch all payments and the wells fargo
   * report as well... I can teach it how to do each of these the first time but then I would like
   * to just hit the button, it to do everything."
   *
   * The remittances are the slow part — one click each, and there is no bulk download — so they
   * are named first and the two reports after. Numbered, because a list of three is easier to
   * check off than a paragraph, and because if one of them fails he can say which.
   */
  const instruction =
    `I am signed in to ${portal}. Please fetch three things for ${month} and tell me when each is done:` +
    ` (1) every remittance for ${month} — each one separately, the portal has no bulk download;` +
    ` (2) the ProviderPay payment report for ${month};` +
    ` (3) the Wells Fargo account transaction history for ${month}.` +
    ` Put them all in my downloads. If you have not done one of these before, walk through it and I will point you at the right control.`;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-primary"
          onClick={async () => {
            window.open(portal, "_blank", "noopener,noreferrer");
            try {
              await navigator.clipboard.writeText(instruction);
              setSaid(`The portal is opening. Sign in, then paste the copied line into Claude — it asks for all three, for ${month}.`);
            } catch {
              /* Clipboard is refused on some machines. The sentence is on the page either way. */
              setSaid("The portal is opening. Sign in, then copy the line below into Claude.");
            }
          }}
        >
          Get everything for {month}
        </button>
        {said ? <span className="text-xs text-ink-3">{said}</span> : null}
      </div>

      {/*
        The instruction, visible rather than only on the clipboard.

        A clipboard he cannot see is a clipboard he cannot trust, and on a machine that refuses
        clipboard access it is the only copy there is.
      */}
      <details className="text-xs text-ink-3">
        <summary className="cursor-pointer">What it asks for, if you would rather type it</summary>
        <p className="mt-1 select-all rounded bg-surface-sunk p-2 text-[11px] leading-relaxed">{instruction}</p>
        <p className="mt-1">
          Claude downloads all three into whatever folder your browser uses. Bring them back here together with{" "}
          <b>Send them up</b> below — or, if you are at the machine the site runs on, drop them straight into{" "}
          <code className="break-all">{folder}</code>.
        </p>
      </details>
    </div>
  );
}
