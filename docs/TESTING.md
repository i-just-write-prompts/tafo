# Testing saves

A toast or banner that says something was saved has to be checked against a server read in the same test. The helper is `frontend/e2e/helpers/saveClaim.ts`.

- `matches-server` reads `/api/calendar/blocks` and `/api/hermes/proposals` and checks the toast text against those rows.
- `forced-failure` does the same after a calendar write was forced to fail. The toast names the item, and the server still has the old time.
- `failure-then-retry` checks the failed state, runs the retry, then checks the server again.

Do not claim a save from the on-device draft alone. A commit response can clear saved items before the confirmation read returns. `frontend/src/v3/saveClaimRule.test.ts` fails an e2e toast text assertion that does not go through `checkSaveClaim`. A `failure-then-retry` claim has to re-check every id from the failed claim.

## Stable hooks

The review sheet is `review-sheet`. Approve all is `approve-all`. Each row is `plan-item-<id>` and carries `data-title` (`Spec review`, `Budget sheet`, `Fix closet door`). The Spec block is `block-blk_v3_spec`.

## Forcing a calendar write to fail

Only when `TAFO_E2E=1` and calendar mode is demo. A default `python -m tafo` and the preview do not register the route (404). Live mode does not register it either. The Playwright server sets `TAFO_E2E=1`.

```bash
curl -s -X POST http://127.0.0.1:8787/api/e2e/fail-writes \
  -H 'Content-Type: application/json' \
  -d '{"event_keys":["blk_v3_spec"]}'
```

`event_keys` fails the next update of those blocks. `{"fail_creates":1}` fails the next create. Each armed failure is used once. The Playwright server’s `POST /api/e2e/reset` clears both and reloads the demo week. The method is POST. GET returns 405 with `Allow: POST`.

`POST /api/e2e/reset` exists only on `scripts/e2e_server.py` (the Playwright server), and only for a throwaway database. It is not on a normal `python -m tafo` process and not on the preview. If that POST returns 405 with `Allow: GET, HEAD`, the request hit the static UI mount instead of the route. The route is registered ahead of the mount so that does not happen on the Playwright server. Reseed a preview by restarting it. A preview still requires the preview password, the same as every other route.
