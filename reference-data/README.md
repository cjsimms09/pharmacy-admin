# Reference data

Payer reference tables collected from the Health Mart Atlas PBM Contract Resources portal.
These ship with the app so a fresh install has them without anything being copied by hand.

| File | What it is | Rows |
|---|---|---|
| `bin_crosswalk.csv` | Every BIN on the HMA listing, with its PBM, sub-network, lines of business, aliases and help desks | 625 |
| `bin_collisions.csv` | The BINs used by more than one PBM — the ones a BIN alone cannot resolve | 60 |
| `pbm_master.csv` | One row per PBM on the listing | 52 |
| `contract_index.csv` | Every contract document known to exist on the portal, whether or not the PDF has been downloaded | 356 |
| `pbm_name_crosswalk.csv` | Maps the network tables' PBM labels to the BIN listing's names | 55 |
| `network_participation.csv` | Published brand and generic rates by network and line of business | 272 |
| `mac_appeals.csv` | How a MAC appeal reaches each PBM, and on whose clock | 55 |
| `payment_routing.csv` | Whether each PBM pays through HMA central pay or direct, and where the remittance lives | 66 |
| `pbm_contacts.csv` | Help desks, MAC mailboxes, credentialing contacts and portals | 103 |
| `communications_index.csv` | The HMA payer notices feed — rate changes and network notices | 925 |

Every row carries the URL it was read from. Nothing here is inferred.

## Loading it

Payers → Run import. It is safe to run again at any time: it replaces rather than duplicates,
and keeps any contract PDFs already matched.

## Refreshing it

When the portal is re-scraped, drop the new CSVs into `data/reference/` on the machine running
the app. Anything there wins over the copy shipped here, so a refresh does not need a code
change. Then run the import again.

## What is deliberately not here

No PHI, no claims, no credentials. This is payer reference material only.
