# TAFO

Task around & find out. A personal task list and time-blocking app for one person on their own machine.

TAFO keeps one list across work, home, and personal. **Work / Life / All are view filters, not a security boundary.** Manager access is deferred on purpose: there is no separate work-only login in this MVP.

## What you can do

- Open **Plan** (the default tab) on a dark week grid. Unscheduled tasks sit on the left with an age chip. Drag one onto a day to schedule it, then drag or resize the block. A checkbox marks the linked task done. Click a block for the time, duration, and remove confirmation. Your own drags, resizes, and removes are approved immediately; that default is shown in Settings and can be turned off with `TAFO_HUMAN_EDITS_AUTO_APPROVE=0`. Agent proposals stay pending until you approve or deny them on the grid.
- Add tasks with a domain, status (`todo`, `doing`, `waiting`, `done`), an hour estimate, a due date, notes, and a short checklist. Edit the title and notes afterward; the save sends the version you loaded, and a conflict asks you to reload. Delete a task or a checklist item from the card after a short confirm. Deleting a task also cancels its scheduled calendar blocks.
- Split the list into **Today** and **Backlog**, and order each view by hand.
- Run one timer at a time and see tracked time next to the estimate.
- Edit and copy weekly bullets generated from tasks completed that week.
- Let a local agent drop proposals in a Hermes inbox. Nothing about a task or calendar changes until you approve it. A pending proposal can be edited first. Calendar times can change, and a custom title is used only when you ask for one; otherwise the generic title stays.
- Approving a calendar block queues one outbox operation. Approving again, or retrying, reuses the same ids so the operation is not duplicated.
- Default **demo** mode simulates that operation and labels it as **not synced**. It does not call Google.

## Demo and live calendar

Google Calendar is the write authority for app-owned blocks when you opt into live mode. Until then, `TAFO_CALENDAR_MODE=demo` is the default. That default, with the fictional seed, is the supported local demo. It is not a signed-off live Google integration.

- Demo results use `sync_state: simulated` and say they are **not synced**. They never receive a Google event id.
- Live mode without credentials **fails closed**. The outbox is `failed` / `not synced`. No success is claimed.
- A partial live failure (event created, invitation step failed) stays visible, keeps the Google event id, and retry updates that same event instead of inserting another. A later lookup error keeps that id as well. An empty lookup does not create a second event for the same key.
- If the process dies after the outbox claim and before the result is saved, the row can say `__tafo_processing__`. The next attempt reclaims that claim only when this process is not inside the calendar call and the recorded pid is not still running. It then looks up the stable event key before inserting, so an ambiguous earlier create is not duplicated. A claim that is still in progress is left alone.
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

## Move and delete

These calls are for a person or a cooperative agent on loopback. Send no `X-TAFO-Actor` header, or send `human`. `X-TAFO-Actor: agent` is 403. Every call sends the `expected_version` you last loaded. If that version is stale the response is **409** `version_conflict` (`detail.code`, `detail.message`, and `detail.current_version` when the row still exists). Nothing is reordered or deleted. Load the task or checklist item again and retry with the new version.

| Call | Body or query | 200 | 409 |
| --- | --- | --- | --- |
| `POST /api/tasks/{task_id}/move` | `{"direction":"up"\|"down","view":"all"\|"work"\|"life","scope":"all"\|"today"\|"backlog","expected_version":1}` | The task. If it is already first (`up`) or last (`down`) in that view, the order is unchanged. | Stale `expected_version`, including that no-op edge. The order stays. |
| `POST /api/tasks/{task_id}/delete` | `{"expected_version":1}` | `{"deleted":true,"id":"...","cancellations":[...]}`. The task, its checklist items, and its timer rows are gone. Each scheduled block for that task is cancelled through the outbox, which removes a stored Google event in live mode. | Stale `expected_version`. The task and its events stay. |
| `DELETE /api/subtasks/{subtask_id}?expected_version=1` | query `expected_version` | `{"deleted":true,"id":"..."}` | Stale `expected_version`. The checklist item stays. |

404 means the task is missing, or a move target is not in that view. The OpenAPI page at `/docs` repeats these descriptions.

## Plan the day

