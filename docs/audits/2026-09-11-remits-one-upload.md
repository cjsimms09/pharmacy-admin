# The one-press upload: what the month's files actually do when they land

**Audited:** `cfdbd08`, "One press for the month's three files, and one upload for all of them",
against `feature/compliance`. **By:** the cloud session (B). **Method:** the code, plus the new
path's own dependencies run against a real archive. Nothing here is inferred from the commit
message; where a figure appears it was measured.

The commit does what the owner asked and the shape is right — ask each file what it is rather than
make him say. Seven things it does not do, in the order they cost money.

---

## 1. An 835 uploaded here never reaches the cash account

`importRemittance` banks only under `opts.bank`:

```ts
if (opts.bank && r.paidOn && (r.totalPaidCents ?? out.amountCents) > 0 && out.payments > 0) {
  ...addCashReceipt({ ... })                                   // claim-payments.ts:411
```

Its four call sites:

| route | banks |
| --- | --- |
| the Add tool — `intake/actions.ts:101` | `bank: true` |
| the mailbox — `mailbox.ts:1119` | `bank: true` |
| the MTF folder sweep — `claim-payments.ts:535` | no opts |
| **this upload — `remits/page.tsx:159`** | **no opts** |

The parameter's own docstring settles which of the last two is right:

> *"Off for the facilitator sweep, which the books already read by received date; **on for a
> remittance dropped in by hand**."*

`sweepRemittances` is the facilitator sweep — it reads the folder the MTF's CLI fills
(`remittanceDir()` asks `mtfStatus()`), so its omission is the documented case. The Remits upload
is a remittance dropped in by hand, and it is now **the** hand route: `cfdbd08` put the page in the
navigation and made this the one press for the whole month.

So the claim in the commit message — *"routed through the same reader the mailbox uses on an
emailed one, so a file dragged in here and the same file arriving by email are treated
identically"* — is true of the payment report and **false of the 835**, which is the file the page
is named for. The claim payments post either way; the deposit does not.

**And the double-count protection it would need is already built and already cited.** The banking
block passes `sourceKey: 835|payer|trace|paidOn` under a comment that names the very collision:

> *"so the same remittance read twice banks once — and so a deposit the payer payment report
> already banked is recognised rather than added again (expenses.ts)"*

`addCashReceipt` puts every receipt through `gateDeposit` (`expenses.ts:274-276`) before it is
written. Banking from this route is what that gate exists for.

**Fix:** `{ bank: true, documentId }` at `remits/page.tsx:159`, the same two arguments the Add tool
passes twenty lines of the same idea away.

---

## 2. An `.xlsx` is taken apart, and the payments inside it are never read

The page decides an archive by magic bytes:

```ts
if (/.zip$/i.test(file.name) || buf.subarray(0, 2).toString("latin1") === "PK") {
```

The mailbox, which the commit says this matches, decides it by name and type and **not** by magic
bytes (`mailbox.ts:417`):

```ts
if (!/.zip$/i.test(a.filename ?? "") && a.contentType !== "application/zip") return [a];
```

An `.xlsx` is a PK zip. So is a `.docx`. Measured, on a real workbook built the way Excel builds
one and named `ProviderPay_Sep2026.xlsx`:

| | the page's test | the mailbox's test |
| --- | --- | --- |
| treats it as an archive | **true** | false |

and then, entry by entry:

```
  [Content_Types].xml  CLP? no   classify -> unrecognised
  .rels                CLP? no   classify -> unrecognised
  sheet1.xml           CLP? no   classify -> unrecognised
  workbook.xml         CLP? no   classify -> unrecognised
```

`importPayerPayments` never runs. Nothing is banked. Four documents are filed, and the owner is
told four times that a file was *"filed as a document (nothing reads it yet)"* — which reads as the
account-history case working, not as the payment report being lost. He would believe the month is
in.

**What I cannot check from here:** whether ProviderPay offers that report as `.xlsx` at all. The
fixture is `fixtures/payer-payments.csv`, and a CSV travels this path correctly. **That question is
for 1** — it decides whether this is live today or waiting for the first time he picks the other
download button. The shredding is real for any OOXML file either way.

**Fix:** exempt the OOXML types, or adopt the mailbox's test verbatim. The second is better: the
commit's whole argument is that the two paths agree, and two spellings of "is this a zip" is how
they stop agreeing again.

---

## 3. Every unplaced entry of an archive is stored as a copy of the whole archive

```ts
parts.push({ name: e.name.split("/").pop() ?? e.name, buf: e.data, file });   // file = the OUTER file
...
const stored = await storeFile(part.file, { allowReportTypes: true });        // so: the outer bytes
```

`storeFile` reads `file.arrayBuffer()`. `part.buf` — the entry — is never given to it. Measured on
the same workbook:

```
  document row would say  title/fileName: sheet1.xml
  bytes actually written          : 1377 bytes
  the entry sheet1.xml really is  : 137 bytes
  identical to the whole .xlsx?   : true
  sha256 recorded                 : 6aacfca73f9a2b41 (of the xlsx, not the entry)
  mimeType recorded               : application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
```

So a row that says `sheet1.xml`, 1377 bytes, is the entire workbook — and `sha256`, `sizeBytes` and
`mimeType` all describe the envelope while `title` and `fileName` describe the contents. N unplaced
entries in one archive write N copies of that archive, all with the same hash, each under a
different name.

This is not only storage. A document is the evidence behind a figure; one whose bytes are not what
its row says they are is evidence that will not stand the day somebody opens it.

Note the extension check passes for the same reason the bug exists: it is run against the outer
name, and `zip`, `xls` and `xlsx` are all in `REPORT_EXTENSIONS`. A `.rels` entry is stored without
complaint.

