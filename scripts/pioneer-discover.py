"""
Find the tables PioneerRx keeps a dispensing in, so a report can be written against them.

Why this exists: the daily report the site needs cannot be scheduled out of PioneerRx, and a
report definition cannot be pushed back in. But PioneerRx keeps everything in Microsoft SQL
Server on this pharmacy's own machine, so the report can be built by querying it directly —
once we know what the tables are actually called.

This reads nothing but the catalogue of names. It opens no patient data, writes nothing to the
database, and takes out no lock: every statement is against INFORMATION_SCHEMA, which is the
list of table and column names and nothing else. Its output is safe to send on — it contains
column names, never a value.

Run it once and send the file it writes.

    pip install pyodbc
    python scripts/pioneer-discover.py --server localhost\\PIONEERRX --database PioneerRx

Use a read-only login. If you do not have one, ask PioneerRx support for a read-only SQL user
for reporting — and check your support agreement first, because some vendors treat direct
database access as out of scope.
"""

import argparse, json, sys
from datetime import datetime

# The words that mark a table worth knowing about. A dispensing, what it was billed at, what
# came back, what it cost, and the drug it was.
WORDS = [
    "rx", "prescription", "fill", "dispens", "claim", "adjudicat", "transmit", "third", "party",
    "plan", "payer", "payor", "remit", "reimburs", "basis", "copay", "ndc", "drug", "item",
    "product", "inventory", "cost", "acquisition", "price", "awp", "wac", "nadac", "mac", "gcn",
]

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", required=True, help=r"e.g. localhost\PIONEERRX")
    ap.add_argument("--database", required=True, help="e.g. PioneerRx")
    ap.add_argument("--user", help="SQL login; omit to use Windows authentication")
    ap.add_argument("--password")
    ap.add_argument("--out", default="pioneer-schema.json")
    a = ap.parse_args()

    try:
        import pyodbc
    except ImportError:
        print("pyodbc is not installed. Run:  pip install pyodbc", file=sys.stderr)
        return 1

    auth = f"UID={a.user};PWD={a.password};" if a.user else "Trusted_Connection=yes;"
    for driver in ("ODBC Driver 18 for SQL Server", "ODBC Driver 17 for SQL Server", "SQL Server"):
        try:
            cn = pyodbc.connect(
                f"DRIVER={{{driver}}};SERVER={a.server};DATABASE={a.database};{auth}"
                "TrustServerCertificate=yes;ApplicationIntent=ReadOnly;",
                timeout=15, readonly=True,
            )
            break
        except Exception as e:  # noqa: BLE001 — try the next driver, report the last failure
            last = e
    else:
        print(f"Could not connect with any ODBC driver. Last error:\n{last}", file=sys.stderr)
        return 1

    cur = cn.cursor()
    cur.execute("""
        select TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE
        from INFORMATION_SCHEMA.COLUMNS
        order by TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
    """)
    tables: dict[str, list[dict[str, str]]] = {}
    for schema, table, column, dtype in cur.fetchall():
        tables.setdefault(f"{schema}.{table}", []).append({"column": column, "type": dtype})

    def wanted(name: str, cols: list[dict[str, str]]) -> bool:
        hay = (name + " " + " ".join(c["column"] for c in cols)).lower()
        return any(w in hay for w in WORDS)

    kept = {t: c for t, c in tables.items() if wanted(t, c)}
    out = {
        "takenAt": datetime.now().isoformat(timespec="seconds"),
        "database": a.database,
        "tablesInDatabase": len(tables),
        "tablesKept": len(kept),
        "note": "Column names only. No row was read and nothing was written.",
        "tables": kept,
    }
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    print(f"{len(tables)} tables in the database; {len(kept)} look relevant.")
    print(f"Written to {a.out} — send that file back.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
