# NADAC on data.medicaid.gov — how the site reads it, and why that way

NADAC (National Average Drug Acquisition Cost) is published by CMS, weekly, free, with no account
or key. Under Kansas SB 20 (effective 1 July 2026) it is the reimbursement floor for commercial
plans outside ERISA, so the site needs every week's file, not just the current one: each weekly
file carries only the prices in force that week, and a July claim can only be priced from a July
file.

This page records what the source looks like and the rules the loader follows. Code:
`src/lib/nadac-sources.ts` (addresses and the listing), `src/lib/nadac-fetch.ts` (downloading),
`src/lib/nadac.ts` (parsing and loading).

## The datasets

data.medicaid.gov runs DKAN. Every dataset has a UUID identifier and a title. Three kinds carry NADAC:

| Title on the site | What it is | Size |
|---|---|---|
| `NADAC (National Average Drug Acquisition Cost)` | the current weekly file, replaced each week | ~25,000 rows, a few MB |
| `NADAC (National Average Drug Acquisition Cost) 2026` | one per calendar year: every weekly file of that year appended, each row with its `as_of_date` | ~1M rows by December, ~100 MB |
| `NADAC Comparison …` | week-on-week changes | not used |

**The yearly dataset gets a new identifier every January.** A loader with the id written into it
works for a year, then fetches nothing — or an old year — and says nothing. So the site reads the
listing and remembers what it found; the typed-in ids in `nadac-fetch.ts` are the fallback.

## The endpoints

```
GET https://data.medicaid.gov/api/1/metastore/schemas/dataset/items?show-reference-ids=false
```
The whole listing as JSON: `[{ identifier, title, modified, distribution: [...] }, …]`. One small
request. The site reads it at most once a week and caches the result in the `nadac_datasets_json`
setting.

```
GET https://data.medicaid.gov/api/1/datastore/query/{id}/0/download?format=csv
```
The whole dataset as one streamed CSV. This is how the weekly file is fetched.

```
GET https://data.medicaid.gov/api/1/datastore/query/{id}/0/download
      ?conditions[0][property]=as_of_date
      &conditions[0][value]=2026-07-15
      &conditions[0][operator]==
      &format=csv
```
One week cut out of a yearly dataset. This is how a single missing week is filled without
pulling the whole year.

```
GET https://data.medicaid.gov/api/1/datastore/query/{id}/0
      ?limit=1&offset=0&count=false&schema=false&keys=true
      &properties[0]=as_of_date&sorts[0][property]=as_of_date&sorts[0][order]=desc
```
The row query. JSON, a few hundred rows a page at most. Used for one thing only: the newest
`as_of_date`. **Never walk a dataset this way** — a week is dozens of calls and a year is
thousands, and that is the pattern that timed out inside a page request and took the site down.

CMS also publishes each week's file as a plain static CSV at
`https://download.medicaid.gov/data/nadac-national-average-drug-acquisition-cost-MM-DD-YYYY.csv`
(the Wednesday of publication). It is tried first because it is the simplest thing that can work;
it is not documented by CMS and is verified only by whether it answers.

## The columns

`NDC Description, NDC, NADAC_Per_Unit, Effective_Date, Pricing_Unit, Pharmacy_Type_Indicator, OTC,
Explanation_Code, Classification_for_Rate_Setting, Corresponding_Generic_Drug_NADAC_Per_Unit,
Corresponding_Generic_Drug_Effective_Date, As of Date`

- `NDC`: eleven digits.
- `NADAC_Per_Unit`: dollars per `Pricing_Unit` (EA, ML or GM), five decimals. Stored as micros.
- `Effective_Date`: when the price took effect; can be earlier than `As of Date` when carried forward.
- `Classification_for_Rate_Setting`: B (brand), G (generic), B-ANDA.
- `Explanation_Code`: 1 survey-calculated; 2 from the same drug's other package/labeler; 3 from a
  comparable drug; 4 carried forward from the previous file; 5 based on package size; 6 adjusted after
  a help-desk review.

The JSON API lower-snake-cases the names (`ndc_description`, `nadac_per_unit`, `as_of_date`, …);
the CSV download keeps CMS's spelling. The parser accepts both.

## Rules the loader follows

1. **Never inside a page request.** Every fetch is a background job (`nadac-job.ts`); the page
   shows progress and returns at once.
2. **Stream, never buffer.** The body goes to disk in chunks; the first chunk must begin with a
   NADAC header or the response is discarded (an HTML error page saved as `.csv` would otherwise
   sit there looking like data). Loading reads a line at a time and inserts a few hundred rows at
   a time, yielding between batches.
3. **Idempotent.** Prices are unique on (NDC, effective date); a file loaded twice adds nothing.
   A downloaded file whose hash is already in the manifest is deleted, not reloaded.
4. **A row is stored only if it parses completely.** Missing price, unit or date is skipped and
   counted, never defaulted.
5. **Never guess an id.** An unknown year returns no address rather than a guessed one.

## What still needs a live check

This environment could not reach data.medicaid.gov, so the following were written from CMS's
published API shape and the addresses the previous NADAC code used, not exercised against the
site. First thing to do on the pharmacy machine, from the NADAC page:

- press **Read the listing now** and confirm it reports a weekly file and a 2026 archive;
- press **Fetch this week** on a gap row and confirm a file loads (the message names which address answered);
- if the plain `download.medicaid.gov` weekly address does not exist, that is fine — the datastore
  addresses are tried next and the message will say so.