**Fix:** `new File([part.buf], part.name, { type: guessType(part.name) })` — `guessType` is already
exported from `zip-read.ts` and is what the mailbox uses on an entry for exactly this.

---

## 4. The documents insert has no duplicate check, and the house rule says it must

```ts
await db.insert(schema.documents).values({ id: newId(), category: "report", ... });
```

Nothing asks whether that file is already filed. The rule and its price are written down in
`invoices.ts:988-993`:

> *"IPD prints none, and its 5995-SO#1176673 arrived twice: two rows, one file, $3,255.70 counted
> twice, and nothing anywhere could see it because there was no number for anything to match on. A
> document's SHA is exact and needs nothing printed on the page. It is checked first, because a
> file already on record is already on record however it is labelled."*

Measured: the same file stored twice gives the same `sha256` and a different `storageKey`, so
nothing downstream deduplicates it either.

The page invites the repeat. It tells him to press the button and upload what it downloaded; the
button can be pressed again, the month is decided for him, and a part-finished upload is most
naturally retried by doing the whole thing again. **A file he has to upload twice was the design's
accepted cost** — which is right, and it means the second upload has to be harmless.

Not money today, because nothing reads the account history. It is money the moment something does,
and the commit's stated reason for filing it is that it is *"what proves the deposits on the bank
statement are the payments on the report"*.

**Fix:** the `invoices.ts` check — look up `documents` by `sha256` first, and where a row exists,
report it as already filed rather than filing it again.

---

## 5. A copay-voucher remittance is recognised, named, and then filed instead of posted

Only one of `classify`'s kinds is acted on:

```ts
const kind = classify(part.name, part.buf);
if (kind.kind === "payer_payments") { ... }
/* everything else */ done.push(`${part.name}: filed as a document (${kind.kind})`);
```

`copay_remit` has a reader, and the mailbox posts and banks it (`mailbox.ts:1125-1132`):

```ts
} else if (cls.kind === "copay_remit") {
  const { importCopayRemit } = await import("./copay-remit-store");
  const c = await importCopayRemit(..., { bank: true, documentId: ... });
```

Here the same document produces the line **`filed as a document (copay_remit)`** — the site naming
the kind it correctly identified, in the same sentence in which it declines to use the reader it
has for it. A copay voucher settles claims; it is money.

Worth saying plainly because it is the second half of finding 1: of the three feeds
`deposit-gate.ts` says see a deposit — the payment report, an 835, a copay statement — this page
banks exactly one.

**Fix:** the `copay_remit` branch, shaped like the `payer_payments` one above it. The rest of
`classify`'s kinds are out of this page's scope and filing them as documents is right.

---

## 6. The reasons are dropped from both the screen and the record

```ts
await audit({ ..., details: `${parts.length} files: ${done.join("; ")}` });
```

`problems` is not in it. The old line carried `${read} read, ${payments} payments, ${cents}c`; the
new one carries **no money at all** and no refusal. On the screen, `problems.slice(0, 2)`.

So on a month's upload, every reason past the second exists nowhere. `importRemittance`'s
`problems` is where the BPR02 balance check's refusal lands — the gate BACKLOG 33 part 1 exists
for, the one that stops a remittance being filed against its own printed total. Under a bulk
upload, which is what this commit builds, that is exactly when there are more than two.

The commit's own rule:

> *"A file he uploaded and heard nothing about is worse than one he has to upload twice, so nothing
> is silently dropped."*

The files are named. The reasons are not.

One more in the same line: `done.length === 0` chooses the warning banner, and the document branch
pushes to `done` for anything it manages to store. An upload in which nothing was read and
everything was filed unrecognised reports as a success.

**Fix:** `problems` into the audit details, and the count of them on the screen with a link rather
than a truncation.

---

## 7. The archive is opened with the unbounded reader

`readZip`, not `readZipBounded`. With finding 2's magic-byte test, every PK file the owner drops is
now inflated with no cap on what comes out. This is an authenticated manager upload, so it is well
below the open finding on the mail sweep (`mailbox.ts:420`, still unfixed) — but it is the same one
line, and `readZipBounded` is already in the same module.

---

## What is sound, so nobody re-checks it

- **A remittance uploaded twice does not pay twice.** The key is
  `${trace/CLP01 reference}|${rxNumber}|${paidCents}` against the claim payments already held
  (`claim-payments.ts:375-381`), and the trace number is stable across uploads.
- **Dropping the `"outer.zip → entry"` naming improved that**, rather than harming it: where an 835
  carries no trace and no CLP01 reference the key falls back to the file name, and the same entry
  sent loose and inside an archive now deduplicates against itself instead of posting twice.
- **A zip of nothing but 835s travels this path correctly** — findings 2, 3 and 4 are all in the
  branch for what an archive holds *besides* remittances.
- **The month the page asks for is decided, not guessed** — last month unless its remittances are
  already in, then this one.
- **`payer_payments` really is routed to the reader the mailbox uses**, which is what the commit
  claims and is true.

## For 1, ordered

1. `{ bank: true, documentId }` at `remits/page.tsx:159`. One line, and it is the month's deposits.
2. The archive test and `guessType(part.name)` on the entry — findings 2 and 3, one edit each.
3. The `sha256` check before the insert — finding 4.
4. The `copay_remit` branch — finding 5.
5. `problems` into the audit — finding 6.

Nothing in `remits/page.tsx`, `claim-payments.ts`, `files.ts`, `expenses.ts` or `mailbox.ts` was
edited by me. **Question for 1, under "Open items":** does ProviderPay offer that payment report as
`.xlsx`, and has anything already been uploaded through this page since `cfdbd08` deployed?
