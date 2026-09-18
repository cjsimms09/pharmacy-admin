# What to send PioneerRx support

The database is on the pharmacy's own server, so the direct route is open. Three asks, one email.
The first is the one that solves the problem; the second and third are the fallback and the
question that must be answered either way.

Send it to PioneerRx / RedSail support with the pharmacy's NCPDP number in the subject.

---

**Subject: Read-only reporting access to our PioneerRx database — West Wichita Family Pharmacy, NCPDP [number]**

Hello,

We are doing our own reimbursement analysis — checking what each plan actually pays against what
we paid for the drug, so we can identify MAC appeals and buy the right NDC. I have three requests,
and the first would make the other two unnecessary.

**1. A read-only SQL login to our PioneerRx database.**

Our database is on our own server here in the pharmacy. I would like a read-only account so we can
query it on a schedule for our own reporting. Specifically, please provide:

- the SQL Server instance name and the database name
- a login with **db_datareader only** — no write access of any kind
- confirmation that read-only querying is within our support agreement, and anything you need us
  to sign

We are not asking to modify anything. Read access only, to our own dispensing data.

**2. Alternatively, a scheduled data extract delivered to SFTP.**

If direct database access is not something you grant, do you offer a **data extract or integration
feed** — the kind provided to analytics and inventory partners — separate from the user-facing
reports? If so we would like a nightly extract of dispensing detail containing the fields listed
below.

Please **host the SFTP endpoint on your side and give us credentials to pull from it**. We would
rather not run an internet-facing SFTP server in the pharmacy. If you can only push, tell us and
we will arrange a managed endpoint.

We would need: the hostname and port, key-based authentication if you support it, the file format
and naming, and a signed BAA covering the transfer.

**3. If neither of those is possible: please add these fields to the "Rx Transaction Details
By Submission Type (BETA)" report,** which we already have scheduled and emailed daily.

In order of how much each matters to us:

| Field | Why |
|---|---|
| Primary Basis of Reimbursement (NCPDP 522-FM) | The single most important one. Without it we cannot tell whether a claim was paid on MAC, NADAC, AWP or U&C, and every downstream figure is a guess. |
| Dispensed NADAC | The benchmark as of the date of adjudication. |
| Dispensed AWP | Same. |
| Dispensed Item GCN | So we can group NDCs that are the same drug. |
| Days Supply | 30-day and 90-day fills price on different contract lines. |
| Dispensed Item Name | The report currently carries the NDC but no drug name. |
| Dispensed MAC | The plan's own MAC amount where it returns one. |

All of these already exist on the canned **daily_report**, so the data is clearly available — we
just cannot schedule that report. **If it is easier to make daily_report schedulable instead, that
would work just as well.**

**4. A question about the daily_report, whichever of the above we end up with.**

That report carries both an `Acquisition Cost` column and a `Net Profit` column. On a single day's
data they disagree on 59 of 117 rows — backing the cost out of Net Profit gives a different figure
from the Acquisition Cost column, and across that one day the two differ by about $1,284. The
stated Acquisition Cost is the higher of the two on 57 of those 59 rows.

Which one is our actual paid cost for the units dispensed — and what is the other one? We need to
know before we use either in a margin calculation or file a MAC appeal on it.

Thank you,

Cory Simms, PharmD
Pharmacist-in-Charge / Owner
West Wichita Family Pharmacy

---

## If they say no to #1 and #2

It is a common ask and many pharmacies have it — third-party analytics and inventory vendors
connect to PioneerRx databases routinely, so there is precedent to point at. If it is still
refused, ask specifically **who they will grant it to**: if they will give a named reporting
vendor read access but not the pharmacy, that is worth knowing, and it is worth pushing back on
given it is the pharmacy's own data on the pharmacy's own server.

## Once access is granted

Run **Find the PioneerRx tables.cmd** in the Pharmacy Admin folder with the server name they give:

    powershell -ExecutionPolicy Bypass -File scripts\pioneer-discover.ps1 -Server DOWNSTAIRS\INSTANCE

It reads table and column names only, and writes `pioneer-schema.json`. Send that back and the
nightly query gets written against the real schema.