Plan is the human path for the week. It reads tasks, blocks, and proposals that already exist. Every block change is still a proposal, then an approval. There is no separate calendar write API.

Quick-add is `POST /api/tasks`. Completing a block is `PATCH /api/tasks/{id}` with `expected_version`. Scheduling, moving, resizing, and removing go through `POST /api/hermes/proposals` (`calendar_block`, `calendar_update`, or `calendar_cancel`, `source_kind: human`) and then the decision route when "My own edits: approved right away" is on. The page sends `X-TAFO-Actor: human` on those decision calls. Omitting that header is not treated as a person.

## Approval trust boundary

Each server launch prints one pairing code to the process console and nowhere else. The page asks for that code. A correct entry sets an HttpOnly `SameSite=Strict` cookie. Approve, deny, and proposal edit then require that cookie and an explicit `X-TAFO-Actor: human`. A missing actor header is not treated as a person. Wrong codes are rate-limited.

**Prevented.** A normal API or agent client, and a client that only forges `Origin` or `Sec-Fetch-Site`, cannot obtain the cookie and cannot approve, deny, or edit. `GET /api/meta` does not set a cookie, including when that GET looks like a browser request with `Sec-Fetch-Site` and no `Origin`. No API response contains the pairing code or the cookie secret.

**Out of scope.** A same-user process that can read the server console, or that can read the browser profile, can take the code or the cookie. This build does not try to stop that.

Keys, with focus outside a text field: `T` today, `W` week, `D` day, `←` `→` move the range (or move a focused block by a day), `↑` `↓` move a focused block 15 minutes, `N` focuses quick-add, `/` focuses find, `A` approves the focused proposal, `X` denies it, `Space` toggles done, `Esc` closes, `Ctrl+Z` undoes the last grid change for 8 seconds.

Run this against a throwaway database. Do not use `start.sh` or `start.ps1`, and do not point `TAFO_DB_PATH` at `data/tafo.sqlite`.

```bash
export TAFO_TEST_DIR="$(mktemp -d -t tafo-preview-XXXX)"
TAFO_DATA_DIR="$TAFO_TEST_DIR" TAFO_DB_PATH="$TAFO_TEST_DIR/tafo.sqlite" \
TAFO_CALENDAR_MODE=demo TAFO_SEED_DEMO=0 TAFO_DISPLAY_TIMEZONE=America/Indianapolis \
TAFO_HOST=127.0.0.1 TAFO_PORT=8787 .venv/bin/python -m tafo
```

In another terminal, `cd frontend && npm run dev`, then open `http://127.0.0.1:5173`. The footer `data-rev` is the git revision the page was built from. Demo calendar writes are simulated and are not sent to Google.

## Hermes inbox

`GET /api/hermes/contract` and the OpenAPI description are the contract. They do not describe the local page session.

- Agents `POST /api/hermes/proposals` with `X-TAFO-Actor: agent` and an `idempotency_key`.
- That call does not change tasks or blocks. `calendar_block`, `calendar_update`, `calendar_cancel`, and `task_change` all stay pending.
- Approve, edit, and reject are only for the local Plan page. See "Approval trust boundary" above. An agent header, a missing actor header, or a call without the browser session gets **403** and the proposal stays as it was.
- The same paths under `/api/hermes/...` return 403.
- Requests that send `X-TAFO-Actor: agent` cannot patch tasks, run timers, edit the week, approve, or restore a backup.
- This header is an integration rule for cooperative agents, not authentication. Anything that can reach the loopback port can still submit proposals.

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

- Plan's Settings list is read-only. Coming-week and work/home rules are not enforced yet. Denying a proposal does not suggest another time.
- Calendar writes in this build are demo simulations. It has not been tested on Windows, and it has not been tested against a live Google calendar.
- No accounts, and no manager view. A role header or `?role=manager` does not hide personal tasks.
- One active timer, up/down ordering rather than drag and drop, no comments, no PERT, no cost model.
- No background worker. The outbox runs on approve and on retry.
- Free/busy chunks that overlap a listed Google event are not split apart.
- All-day Google events are read as UTC dates.
- Demo busy rows are fictional fixtures, not your calendar.
- An invitation can still be declined or blocked by workplace policy. TAFO does not claim otherwise.
