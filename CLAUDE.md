# pharmacy-admin

The admin desk of one independent pharmacy in Kansas. The owner runs the business on it. Two
Claude sessions build it, on two accounts, and they cannot see each other's conversations:

- the **pharmacy session** works on `feature/compliance`, the branch the site runs from;
- the **cloud session** works on `claude/repo-audit-catalog-claims-*` branches and opens a pull
  request against `feature/compliance` for each piece of work.

**At the start of every session, read `docs/HANDOFF.md`, top section "Open items", and the open
pull request from the other session.** That is the whole handshake. Anything either side wants
the other to see goes in one of those two places, never only in a conversation.

Rules that hold on both sides:

- **Code only. Never data.** No PioneerRx reports, invoices, remittances, statements, contracts,
  credentials or database files in git. A feed's *shape* goes in `fixtures/` with every
  identifier changed (`fixtures/README.md`). No patient information anywhere.
- **Nothing is inferred where a document could say it**, and every reader that decides money is
  checked by arithmetic before anything is stored. See `docs/reference/buying-logic.md` and
  `docs/reference/data-audit.md` for the reasoning the site rests on.
- Migrations are additive and numbered; the second session to merge renumbers its own.
- Files the other session has changed on an open branch are listed in `docs/HANDOFF.md`; say so
  on the pull request before editing one.
- `npm run check` (typecheck, tests, build) before pushing. Tests that touch the database need a
  migrated one: `npm run db:migrate` first.
