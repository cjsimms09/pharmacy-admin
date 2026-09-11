# Fetching the month from ProviderPay

The portal at <https://providerpay.ah.mckesson.com/providerpay/remittances> holds three things the
books need every month, and none of them can be fetched without a login. This is the procedure, so
that no future session has to rediscover it.

The owner asked for exactly this: *"do I need to should claude chrome how to do each the first
time? what will i need to do the first time to make sure going forward all I have to do is hit that
button?"* The answer is that Claude does not remember between sessions — so the first time is
written down here, and every time after is reading this.

## Nothing you selected last time is still selected

**Both the NCPDP and the Tax ID reset when a new browser session starts.** Neither is a stored
account preference, whatever the page looks like. Every run begins by choosing them again, and both
failures are silent: the Remittances search renders nothing at all, and the Account Summary field
turns red rather than saying what is wrong.

## The one thing that wastes an hour if you skip it

**The NCPDP must be selected on the Data Management page, not just on the Dashboard.**

The Dashboard shows "West Wichita Family Pharmacy (1722734)" whether or not Data Management has a
pharmacy set, so the account looks correctly configured when it is not. With it unset, the
Remittances search **renders nothing at all** — no table, no "0 results", no error. The page simply
sits there looking like the search never ran. It cost a session and several round trips with the
owner to find, and from the outside it is indistinguishable from "that month has no data".

So: **Data management → Select NCPDP or group → type the name → click the option in the
autocomplete list.** Typing without clicking the suggestion does not take; the dialog closes and
nothing is set. Once it is set, the nine tiles go from grey to live and the breadcrumb carries the
pharmacy name.

Then reach Remittances through the **Remittances tile**, not by typing the URL.

## The Remittances search

Four date boxes — *Remittance date* From/To, *Posted date* From/To — plus a remittance amount, and a
**Search** button at the right.

The form **pre-fills the last thirty days**. It is not empty, so typing into it appends rather than
replaces: **triple-click the box first** to select what is there, then type `mm/dd/yyyy`. A plain
click and type leaves the old date in place and the search runs on the wrong month without
complaining. Dates can be typed or picked from the calendar; both work.

Use *Remittance date*, not *Posted date*.

April 2026 returns **45 results**, on one page at the default page size of 50. Sorting and the
per-column filters are client-side — they do not re-query, so they are safe to touch.

## Downloading an 835

Per row there is **View image** and **Notes**. Neither is the 835. The 835 comes from the toolbar:

1. Tick **exactly one** row.
2. **Export** → **Export Modified 835**.

The owner's own words: *"you have to check one at a time then go to export and hit download
modified 835"*.

**"Export Modified 835" is disabled unless exactly one row is ticked.** With none ticked the whole
Export control is greyed; with *all* ticked — the select-all box in the header — the menu opens but
that one item stays grey while the two CSV items go live. This is why "select all, then export"
looks like it should work and does not. The two CSVs (Remit Summary, Remit Detail) are the table's
own data, not the 835s.

Underneath, each press is a single GET:

```
https://api.ah.mckesson.com/v1/dataManagement/remittances
  ?ncpdp=1722734&group=null&docHSQ=<per-remittance id>&action=EXPORT835
```

One `docHSQ` per remittance. There is no bulk form of it.

## Doing all of a month without clicking 45 times

Because the limit is a UI rule rather than a server one, the way through is to automate the clicks
themselves — tick a row, open Export, press Export Modified 835, untick, next row — in the page.
That is the same path a person takes, so it cannot get anything the person could not, and the files
land in the browser's download folder exactly as they would by hand.

Two things to expect:

- **Chrome asks "Download multiple files?"** the first time. It has to be allowed or everything
  after the first file is silently dropped.
- Give each press about a second. Firing them back to back loses some.

### The loop, and the bug that cost three remittances

A first version of this ticked a row, opened Export, clicked **Export Modified 835**, and counted a
success. It reported 45 of 45 in April and 49 of 49 in August, with no errors — and delivered 43 and
48. Three remittances went missing without a word.

The cause: when the checkbox tick does not register in the page's model, **Export Modified 835 stays
disabled**, and clicking a disabled menu item does nothing at all. The loop counted the click, not
the export. It was never first or last — August's casualty was row 22 of 49 — so it is a race, and
any loop that trusts its own clicks will keep losing rows.

**So the loop must verify the request, not the click.** Every export is one GET carrying
`action=EXPORT835`, so watching `fetch` and `XMLHttpRequest` gives proof. Three rules:

1. After ticking, **wait for the menu item to become enabled** rather than clicking immediately —
   check `disabled`, `aria-disabled` and any `disabled` class on the item and its ancestors.
2. Record how many exports have fired before the row, and **check the count went up afterwards**.
3. If it did not, untick, re-tick and try again — up to about four times — and if it still will not
   fire, name that remit number as failed. A named failure can be re-pulled in seconds; a silent one
   is found weeks later, if at all.

Reconciling afterwards is worth the trouble regardless, because it catches anything the loop cannot
see. The table gives the month's remit numbers; the imported payments give their trace numbers; what
is in the first and not the second is what to go back for. That is how 912547443 — SS&C Health,
08/18/2026, $1,168.49 — was found.

