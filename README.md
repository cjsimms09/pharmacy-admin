# pharmacy-admin

Private operations desk for an independent pharmacy: purchasing optimization,
Kansas compliance tracking, and third-party payment reconciliation.

The full design and roadmap is in [`docs/PLAN.md`](docs/PLAN.md).

## Rules of this repository

1. **Code only. Never data.** No contracts, price files, PioneerRx reports,
   remittance files, credentials, or database dumps — ever. `.gitignore`, the
   pre-commit hook, and CI all enforce this. Synthetic samples live under
   `fixtures/` and are clearly fake.
2. **No patient information anywhere.** The application is designed to reject
   it at ingestion; the repository must never contain it, including in tests.
3. **Secrets live in the production secret store**, never in source. Copy
   `.env.example` to `.env` for local development (git-ignored).
4. **`main` is protected.** Work happens on branches and lands by pull request.

## Running it at the pharmacy

See [`docs/RUNNING.md`](docs/RUNNING.md): clone once, then double-click **Start Pharmacy Admin**. Updates install from Settings → Updates.

## Developer setup

```bash
git clone <this repo> ~/pharmacy-admin
cd ~/pharmacy-admin
scripts/setup-hooks.sh          # enables the secret / data-file pre-commit check
cp .env.example .env            # then fill in local values
mkdir -p ~/PharmacyPrivate      # real documents live here, outside the repo
```

Claude Code is denied read access to `.env*`, data folders, and
`~/PharmacyPrivate/` via `.claude/settings.json`.
