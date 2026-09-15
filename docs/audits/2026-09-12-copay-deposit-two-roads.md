# The copay deposit's cross-feed guard rests on the two feeds choosing the same payer name

**Audited:** `copay-remit-store.ts` and its interaction with `deposit-gate.ts`, never audited before,
while the base was quiet at `1a8554f`. **By:** the cloud session (B). **Method:** the gate run.

The accrual side of this reader is right, and the finding is on the cash side.

---

## 1. The comment claims cross-feed protection from the one mechanism that cannot give it

`copay-remit-store.ts:293-295`:

```ts
// See expenses.ts: a statement read twice is one deposit, and a voucher payment the payer
// payment report already banked is the same money arriving by a second road.
sourceKey: `copay|${r.reference ?? fileName}|${r.paidOn}`,
```

The first half is true and the `sourceKey` delivers it: the same statement read twice produces the
same key and the second is refused. **The second half cannot come from this line.** The payment
report's key is `payer-payment|${paymentNumber}` (`payer-payments-store.ts:90`), so the two prefixes
can never match. Whatever protects against the second road, it is not the key the comment is attached
to.

What actually protects it are the gate's other two rules, and they hold in exactly two circumstances.
Run, with the same $177.25 arriving by both roads on the same day:

```
report says payer 'RedSail Technologies', payment 900123456   refused: 177.25 from RedSail Technologies
                                                                       on 2026-09-10 is already banked as CHK804215
report says payer 'ProviderPay', payment 900123456            BANKED AGAIN
report carries the SAME reference (6+ digits)                 refused: CHK804215 is already banked as 177.25
report says payer 'RedSail', but $1 more                      BANKED AGAIN
```

So the money is caught when the two feeds **share a reference of at least six digits**
(`deposit-gate.ts:104`), or when the **payer names share their first eight alphanumeric characters**
and the amounts match to the cent (`:118-122`, via `head()`).

**It is not caught when the payment report names the payer differently.** The copay reader hard-codes
`COPAY_PAYER = "RedSail Technologies (RAS copay voucher)"` (`copay-remit.ts:119`), whose `head()` is
`redsailt`. A report naming the same money "ProviderPay" gives `provider`. Different, so the clash
rule does not fire, and $177.25 banks twice.

**What I cannot establish from here, and it decides whether this is live:** what the ProviderPay
payment report actually calls this payer, and whether the voucher money appears on it at all. That is
one look at a real report, and it is in HANDOFF. If the report names RedSail and the amounts agree to
the cent, the guard holds today and this is a latent fault rather than an active one.

**Fix:** give the copay receipt an identity the other feed can match rather than a name it must
guess — the payment number where the statement carries one, or a `sourceKey` whose payer segment is
normalised the way `payer-name.ts` now normalises payer names elsewhere. Failing that, the comment
should say what the protection actually rests on, because the next person to change either feed's
payer string will not know they are holding a dedupe together.

**One property worth knowing while you are in there.** The reference rule needs **six** digits:
`digits(reference).length >= 6` (`deposit-gate.ts:104`). A check number printed `CHK80421` has five,
falls through the rule entirely, and is caught only by the amount-and-payer clash. It caught my own
first fixture out, which is how I noticed.

---

## 2. Checked and clean: the accrual side does not double-count

```ts
/* A matched line settles what the claim already carries, so none of it is new revenue. A
 * line with no claim behind it has never been counted anywhere, so all of it is. */
revenueCents: claim ? 0 : n.paidCents,
```

That is exactly right, and it is the distinction I would have gone looking for: a copay voucher
settles what the claim was already promised, so counting it as revenue again would book the same
dispensing twice. A line the site has no claim for is genuinely new money and is counted in full.

Also sound, and worth recording because it is the same class of fault I have reported twice
elsewhere: this reader passes `bin: COPAY_BIN` into `recordClaimPayment` rather than letting a second
matcher pick a claim from the prescription alone. Its own comment gives the reason — *"Two matchers
for one thing, which is how a payment can be recorded against a claim other than the one the screen
said it settled."* That is the right instinct and it is applied here.

And the deposit amount is the statement's own payment figure rather than the sum of what was
recorded, *"because they differ whenever a payment was already held, and what reached the bank is
what the payer says it sent."* Correct: the bank saw one number.

## For 1

1. An identity the payment report can match, or a comment that says what the protection really is.

**Question under "Open items":** on a real ProviderPay payment report, what payer name carries the
RAS copay voucher money, and does that money appear on the report at all?

Nothing in `copay-remit.ts`, `copay-remit-store.ts`, `deposit-gate.ts` or `payer-payments-store.ts`
was edited by me.
