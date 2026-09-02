# Running the app on the pharmacy computer

The first version runs **only on the computer it is installed on**. Nothing is exposed to the internet; you open it in a browser on that machine. Access from your phone comes later, behind Cloudflare Access, once the hosting decision is made.

## One-time setup (about 10 minutes, once per computer)

1. Install **Node.js LTS** from https://nodejs.org (version 20 or newer). Accept the defaults.
2. Install **Git** from https://git-scm.com (or `winget install Git.Git` in PowerShell). Accept the defaults.
3. Open PowerShell and run these two lines (a GitHub sign-in window will appear the first time):

```powershell
cd $HOME
git clone https://github.com/cjsimms09/pharmacy-admin
```

That's the last command you need. Everything else happens in the app.

## Starting the app

Open the `pharmacy-admin` folder (This PC → C: → Users → your name → pharmacy-admin) and double-click **Start Pharmacy Admin**. The first start takes a few minutes (it installs and builds), then the browser opens by itself. The first screen asks you to create the owner login.

Keep the black window open while you use the app. Closing it stops the app.

**Optional — always on:** double-click **Install autostart** once, and the app starts hidden every time you sign in to Windows. Then just open http://localhost:3000 whenever you need it.

The launcher creates the secrets file (`.env`) automatically on first run. **Back it up** together with the `data` folder (Settings → Backups explains).

## Updating

Settings → Updates → **Check for updates** → **Install and restart**. The app pulls the new version from GitHub, rebuilds, and restarts itself in one to three minutes.

## Where the data lives

- `data/pharmacy-admin.db` — the database (staff, licenses, incidents, summaries, audit log)
- `data/files/` — uploaded documents

Both are inside the `data/` folder, which is ignored by git and never leaves the machine. Back up the `data/` folder and your `.env` file together (an encrypted external drive or the pharmacy's existing backup). The database uses SQLite; copying the folder while the app is stopped is a complete backup.

## Adding logins for staff

Settings → Logins → Add login (owner only). Roles:

- **Owner** — everything, including creating logins.
- **PIC** — compliance, CQI, documents, staff records.
- **Staff** — sees only their own staff record and documents.

## Printing Board forms

Every Board form page (C-550, C-650, C-900) opens as a print-ready page. Use the browser's Print (Ctrl/Cmd+P), choose "Save as PDF" or a printer, sign the paper copy, then scan and attach the signed copy on the summary or incident page so the five-year record is complete.

## Connecting Claude (optional)

Settings → Claude → paste an Anthropic API key (from console.anthropic.com → API keys) → Save and test. The key is stored encrypted in the database and never displayed again. With it on file:

- **CQI program → Import packets with Claude** reads a scanned C-550/C-650 packet and proposes incidents, corrective action plans, and CAP reviews for you to check and save.
- On an incident, **Draft RCA & CAP with Claude** fills empty root-cause and corrective-action fields from your description.
- On a draft summary, **Draft CAP evaluations with Claude** writes the effectiveness comments from what's on record.

Prescription numbers and staff names are redacted from text sent for drafting. Scanned packets are sent as-is (they contain Rx numbers and staff names, never patient identities). Every call is written to the audit log with token counts. Anthropic does not train on API data; a Business Associate Agreement is available from Anthropic on request if you ever want one on file.
