# Questions for ProviderPay (McKesson / Health Mart Atlas)

ProviderPay is McKesson's reconciliation product (providerpay.net), sold through Health Mart Atlas; it is the pharmacy's ERA (835) receiving point and matches claims to remittances. It is also a PioneerRx Connected Vendor. PBMs generally allow one ERA receiver per pharmacy NPI, so copies of 835s must come from ProviderPay.

1. Can we download the raw 835 files, via the portal or SFTP? How long are they retained? Can delivery to an SFTP we control be scheduled?
2. If raw files are not available: a claim-level CSV/Excel export with paid amount, adjustments and reason codes, check/EFT trace number, payment date, DIR/fees, and claim status. Can it be scheduled by email daily?
3. Any API or automated feed? Any terms restricting scripted export of our own data?
4. What exactly flows between ProviderPay and PioneerRx (direction, fields, cadence)?
5. Which PBMs list ProviderPay as our ERA receiver? Can a second receiver be added for any of them?
6. Is our EFT money paid directly to our bank (direct deposit) or through central pay? Either way, what deposit reference appears on the bank side so deposits can be matched to 835 trace numbers?
7. Pricing model (per-claim percentage or flat) and what happens to our data and 835 history if we terminate.