Do not reconcile on money alone. A remittance's total includes provider-level (PLB) holdbacks that
the claim lines do not, so the sum of imported claim payments is legitimately smaller than the sum of
the remit amounts. August: $533,748.70 of remittances, $518,125.46 of claim lines. The difference is
mostly real DIR and fee holdbacks, not missing files.

## The payment report

**Data management → Payments.** One date pair, *Recorded date (from)* and *(to)*, pre-filled with the
last thirty days. Set the month, **Search**, then **Export**.

Export here is a single button, not a menu: one press and the CSV is built in the browser and saved.
Nothing crosses the network when you press it, so there is no request to watch to confirm it worked
— the only proof is the file appearing.

One thing the label hides: the search sends `depositDateBegin` / `depositDateEnd`. It is filtering on
the **deposit** date, whatever the field is called. A payment recorded on 04/30 and deposited on
05/01 is in May's file, not April's — worth remembering before concluding a payment is missing.

## The Wells Fargo report

It is not a separate bank login. It lives inside ProviderPay:

**Account summary → Look up → click the pharmacy row → Done → the account row → View history.**

The Tax ID box looks like a text field and is **read-only**. Typing into it does nothing at all — no
error, no character appears — because it is filled by the picker behind **Look up**. In that dialog
the pharmacy is a `<button>`, not a table row, so a click aimed at where the text appears can miss it
entirely; clicking it adds a chip and a tick, and only then does **Done** fill the field. A dialog
dismissed without that chip leaves the field empty and outlined in red.

That opens *Transaction History* for the Wells Fargo account. The date control here is a **single
range box, and it is read-only** — unlike every other date field in this portal, typing into it does
nothing. It has to be driven through the calendar: open it, step back with the arrow to the month
wanted, click the 1st, then click the last day. The box then reads `04/01/2026 - 04/30/2026`.
**Search**, then **Export** — again a single button and a browser-built CSV.

### Why this report is the one that makes the bank reconcile

This is the sweep account, and the report shows both halves of the sweep: each payer's deposit
arriving, and a matching **ProviderPay Transfer** taking it out again. The transfers net the day's
deposits exactly. From April:

| Date | In | Out |
|---|---|---|
| 04/30 | ARGUS 4,914.29 | ProviderPay Transfer -4,914.29 |
| 04/29 | ARGUS 3,362.24 + EXPRESS SCRIPTS 10,363.97 | ProviderPay Transfer -13,726.21 |
| 04/27 | ARGUS 1,521.40 | ProviderPay Transfer -1,521.40 |

**The bank statement only ever shows the transfer.** One line, one lump, no payer named. So this
report is the only thing that breaks a bank deposit back into the payers behind it — and therefore
the only bridge from a deposit on the statement to the 835s that explain it. Without it a deposit
can be banked but never attributed; with it, a 13,726.21 deposit resolves into two payers and then
into their remittances.

## Where the files should land

**On the machine the site runs on**, set Chrome's download folder to:

```
C:\Users\wwfprx\pharmacy-admin\data\remittances
```

Then the site reads them where they fall and there is no upload step at all. Press **Read the folder
now** on `/remits`, or let the next sweep take them. Files that have been read move to `filed\`
beneath it, so the folder always shows only what is outstanding.

**On any other machine**, upload them at `/remits` → **Send them up**. It takes all of them at once,
in any mixture, zipped or not, and routes each by what it is rather than by its name.

## What is behind Data management

Nine tiles, all disabled until the pharmacy is selected:

| Tile | What it is |
|---|---|
| Claims / Open Claims | claim-level detail |
| **Payments** | the payment report — what each payer sent, by payment number. Banks the cash account. |
| Payment Confirmation | |
| **Remittances** | the 835s — what each payer decided, claim by claim |
| Remittance Detail Research | |
| Revenue | |
| **My Reports** | where a generated report is collected |
| Payer Setups | |

## What blocks a fully unattended run

- **Session expiry.** Eventually the cookie goes and somebody signs in again. There is no MFA on
  this account, so signing in is a password and nothing more.
- **Claude cannot start itself.** The button on `/remits` copies the request; a person pastes it.
  Nothing in a web server can reach into a Claude window and set it going, and a button that
  implied otherwise would be worse than none.

## Permissions, once per machine

The Claude Chrome extension must be allowed on `providerpay.ah.mckesson.com` before screenshots
work. Without it the page can still be read and clicked through its element tree — slower, and
riskier on an unfamiliar layout, but not blocked.

## PHI: where these files are allowed to live

**An 835 names patients.** The NM1 segments carry the member's name for every claim it pays. That
makes a folder of remittances a folder of PHI, and it decides where they may be put.

The owner confirmed on 11 September 2026 that the OneDrive on both machines is a **Microsoft 365
business account with a signed BAA**, which is what makes the synced folder above permissible.
Written down because the answer is not visible from the code and the question will be asked again:
on a *personal* OneDrive there is no BAA and remittances must not sync through it.

The same test applies to anywhere else these files are ever sent — a personal Dropbox or Google
Drive, a webmail attachment, a screenshot pasted into a chat. The payment report and the Wells Fargo
history are different: they carry payers, payment numbers and amounts, and no patient.
