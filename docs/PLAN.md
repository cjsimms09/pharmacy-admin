# Pharmacy Admin Desk — Design & Roadmap

*Status: planning. Nothing here is built yet. This document is the base we build on; it changes as decisions get made.*

---

## 1. What we are building, in one paragraph

A private, internal web application that runs the business side of an independent Kansas pharmacy: it tells us the most profitable way to buy every item across McKesson, IPC, IPD, ParMed and Anda given our rebate contract; it keeps us compliant with the Kansas Board of Pharmacy and DEA by tracking every recurring obligation and drafting the bi-monthly CQI summary; and it tracks whether every third-party claim has actually been paid, short-paid, or clawed back. It is fed automatically — by patient-free custom reports scheduled out of PioneerRx to a mailbox the app sweeps, by supplier price/invoice feeds, and by free public reference data — so that the owner reviews decisions rather than assembles spreadsheets. It holds **no patient identity data**, and it is designed as if a breach would be catastrophic anyway.

---

## 2. Privacy and security posture

### 2.1 The data policy (the rule everything else follows)

| Class | Examples | Policy |
|---|---|---|
| **Patient identity data** | name, DOB, address, phone, email, member/cardholder ID, person code, patient ID | **Never stored, never accepted.** The ingestion gate rejects any file that carries it. PioneerRx custom reports are built without these columns. |
| **PHI-adjacent keys** | Rx number + refill number, date filled, NDC, claim authorization number | Needed to join claims to payments and to satisfy K.A.R. 68-19-1 (CQI summaries must list the Rx numbers involved). Stored **tokenized** (keyed HMAC) everywhere except the CQI module, where the plain Rx number is stored **field-encrypted**. |
| **Workforce data** | employee name, license/registration number, expiry dates, CE hours, CPR card | Stored; it is what the compliance module is for. Minimum necessary; no SSN, no DOB, no home address. |
| **Business-confidential** | wholesaler contracts, PSAO reimbursement contracts, price files, invoices, margins, CQI records (privileged peer-review under K.S.A. 65-1695) | Stored, encrypted at rest, access-controlled by role, every access audited. |
| **Credentials** | supplier portal/EDI/SFTP logins, mailbox tokens, API keys | Production secret store only; application-level envelope encryption for anything the app must hold; never in the repo; never shown in the UI after entry. |

**Why we still build to HIPAA standards even though we hold no patient identity data:** an Rx number in the pharmacy's hands can be re-identified by the pharmacy's own PioneerRx records, so a conservative reading treats a claims ledger keyed by Rx number as PHI. Rather than argue the point, the system is built as though it were PHI: encryption, least privilege, audit trail, vendors who will sign a BAA. That way the "no patient data" rule is a second line of defense, not the only one.

### 2.2 The ingestion gate ("the site should reject it")

Every file that enters — email attachment, upload, SFTP drop, API pull — passes through the same gate before anything is stored:

1. **Provenance check.** Sender/source must be on the allowlist for that feed (e.g. PioneerRx's sending address, DKIM/SPF-verified; McKesson's SFTP host). Unknown sources are quarantined, not processed.
2. **Shape check.** The parser for that feed knows the exact expected columns. Extra columns → reject. Missing required columns → reject. A file that "mostly" matches is not processed.
3. **Content check.** Column-aware detectors for the identity classes above (name-like text where a number is expected, DOB-shaped dates, phone numbers, member-ID patterns), plus a free-text scan on any note fields. Any hit → the file is rejected, the owner is alerted with the column and row (not the value), and nothing is written.
4. **Tokenization.** Rx numbers are replaced with `HMAC-SHA256(key, rx_number || refill)` before the row is stored. The key lives only in the secret store.
5. **The raw file is not retained.** It is processed in memory, its hash and metadata are logged (source, time, size, row count, outcome), and it is discarded. The quarantine holds only rejected files, encrypted, for 30 days, so the owner can see what was refused.

### 2.3 Access architecture

