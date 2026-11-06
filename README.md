# TAFO

Task around & find out. A personal task list and time-blocking app for one person on their own machine.

TAFO keeps one list across work, home, and personal. **Work / Life / All are view filters, not a security boundary.** Manager access is deferred on purpose: there is no separate work-only login in this MVP.

## What you can do

- Add tasks with a domain, status (`todo`, `doing`, `waiting`, `done`), an hour estimate, a due date, notes, and a short checklist. Edit the title and notes afterward; the save sends the version you loaded, and a conflict asks you to reload.
- Split the list into **Today** and **Backlog**, and order each view by hand.
- Run one timer at a time and see tracked time next to the estimate.
- Edit and copy weekly bullets generated from tasks completed that week.
- Let a local agent drop proposals in a Hermes inbox. Nothing about a task or calendar changes until you approve it. A pending proposal can be edited first. Calendar times can change, and a custom title is used only when you ask for one; otherwise the generic title stays.
- Approving a calendar block queues one outbox operation. Approving again, or retrying, reuses the same ids so the operation is not duplicated.
- Default **demo** mode simulates that operation and labels it as **not synced**. It does not call Google.

## Demo and live calendar

Google Calendar is the write authority for app-owned blocks when you opt into live mode. Until then, `TAFO_CALENDAR_MODE=demo` is the default.

- Demo results use `sync_state: simulated` and say they are **not synced**. They never receive a Google event id.
- Live mode without credentials **fails closed**. The outbox is `failed` / `not synced`. No success is claimed.
- A partial live failure (event created, invitation step failed) stays visible, keeps the Google event id, and retry updates that same event instead of inserting another. A later lookup error keeps that id as well. An empty lookup does not create a second event for the same key.
- Work blocks can ask Google to invite the address in `TAFO_WORK_INVITE_EMAIL`. The proposal cannot name an address. This is a normal calendar invitation so Outlook can show that one meeting. It does **not** read Outlook, and it does not bypass workplace policy.
- Busy time is read before a calendar proposal is stored. Fixed appointments are not moved unless you approve that change and send `acknowledge_fixed_move`.
- Availability is **not conflict-free**. Invite-only integration does not reveal existing Outlook meetings.

Get employer permission before storing work information here or writing work details to a personal Google calendar. Titles default to generic labels (`Focus block`, `Home block`, `Personal block`).

## Runtime data

SQLite, backups, `.env`, and Google credential files stay out of git.

| Item | Where it lives |
| --- | --- |
| Database | `TAFO_DATA_DIR` / `tafo.sqlite` (default `./data/tafo.sqlite`) |
| JSON backups | `./data/backups/` |
| Settings | `.env` copied from `.env.example` |
| Google OAuth file | path you set in `TAFO_GOOGLE_CREDENTIALS_FILE` |

Times are stored in UTC. Due dates are calendar dates. The display timezone defaults to `America/Indianapolis`.

The API binds to `127.0.0.1` unless you set `TAFO_ALLOW_LAN=1`. There is no authentication. Do not expose it on a LAN.

## Windows setup

From the repository root, in PowerShell:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python -m pip install -e ".\backend[dev]"
Copy-Item .env.example .env
.\.venv\Scripts\python -m tafo
```

In a second window:

```powershell
cd frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. API docs are at `http://127.0.0.1:8787/docs`.

`start.ps1` creates the venv, installs dependencies, and opens both processes. Docker is not required.

On macOS or Linux, `./start.sh` does the same in one terminal.

## Live Google setup

Leave demo mode on until you mean to write a real calendar. Then, only on that machine:

1. Put an authorized-user JSON file outside the repo (Calendar scope `https://www.googleapis.com/auth/calendar`).
2. Set `TAFO_CALENDAR_MODE=live`, `TAFO_GOOGLE_CREDENTIALS_FILE`, and `TAFO_GOOGLE_CALENDAR_ID`.
3. Optionally set `TAFO_WORK_INVITE_EMAIL`.
4. Install the live extra if you need token refresh: `pip install -e "backend[live]"`.

The adapter creates, updates, and cancels only events it tagged with `tafoEventKey`. Retries look up that key before inserting. Tests use a fake transport and do not call Google.

## Hermes inbox

`GET /api/hermes/contract` and the OpenAPI description are the contract.

- Agents `POST /api/hermes/proposals` with `X-TAFO-Actor: agent` and an `idempotency_key`.
- That call does not change tasks or blocks.
- A person approves, edits, or rejects at `/api/decisions/{id}/...` with `confirmed: true`.
- The same paths under `/api/hermes/...` return 403.
- Requests that send `X-TAFO-Actor: agent` cannot patch tasks, run timers, edit the week, approve, or restore a backup.
- This header is an integration rule for cooperative agents, not authentication. Omitting it, or sending `human`, does not prove who the caller is. Anything that can reach the loopback port can mutate data.

Approving a calendar proposal inserts one outbox row. A second approval returns that row. `POST /api/calendar/outbox/{id}/retry` processes it again with the same event key.

## Backup

- `GET /api/admin/export` returns a `tafo-backup` JSON snapshot.
- `POST /api/admin/backup` writes a file under `data/backups/`.
- `POST /api/admin/restore` with `{"confirm":"REPLACE_LOCAL_DATA","snapshot":...}` replaces local rows.
- Schema changes ship as numbered SQL files in `backend/tafo/migrations/` and are applied on startup.

## Tests

```powershell
cd backend
..\.venv\Scripts\python -m pytest
cd ..\frontend
npm run typecheck
npm run build
```

Covered: task CRUD and filters, timers, weekly bullets, approval gates, optimistic concurrency, duplicate outbox and retry, demo versus live (including no network in demo and fail-closed live), mirror dedupe, fixed appointments, backup, migrations, and the deferred manager response.

## Known gaps

- No accounts, and no manager view. A role header or `?role=manager` does not hide personal tasks.
- One active timer, up/down ordering rather than drag and drop, no comments, no PERT, no cost model.
- No background worker. The outbox runs on approve and on retry.
- Free/busy chunks that overlap a listed Google event are not split apart.
- All-day Google events are read as UTC dates.
- Demo busy rows are fictional fixtures, not your calendar.
- An invitation can still be declined or blocked by workplace policy. TAFO does not claim otherwise.
