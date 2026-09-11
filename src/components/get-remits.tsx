"use client";

import { useState } from "react";

/**
 * One press to start the 835s: hands over the instruction, with the right month already in it.
 *
 * The owner: "There needs to be a button on the site that says get 835 remit", and then, having
 * pressed it: "i clicked get everything button but it didnt pull up with claude chrome??"
 *
 * ── Why it no longer opens the portal itself ──
 *
 * It used to, and that was worse than useless. Claude drives one particular group of tabs, and a
 * tab opened by this page lands outside it — so the button produced a portal window Claude could
 * not see, could not read and could not click, sitting next to a Claude window that had not been
 * told anything. It looked like the feature working and was the opposite.
 *
 * Claude opens the portal, in a tab it can actually drive. So the button's whole job is the
 * handover: the instruction, with the month the page worked out, on the clipboard in one press.
 * He pastes it, Claude opens the portal, he signs in, and Claude does the clicking.
 *
 * The month never has to be held in his head, and the sentence is never wrong about which.
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
            /*
             * Copied, not opened. A tab this page opens is one Claude cannot drive — see above.
             */
            try {
              await navigator.clipboard.writeText(instruction);
              setSaid(`Copied. Paste it into Claude — it asks for all three, for ${month}, and Claude will open the portal for you to sign in.`);
            } catch {
              /* Clipboard is refused on some machines. The sentence is on the page either way. */
              setSaid("Copy the line below and paste it into Claude — it will open the portal for you to sign in.");
            }
          }}        >
          Copy the request for {month}
        </button>
        {said ? <span className="text-xs text-ink-3">{said}</span> : null}
      </div>

      {/*
        The instruction, visible rather than only on the clipboard.

        A clipboard he cannot see is a clipboard he cannot trust, and on a machine that refuses
        clipboard access it is the only copy there is.
      */}
      <details className="text-xs text-ink-3">
        <summary className="cursor-pointer">What it asks for, and what happens next</summary>
        <p className="mt-1 select-all rounded bg-surface-sunk p-2 text-[11px] leading-relaxed">{instruction}</p>
        <p className="mt-1">
          Claude opens the portal in a tab it can drive, you sign in there, and it downloads all three into whatever folder your browser uses. Bring them back here together with{" "}
          <b>Send them up</b> below — or, if you are at the machine the site runs on, drop them straight into{" "}
          <code className="break-all">{folder}</code>.
        </p>
      </details>
    </div>
  );
}