- **No public surface.** The app has no open inbound port. It sits behind an identity-aware proxy (Cloudflare Access via a Cloudflare Tunnel is the recommended implementation) so a request never reaches the app unless the person has already authenticated with the proxy using MFA (passkey/hardware key). Bots and scanners see nothing.
- **Second lock inside.** The app has its own login (passkeys/WebAuthn, with TOTP fallback), short sessions (8h, re-auth for sensitive actions), and roles: **Owner** (everything), **PIC** (compliance + CQI), **Buyer** (ordering), **Bookkeeper** (reconciliation, read-only on contracts), **Staff** (their own licenses/CE, checklists). CQI records are visible only to Owner and PIC.
- **Audit log** is append-only: every login, every file ingested or rejected, every record viewed in CQI/contracts, every export, every settings change, with user, time, IP.
- **Encryption**: TLS everywhere; database encrypted at rest with point-in-time recovery; object storage (contracts, CQI PDFs, inventories) encrypted with server-side keys, no public URLs, served only through the app with short-lived signed links; field-level encryption for CQI Rx numbers and stored credentials.
- **Backups**: nightly encrypted backups to a second provider/region, restore tested quarterly (a calendar item in the app itself).
- **Software hygiene**: dependency scanning, secret scanning on every push, security headers (CSP, HSTS, frame-deny), rate limiting, no third-party scripts or analytics in the app, no CDN-hosted code at runtime.
- **Vendor posture**: prefer vendors that will sign a BAA (AWS/GCP/Azure, Cloudflare on eligible plans, Google Workspace) even though we intend never to need it.

### 2.4 How we work on it (the collaboration model)

- The repository holds **code and synthetic fixtures only**. `.gitignore`, a pre-commit hook, and CI refuse data file types and secrets. Claude Code is denied read access to data folders via `.claude/settings.json`.
- Development uses fake data. Production data is entered only through the production app (upload page, swept mailbox, supplier feeds). Claude never sees production data; production logs are redacted.
- Real contracts are read by Claude **once, in a local session on the work computer**, from `~/PharmacyPrivate/` (outside the repo). Output is a filled-in contract JSON saved to the same private folder and imported through the app. The repo only ever holds the contract *schema* and a fake example. Before that session: model-training opt-out confirmed in the Claude account's privacy settings.
- Changes flow: request → branch → pull request → owner approves on phone → merge → automatic deploy. Nothing reaches production without the owner's click.

---

## 3. Technical architecture

### 3.1 Stack (decided unless we hit a reason to change)

