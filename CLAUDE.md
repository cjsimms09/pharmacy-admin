# pharmacy-admin

The admin desk of one independent pharmacy in Kansas. The owner runs the business on it. Two
Claude sessions build it, on two accounts, and they cannot see each other's conversations:

- the **pharmacy session** works on `feature/compliance`, the branch the site runs from;
- the **cloud session** works on `claude/repo-audit-catalog-claims-*` branches and opens a pull
  request against `feature/compliance` for each piece of work.

**Only a session running on the pharmacy computer can see real data.** A cloud session's network
reaches GitHub and a few package registries and nothing else — no tunnel, no address, no hosted
copy of this site is reachable from one, and that was established by measurement after a tunnel had
already been built and opened. So any question that needs the real database, the real screens or
the real files belongs to the machine session, and the cloud session must hand it over through
`docs/HANDOFF.md` rather than asking the owner to ferry files. Start Claude on that computer by
double-clicking **Work on this with Claude.cmd**.

**At the start of every session, read `docs/HANDOFF.md`, top section "Open items", and the open
pull request from the other session.** That is the whole handshake. Anything either side wants
the other to see goes in one of those two places, never only in a conversation.

Rules that hold on both sides:

- **Code only. Never data.** No PioneerRx reports, invoices, remittances, statements, contracts,
  credentials or database files in git. A feed's *shape* goes in `fixtures/` with every
  identifier changed (`fixtures/README.md`). No patient information anywhere.
- **Nothing is inferred where a document could say it**, and every reader that decides money is
  checked by arithmetic before anything is stored. Every figure has one meaning, one unit and a
  list of what it must never be used for: `docs/reference/data-dictionary.md`. The reasoning is
  in `docs/reference/buying-logic.md`, `data-audit.md` and `profit-engine.md`; the site's design
  rules and page inventory are in `docs/reference/design-audit.md`; what is read from a contract,
  why, and where it goes is `docs/reference/contract-reading.md`.
- Migrations are additive and numbered; the second session to merge renumbers its own.
- Files the other session has changed on an open branch are listed in `docs/HANDOFF.md`; say so
  on the pull request before editing one.
- `npm run check` (typecheck, tests, build) before pushing. Tests that touch the database need a
  migrated one: `npm run db:migrate` first.