| Layer | Choice | Why |
|---|---|---|
| Application | **TypeScript, Next.js (App Router)**, server-rendered, single codebase for UI + API | One language for everything; strong typing for money and NDC math; mature. |
| Database | **PostgreSQL** with Drizzle ORM; migrations in repo | Boring, reliable, row-level constraints, good for ledgers. |
| Background jobs | **pg-boss** (queue on Postgres) + one worker process; cron schedules for sweeps and feeds | No Redis to run; jobs are durable and auditable in the same DB. |
| File storage | S3-compatible private bucket (Cloudflare R2 or AWS S3), server-side encryption | Contracts, CQI PDFs, inventory sheets. |
| Email intake | **Cloudflare Email Routing → Email Worker → signed webhook into the app** (fallback: Gmail API poll of a dedicated Google Workspace mailbox) | No third-party inbox retains the reports; SPF/DKIM checked at the edge; sender allowlist enforced twice. |
| Auth / edge | **Cloudflare Zero Trust** (Access + Tunnel) in front; passkeys inside | No public origin; MFA before the app is even reachable. |
| Hosting | App + worker on **Fly.io** (or a single small VPS with Docker Compose — same code, owner's preference), managed Postgres with PITR | Small, cheap, no Kubernetes. |
| Reference data | FDA NDC Directory (daily), CMS **NADAC** weekly file + API, RxNorm (RxNav API), DailyMed | All free. Medi-Span/FDB are optional paid upgrades later. |
| Parsing | Own parsers for XLSX/CSV (PioneerRx), X12 832/810/846/855 (suppliers), optional 835 | Formats are stable and small; no external SaaS sees the data. |
| Notifications | Email (transactional provider) + SMS (Twilio) to the owner; in-app inbox | Deadlines, rejected files, exceptions. |

### 3.2 Modules

```
┌─────────────────────────── Pharmacy Admin Desk ───────────────────────────┐
│  Dashboard · Alerts inbox · Audit log · Users & roles · Settings          │
├──────────────┬──────────────┬──────────────┬──────────────┬───────────────┤
│ Ingestion    │ Ordering     │ Compliance   │ Reconciliation│ Reference     │
│ Hub          │ Optimizer    │              │              │ Data          │
│ ─────────    │ ─────────    │ ─────────    │ ─────────    │ ─────────     │
│ email sweep  │ item master  │ obligations  │ claims ledger│ NDC directory │
│ SFTP/EDI     │ supplier     │ calendar     │ payment      │ NADAC weekly  │
│ uploads      │  feeds       │ licenses &   │  status feed │ RxNorm links  │
│ API pulls    │ contracts &  │  CE & CPR    │ 835 (opt.)   │ brand/generic │
│ PHI gate     │  rebate      │ CQI program  │ matching     │  class        │
│ quarantine   │  engine      │ inventories  │ exceptions   │ package sizes │
│ routing      │ buy recs     │ documents    │ payer aging  │               │
│ idempotency  │ PO export    │ checklists   │ DIR / fees   │               │
└──────────────┴──────────────┴──────────────┴──────────────┴───────────────┘
```

### 3.3 Core data model (entities, not full schema)

- **Supplier** (name, type primary/secondary/GPO, feed configs, effective dates, status). Suppliers can be added/retired without code changes.
- **Contract** (supplier, type: rebate / reimbursement / GPO, effective from/to, document ref, terms JSON validated against a versioned schema). A contract change is a new version; history is kept; the optimizer always uses the version in force on the purchase date.
- **Item** (our canonical product: RxNorm concept + package; links to NDCs), **SupplierItem** (supplier's item number, NDC, pack, unit, contract price, list price, availability, last seen).
- **PriceObservation** (supplier item, price, source feed, observed at) — history, never overwritten.
- **Claim** (rx_token, fill_date, ndc, qty, days_supply, payer/BIN/PCN/group, submitted, adjudicated, copay, acquisition cost, status, auth number, source report id).
- **Payment** (payer, method, trace/check number, date, amount) and **PaymentLine** (rx_token, paid amount, adjustments, reason codes) — from PioneerRx reconciliation report or 835.
- **Obligation** (name, rule: fixed date / interval / relative-to-event, owner role, lead times, source citation) and **ObligationInstance** (due date, status, completed by/at, evidence doc).
- **Person** (workforce member, role), **Credential** (type: RPh license, tech registration, intern, CPR, immunization training, DEA POA…; number, issued, expires, evidence doc), **CEEntry** (hours, provider, ACPE #, date).
- **CQIIncident** (created, type, rx_number_encrypted, employees involved, review started/completed, RCA, CAP, effectiveness evaluation), **CQISummary** (period, generated draft, finalized by PIC, communicated-to list, PDF).
- **InventoryEvent** (kind: annual CS / DEA biennial / PIC change opening / PIC change closing, date, before-open or after-close flag, participants + license numbers, signed sheet doc).
- **Document** (bucket key, class, retention-until, uploaded by, sha256).
- **IngestJob** (source, feed, received at, sha256, outcome, rejection reason, rows).
- **AuditEvent** (who, what, which record, when, from where).

---

## 4. Module designs

### 4.1 Ingestion Hub — the automation backbone

**Goal:** every recurring input arrives without a human touching it, is verified, and is routed to the right parser.

Sources and routing:

| Source | Transport | Cadence | Routed to |
|---|---|---|---|
| PioneerRx scheduled custom reports | email attachment (XLSX/CSV) to the swept address | daily (claims, usage), weekly (inventory, DIR), monthly (profit) | Reconciliation / Ordering |
| McKesson Data Exchange exports or EDI 832/810/855/846 | SFTP or EDI VAN mailbox | daily price file, invoices as they post | Ordering |
| Anda / ParMed / IPC / IPD price & availability | EDI where offered; otherwise scheduled email or manual upload of their exported price list | daily–weekly | Ordering |
| NADAC, FDA NDC Directory, RxNorm | HTTPS pull | weekly / daily | Reference data |
| Payment status | PioneerRx reconciliation report (preferred) or 835 files via PSAO/PBM SFTP | daily | Reconciliation |
| Contracts, CQI packets, inventory sheets, license cards | owner upload in the app | as needed | Documents |

Design rules: every feed has a **fingerprint** (sender + subject pattern + attachment name pattern + header row) that must match; each file is **idempotent** by SHA-256 (re-sent reports don't double-count); every job leaves an **IngestJob** record; a **health board** shows each feed's last successful arrival and alerts when one is late ("Claims report expected by 06:00, not received").

### 4.2 Ordering Optimizer

**What PioneerRx already does** (so we don't duplicate it): reorder points, usage-based ordering, and a Recommended Order that can pick the lowest 832 catalog price among EDI-connected wholesalers.

**What it does not do — our value:**

1. **Contract-aware landed cost.** For each line, for each supplier: `landed = contract_price − expected_rebate_contribution − prompt_pay_discount + shipping/fees`. The rebate contribution is not a flat percent: it depends on where the month/quarter ends up on the GCR tier ladder.
2. **GCR tier protection.** Buying a generic from a secondary lowers McKesson's generic-compliance ratio (OneStop generic spend ÷ total Rx spend at McKesson). Dropping a tier can cost more on the *whole month's* purchases than the secondary saved on one line. The optimizer tracks month-to-date and quarter-to-date ratios, projects the end-of-period tier, and shows the **marginal** value of each line: "Buying this from Anda saves $14 but moves you 0.3% closer to the 14% tier edge; safe this month / not safe this month."
3. **Reimbursement-aware buying.** Expected reimbursement per unit (contract formula or NADAC-based estimate) beside acquisition cost; flags **below-cost** items before they're bought and suggests NDC alternatives within the same RxNorm concept that reimburse better.
4. **Secondary supplier coverage.** Price and availability from suppliers PioneerRx isn't EDI-connected to, via their price files or exports.
5. **Contract compliance dashboard.** Where we stand against every threshold, projected rebate dollars, what one more $1,000 of OneStop generics is worth this month.
6. **Output**: a recommended PO per supplier with explanations, submitted through the most automated sanctioned route that supplier offers (see "Order submission routes" below). We do not automate supplier portals: McKesson's and Cardinal's terms explicitly prohibit bots and scrapers.

**Order submission routes (research, Sept 2026).** PioneerRx has no purchase-order import (no file, no API, no paste), so PioneerRx is not the channel; orders are placed at the supplier and PioneerRx receives them through the supplier's existing 856/810 flow, which is how every third-party purchasing tool works today. Per supplier:

| Supplier | Most automated route | Fallback | Confirmations back |
|---|---|---|---|
| McKesson | EDI 850 from the app (855/856/810/832 back); single-store onboarding to confirm | McKesson Connect Data Exchange **Purchase Order Import** (mapped Excel/delimited file, saved import template; human clicks submit) | 855 fills/shorts/subs; portal Prepare-PO flags; Invoice/Receipt Export |
| Anda | EDI 850 + 997 (855/856 optional) | Anda Online cart (order-upload format unconfirmed) | 855/856 if enabled; portal status |
| ParMed (Cardinal) | Cardinal EDI 850/855/856/810/832 if extended to ParMed | Cardinal **APOI** cart import if available to ParMed; portal/app | 855/856/810 or portal |
| IPC Warehouse | "EDI ordering through PMS" — scope to confirm | order.ipcrx.com upload/cart | portal |
| IPD | none found | portal cart from the app's pick list | portal |

No supplier offers a public ordering API. Where a supplier only has a portal, the app produces the pick list (or the supplier's upload file where one exists) and the buyer submits it; the app then reconciles what was actually received from the PioneerRx purchases/receiving report and the supplier invoice.

**Contract term schema (rebate)** — the fields the JSON must capture: measurement period (month/quarter), numerator item set definition (e.g. OneStop-eligible NDC list or flag), denominator definition, tier ladder `[ {threshold_ratio, rebate_pct} ]` (non-cumulative), exclusions (drop-ship, returns, credits, specific programs), payout timing and method (credit memo), prompt-pay terms, promotional overlays with date windows and caps, effective dates. IPC Pharmacy Select purchases through McKesson count toward GCR and earn IPC quarterly rebates — modeled as a second contract layered on the same purchases.

### 4.3 Compliance

Everything below is calendarized with lead-time alerts (90/60/30/7 days), an owner, and a place to attach evidence. Citations are recorded on each obligation so an inspector-ready packet can be printed.

**CQI program — K.A.R. 68-19-1 (amended Aug 16, 2024), K.S.A. 65-1695.**
- Summary due by the **15th of Feb, Apr, Jun, Aug, Oct, Dec**, covering the previous two calendar months. If nothing occurred: a **null report** stating so. Retained 5 years. Kept on file for inspection, not submitted.
- Per incident: review **started within 7 days**, **completed within 30 days**, documenting communication with each employee involved, a root cause analysis, and a corrective action plan.
- App: log incidents (type, Rx number(s) — encrypted, employees involved, dates); timers for the 7/30-day windows; on the 1st of each due month, **auto-draft the summary** containing each incident type with its Rx numbers, each RCA, each CAP, and the effectiveness evaluation of CAPs from the previous four months; PIC edits, finalizes, records who it was communicated to; PDF stored with the summary; prior summaries uploaded to seed history. The incident report form's complainant details (name/phone) are **not** stored in the app — that paper/PioneerRx record stays where it is today; the app references it by incident number.

**Controlled-substance inventory — K.A.R. 68-20-16 and 21 CFR 1304.11.**
- Kansas: **annual**, no later than 375 days after the previous one; must record whether taken **before opening or after close**; exact count for CII and non-liquid CIII–V; name, license number and signature of each participant; includes drugs of concern, will-call bins, outdated stock; retained 5 years. A properly documented annual count also satisfies the DEA biennial requirement.
- App: next-due date from the last event; the open/close flag and participant list captured; signed sheet uploaded; PIC-change opening/closing inventories handled as the same event type with their own deadlines (outgoing within 2 days before/on last day, Board notified within 5 days; incoming within 2 days; Form BA-50; acknowledgment within 30 days).

**Licenses, registrations, CE, CPR.**

| Credential | Cycle | Tracked |
|---|---|---|
| Pharmacy registration | annual, June 30 | expiry, renewal evidence |
| Pharmacist license | biennial, June 30; 30 CE hours incl. 1-hour Board course; no carryover | expiry, CE hours to date, Board-course flag |
| Technician registration | biennial, Oct 31; 20 CE hours; non-ACPE certificates submitted within 30 days | expiry, CE hours, certification exam |
| Intern | 6 years from issuance | expiry |
| DEA registration | 3 years; CSOS certificate expires with it | expiry, CSOS renewal |
| CPR (anyone administering vaccines, K.S.A. 65-1635a) | per card (typically 2 years) | expiry per vaccinator; immunization training on file |
| Employment changes | Board notified within 30 days | task on hire/leave |
| Tech ratio 4:1, max 2 uncertified per RPh | continuous | roster check |

**Other calendared obligations:** K-TRACS reporting within 24 hours and zero reports (checklist + anomaly alert if PioneerRx CS counts and K-TRACS confirmations diverge); theft/loss — Kansas notice within 1 day, DEA notice within 1 business day, DEA-106 within 45 days; majority-ownership change notice within 5 days; KMAP revalidation every 5 years; Medicare Part D FWA/general compliance training within 90 days of hire and annually; annual HIPAA risk analysis; vaccine protocol review and KSWebIZ reporting; DSCSA trading-partner verification and the Nov 27, 2027 small-dispenser deadline; USP 795/797/825 adoption July 1, 2027; record retention (Rx/patient records, CS invoices, 222/CSOS, inventories: 5 years Kansas); reference library updated annually; temperature log daily (min/max); expired-drug quarantine and reverse-distributor manifests; backup-restore test quarterly.

**Inspection readiness:** a checklist built from the Board's I-02P form and FAQ list of inspectable records (prescriptions, invoices, inventories, POA forms, immunization records incl. training/CPR/protocols, incident reports, CQI documentation, compounding records, signature logs) with a one-click "inspection packet" export.

### 4.4 Payment Reconciliation

**Preferred design (Option A — no 835s in our system):** PioneerRx's Third Party Reconciliation module (or its optional Reconciliation Service, or a partner such as Net-Rx/FDS/Inmar) consumes the 835s. A patient-free custom report exports, per claim: adjudicated amount, paid amount, payment date, check/EFT trace number, difference, fee/adjustment amounts, status. The app ingests that daily and does the analysis PioneerRx doesn't surface well:

- **Aging by payer** (BIN/PCN → PBM): unpaid claims at 30/60/90 days, expected payment dates from each payer's observed cycle, escalation list.
- **Short-pays and clawbacks**: adjudicated vs paid deltas, DIR/price-concession totals by payer and period, reversals after payment.
- **Expected vs actual reimbursement** using the PSAO/third-party contract terms (AWP − x% / MAC / dispensing fee / GER) and NADAC as a reference: underpayment candidates and **MAC appeal** lists with the evidence attached.
- **Below-cost fills** by NDC/payer, feeding the ordering optimizer (buy a different NDC, or flag the plan).
- **KPIs**: days-to-pay by payer, short-pay rate, reversal rate, DIR as % of revenue, gross margin after DIR by payer.

**Option B (later, only if A is insufficient):** ingest 835 files directly from the PSAO/PBM SFTP through the gate. An 835 carries patient names (NM1*QC) and claim IDs; the parser would keep BPR (payment), TRN (trace), CLP (claim: patient-control number = the pharmacy's Rx/refill reference, status, charged/paid), CAS (adjustment group/reason codes), SVC, PLB (provider-level adjustments — where DIR fees and clawbacks appear), and DTM, and would **drop NM1 patient segments before storage** and tokenize CLP01. Kept as a designed-but-unbuilt module.

---

### 4.5 Advanced purchasing analyses (added after owner discussion)

**Recommended returns.** For each on-hand item: dollars at risk × probability of non-use before the return window closes, using weekly on-hand/expiry, daily velocity, invoice cost, and each supplier's return policy (window before expiry, restocking fees, non-returnables, reverse-distributor cutoff). Time-aware recommendations ("return now at full credit; partial credit after this date"), with feedback into max on-hand for items returned repeatedly.

**Two-cost purchasing (the rebate game).** Every purchase has an invoice cost and a ratio effect. The engine computes a period-specific *shadow price* on McKesson denominator dollars from month- and quarter-to-date position and projected finish, so a brand bought from a secondary at a small premium is recommended when it protects a tier, and secondaries are cleared for generics when a tier is safely held. Constraints modeled from the contract file: primary-vendor minimum commitments, brand pricing tied to volume, payment terms, promotional windows, timing within the period.

**MAC appeal pipeline.** Detect (paid vs actual invoice acquisition cost and NADAC, with Kansas appeal-window deadlines — statute days to verify), build evidence packets per PBM/PSAO format, produce batch files where the PSAO accepts them (portal submission may remain manual for some PBMs), track status and outcomes, and learn which PBM/drug combinations succeed.

**Contract replay (renewal / alternative suppliers).** Replay the last 12 months of actual purchase lines (McKesson Connect invoice export — request now) through each candidate contract's terms (cost-plus/minus, generics program, rebate ladder, brand pricing, fees, payment terms) to a net-cost total on the pharmacy's real mix, with sensitivity to brand-shifting and generic share. Scores Cardinal, Cencora, Smith Drug, Morris & Dickson proposals on the same basis and quantifies each tier's value for the McKesson renewal.

---

## 5. PioneerRx custom report specifications (patient-free)

These are the reports to build in PioneerRx's report designer and schedule to the swept address. Every one excludes patient name, DOB, address, phone, email, member/cardholder ID, person code, and patient ID. Exact PioneerRx field names will be mapped once we see the designer.

1. **Daily claims** (yesterday's transactions): Rx number, refill number, date filled, date sold, dispensed NDC, quantity, days supply, brand/generic flag, third party name, BIN, PCN, group, claim status (paid/reversed/rejected), authorization/claim reference number, ingredient cost submitted, adjudicated (plan pay), copay, sales tax, acquisition cost, gross profit, DIR estimate.
2. **Daily payment status** (from Third Party Reconciliation): Rx number, refill number, date filled, third party, adjudicated amount, paid amount, payment date, check/EFT trace number, difference, fee/adjustment amounts, reconciliation status.
3. **Daily usage** (for ordering): dispensed NDC, quantity dispensed, number of fills (aggregated by NDC — no Rx numbers needed).
4. **Weekly inventory on hand**: NDC, description, on-hand quantity, package size, last cost, average cost, reorder point, max, last dispensed date, preferred supplier, inventory group.
5. **Weekly short-dated / expiring**: NDC, lot, expiration date, quantity.
6. **Monthly DIR / fees**: third party, period, amount, basis.
7. **Monthly profit by NDC**: NDC, fills, revenue, cost, gross profit, by third party.
8. **Purchase/receiving** (if EDI 810 invoices post into PioneerRx): invoice number, date, supplier, NDC, quantity, unit cost, extended cost.
9. **Daily controlled-substance dispensing counts** (aggregate by schedule, no Rx numbers) for the K-TRACS reconciliation check.

Open item to confirm in PioneerRx: whether Scheduled Reports can email attachments directly, and in which formats; if only a folder drop is supported, a tiny sync agent on the pharmacy PC will forward the folder to the app over a signed channel.

---

## 6. Automation map — what happens without anyone doing anything

| When | What the app does |
|---|---|
| 05:30 daily | Sweeps mailbox; verifies, gates, parses PioneerRx reports; updates claims ledger, payment status, usage. Alerts if an expected report is missing. |
| 06:00 daily | Pulls/receives supplier price and availability feeds; records price observations; flags price jumps >10% on top-200 items. |
| 06:30 daily | Recomputes GCR month/quarter-to-date and projected tier; builds today's recommended buy list with explanations; emails a one-screen digest to the buyer. |
| Daily | Aging pass on unpaid claims; new short-pays and reversals surfaced; escalations queued. |
| Weekly (Wed) | NADAC refresh; below-cost and MAC-appeal candidate lists refreshed; weekly profitability digest to owner. |
| 1st of Feb/Apr/Jun/Aug/Oct/Dec | Drafts the CQI summary (or null report) for PIC review; reminder cadence until finalized by the 15th. |
| 7 and 30 days after any incident | Review-window reminders to the PIC. |
| 90/60/30/7 days before any credential or registration expiry | Alerts to the person and the owner; CE-hour shortfall projection. |
| 60/30 days before annual CS inventory due | Reminder with the count-sheet ready to print from the latest on-hand report. |
| Month end | Contract compliance statement: projected rebate, tier reached, what changed it. |
| Quarterly | Backup-restore test task; HIPAA risk-analysis and training-status review task. |

---

## 7. Roadmap

**Phase 0 — Foundation and security (weeks 1–2).** Repo guardrails (done), CI, Next.js + Postgres skeleton, Cloudflare Access + Tunnel, passkey login, roles, audit log, document vault, ingestion hub with email intake, PHI gate and quarantine, feed health board, notification service, deployed to production empty. *Exit: owner logs in from phone through Access with a passkey; a test email with a fake report is ingested; a test email with a fake patient column is rejected and alerted.*

**Phase 1 — Compliance (weeks 3–5).** Obligation engine and calendar, workforce credentials and CE, CQI incidents/summaries with auto-draft and PDF, inventory events, inspection checklist and packet export, seeded from prior CQI summaries and current license cards. *Exit: the next CQI summary is drafted by the app; every expiry has an alert.* This phase needs no external integrations, so it goes live first and proves the platform.

**Phase 2 — PioneerRx feeds and reconciliation (weeks 5–8).** Custom reports built and scheduled; parsers; claims ledger; payment status ingestion; aging, short-pay, DIR views; payer KPIs; first third-party contract encoded for expected-vs-actual. *Exit: owner sees every unpaid claim over 30 days by payer without opening PioneerRx.*

**Phase 3 — Ordering optimizer (weeks 8–12).** Reference data loaders; item master and NDC crosswalk; supplier feed parsers (McKesson Data Exchange/832 first, then Anda, then the secondaries' exports); rebate contract engine with the real contract JSON; GCR tracker; recommended buy list; below-cost flags; PO export. *Exit: the morning buy list beats last month's actual purchasing on a back-test using our own invoices.*

**Phase 4 — Depth (ongoing).** MAC appeal automation, what-if contract negotiation tool ("what would tier 3 have paid last year?"), optional 835 module, multi-store readiness, additional suppliers, vaccine/K-TRACS reconciliation checks, owner's weekly one-page business review.

---

## 8. What the owner needs to do — start now, they take weeks

1. **Create the private GitHub repo `pharmacy-admin`** and grant the Claude GitHub App access to it; enable a pull-request rule on `main`.
2. **Account hardening:** passkey/hardware-key 2FA on GitHub and Anthropic accounts; model-training opt-out in Claude privacy settings; full-disk encryption on the work computer.
3. **McKesson:** ask the account rep for McKesson Connect **Data Exchange** (Price/Product Export, Invoice Export) and/or EDI 832/810/846 through E-Commerce Services, delivered to an SFTP we control. Ask for the current PVA/OneStop rebate schedule in writing.
4. **Anda:** ask Tech Support (EDI onboarding) about EDI 832/850/855 and any daily price/stock file. **IPC, IPD, ParMed:** ask each for a scheduled price/availability export or EDI; ask IPC how Pharmacy Select purchases are reported.
5. **PioneerRx:** confirm Scheduled Reports can email attachments (and formats); confirm the Third Party Reconciliation module is active and what it exports; ask about the Enterprise API only if reports prove insufficient.
6. **Gather for the local contract session:** McKesson PVA + rebate schedule, IPC membership terms, PSAO/third-party reimbursement contracts, two recent CQI summaries (for structure), current license/CPR cards, last CS inventory sheet, list of staff and roles, the PBMs/BIN-PCNs you bill most.
7. **Decide:** domain for the app (a subdomain of the pharmacy's domain or a separate one), Google Workspace vs Microsoft 365 for the swept mailbox, hosting preference (Fly.io vs own VPS), and who gets which role.

---

## 9. Open questions and risks

- **PioneerRx report scheduling by email** is unconfirmed in public documentation; fallback is a folder-sync agent.
- **Secondary suppliers may offer no feed at all**; then their prices come from periodic exports the buyer uploads, which is still far better than checking portals by hand. Automating their portals is off the table where terms prohibit it (McKesson explicitly does).
- **Rebate contract numbers** exist only in your documents; every public copy is redacted. The optimizer is only as right as the contract JSON.
- **Kansas rules to verify against the live text** before hard-coding: full incident-report content list in 68-19-1; pharmacist renewal year parity; retail temperature-log and expired-drug requirements (likely only on the I-02P form); any 2025–2026 amendments.
- **Rx numbers in the CQI module** are the one place plain PHI-adjacent identifiers are stored; they are field-encrypted and role-restricted, and the module never holds names.
- **Single-owner risk**: document everything in the repo so anyone competent could take it over; the app must never be the only copy of a compliance record (PDFs are exportable).

---

## 10. Research basis

Findings were gathered from the Kansas Board of Pharmacy, Kansas regulations (K.A.R. 68-19-1, 68-20-16, 68-21-2, 68-1-9, 68-5-18, 68-1-1b), K.S.A. 65-1635a/65-1642/65-1695/65-4116, DEA 21 CFR 1301/1304, PioneerRx published feature and API documentation, McKesson data-integration and terms pages, Anda and Cardinal/ParMed published materials, IPC's GCR guidance, public SEC-filed McKesson agreements, CMS NADAC documentation, and FDA/NLM reference-data documentation. Direct fetches of several primary sites were blocked in the research environment, so items marked "verify" above are to be checked against the live pages before implementation.
