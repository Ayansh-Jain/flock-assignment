# Decisions & assumptions

A running log of the calls I made while building this, roughly in the order I made them. Some I decided up front, some I only settled after seeing how the portal actually behaved, and a few are still just assumptions I never got to confirm — I've tried to be honest about which is which.

## Phase 1 — the big calls

These are the ones I locked in early, after poking at the portal in DevTools.

1. **What counts as "the list of meters":** the search endpoint (`/portal/meters/search`, 403 meters). The bulk export has richer data, but search is the authority on which meters exist. The export only fills in extra detail for the meters it happens to cover; anything it doesn't cover gets `hierarchy: null`. I decided not to try rebuilding the upper hierarchy levels from `dtCode` for now — it's a maybe-later.
2. **The export signature:** I worked it out by reading the portal's own frontend code rather than guessing (details in protocol-notes). The signing key is fetched fresh from `/portal/keys` each time and never stored.
3. **Hierarchy:** comes from the export when it's there, otherwise `null`.
4. **Daily consumption:** group the readings by IST day; a day's usage is its last reading minus the previous day's last reading, since the meter values are running totals. The first reading lands at 23:30, so the first day has nothing to compare against, and any incomplete day at the ends gets skipped rather than reported as a wrong number. This needs explaining in the API docs.
5. **Timezone:** treat the timestamps as IST and hand them back as ISO-8601 with `+05:30`.
6. **Units:** expose `kwh`/`kvah` as numbers; the OpenAPI description notes the unit is an assumption (kWh/kVAh).
7. **Sessions:** if a call comes back 401, log in once more and retry. I didn't dig into cookie flags or exact session lifetime — the re-login covers it either way.
8. **Export paging:** the sync pages the export itself (page 2, 3, ...), one signed request per page with a fresh timestamp, and with a hard cap on pages so it can't run away.
9. **Dependencies:** `tough-cookie` is the one I added (pinned at 6.0.2). `npm audit` came back clean.
10. **Commits:** `Co-Authored-By: Ayansh Jain`, no Claude line. I commit and push myself.
11. **Fixtures:** no `__data.json` fixture — the hierarchy comes from the export, so I don't need it.

### Things I assumed in Phase 1 (and never fully checked)


- Those two fields are running totals, not per-reading usage.
- The export page is bigger than 20 rows and there may be more pages (the UI never loops, so I couldn't tell from it).
- The clean 8-day energy window with no gaps was what I saw on the meter(s) I checked, and I assumed it holds for all of them. (This one turned out to be slightly wrong — see mistakes.md.)

## Phase 2 — the portal client and parsers

These were all my calls while writing the client; none of it is dictated by the portal.

- **Timeouts:** each attempt gets `AbortSignal.timeout` (20 s by default, which also covers reading the body). Config is validated at startup and then frozen.
- **What gets retried:** only timeouts, network blips, 5xx and 429 — up to 3 times, with exponential backoff and jitter (250 ms base, 5 s ceiling). Other 4xx are never retried. If it still fails after the last try, it throws `PortalUnavailable`.
- **429s:** wait for `Retry-After` if the header's there (capped at 30 s), otherwise just back off normally.
- **When to re-login:** only on a `/portal/*` call that returns 401 with the portal's `{"error":"unauthorized"}` body. I reset the cookies, log in once (shared across any requests waiting), and retry once; a second 401 gives up with `PortalAuthError`. There's a small generation counter so a burst of expired requests triggers one reset, not a pile of them.
- **Deciding if login worked:** from the response body (`type: "redirect"`), not the HTTP status. The error message deliberately never includes the response body, because the failure body echoes the email back.
- **Concurrency:** one `p-limit` wraps each logical request (login and retries included), default 3, max 4 — the ground rule was to stay between 2 and 4 against a shared system.
- **Signing the export:** per the Phase 1 scheme. The key is fetched from `/portal/keys` on every export call (not cached) and the signature is recomputed per attempt, so a retry after a backoff carries a fresh timestamp. Neither the key nor the signature is ever logged.
- **Timestamps:** parsed strictly as `DD/MM/YYYY HH:mm`, real dates only, output as `...+05:30`. The parser sorts readings into chronological order.
- **Daily consumption (tightening the Phase 1 rule):** a day is only reported if it ends at 23:30 and the previous day also ends at 23:30. So the first day (no anchor) never shows up, and any day whose previous day is missing is skipped. *(Originally flagged for the author to confirm — now settled, see the Phase 2 review below: a day where the register goes backwards is skipped too.)* Differences are rounded to 2 decimals to get rid of floating-point noise.
- **Strict vs forgiving:** every parser throws `PortalParseError` on a shape it doesn't expect. For the export that meant one bad row would fail the whole page — I only had 3 export rows to look at, so I kept it strict and left a note to revisit in Phase 3 once I'd seen the full dataset.
- **Geo:** the export's `{lat, lng}` and the `/geo` endpoint's `{latitude, longitude}` both get normalised to `{latitude, longitude}` numbers.
- **Config odds and ends:** `PORTAL_BASE_URL` is checked with a regex because env-schema has no `uri` format. `process.loadEnvFile()` only runs when no override is passed in. ESLint is told to allow it, since the rule flags it below Node 22.21 even though `>=22` runs it fine.
- **Test glob:** `npm test` runs `node --test "test/**/*.test.js"` rather than bare `node --test`, so `test/helpers.js` isn't picked up as a test.
- **Tests use undici's own `fetch`** (injected via `fetchImpl`) with a `MockAgent`, so the real network is never reachable and I didn't have to monkey-patch Node's global fetch.

### Still unverified after Phase 2

- What `/geo` and `/energy` do for a meter that doesn't exist (I assume 404 → `PortalNotFound`, but never saw it).
- A 403 on `/portal/*` is treated as an auth problem — also never observed.
- How export paging really behaves (see protocol-notes, open questions).

## Phase 2 review — author's calls (these win over the matching proposals above)

- **Negative daily totals — settled.** A day where the register goes backwards (a reset or meter swap) is skipped, not reported, and the skip is visible rather than silent: `deriveDailyConsumption` returns `{ days, skipped }`, where each skip is `{ date, reason }` with reasons `register_decreased`, `missing_previous_day` and `incomplete_day`. The expected edges (the first date, and a final date that stops before 23:30) aren't listed as skips. Phase 3 has to surface the skipped count on the response and/or log it.
- **Bad export rows — settled.** `parseExport` now skips a bad *row*, keeps going, and returns `skipped: { count, samples }` (up to 5 samples, each with the row index, the `meterId` if it's readable, and the reason — never the raw value). A broken *envelope* (not an object, `data` not an array, bad `total`) still throws. The Phase 3 sync summary has to include these counts. The single-meter parsers (search, geo, energy, transformers) stay strict and throw.
- **Export paging — settled.** "The export might fit in one page (~231 KB)" stays a recorded assumption. The sync still pages defensively with a cap, and search (403) remains the authority on the meter list.
- **Assumptions kept as-is:** 404 → `PortalNotFound`, 403 → `PortalAuthError`; `process.loadEnvFile` allowed in the lint config instead of bumping `engines`.
- **Docs to write:** PROTOCOL.md needs to explain why the energy series gives 7 daily totals (24–30 Jun) — because the first reading is at 23:30 on the 23rd.
- **Housekeeping:** `notes/` added to `.prettierignore` so my prose doesn't get reflowed. I didn't rewrite the existing notes.

## Phase 3 — service layer, routes, OpenAPI

Mine unless I say otherwise.

- **limit/offset over the portal's pages.** The portal pages by 20 (confirmed for search and dts). The service always grabs upstream page 1 first (it carries `total` and lets me sanity-check `pageSize === 20`), then only the extra pages the window needs, and never past the last page — I never saw what the portal does beyond the end. Cost-wise: an offset past the end is one call; any offset ≥ 20 costs one extra (page 1). If the upstream page size ever changes it throws `PortalParseError` instead of silently mis-slicing. `limit` defaults to 50, caps at 200 (at most 11 upstream pages).
- **The list wrapper is `{ data, total, limit, offset, fetched_at }`**, not `{ page, pageSize }` like the brief suggested — our API pages by limit/offset, so echoing page numbers would just mislead.
- **Field names follow the parsers.** So `geo` is `{ latitude, longitude }` (the brief said `{lat, lng}`; the parser normalises the export's `lat/lng`). `fetched_at` and `request_id` are snake_case as asked, which means the naming is intentionally mixed — camelCase for fields that come from the portal, snake_case for fields we add. Easy to unify later if it bugs anyone.
- **The daily series** also carries `kvah` (the parser returns both), plus `skippedDays` (a count) and `skipped` (the `{date, reason}` list), and the service logs a warning whenever it skips days.
- **`installType`, `build`, `hierarchy` are `null`, not left out,** when a meter isn't in the export — keeps the response shape stable.
- **Meter detail talks to the portal four times** *(this "no cache" note is superseded by the Phase 3 follow-up below — a 60-second memo was added).* Originally: search (exact-id check), `/geo`, `/portal/keys` and the full export pull, with the ~230 KB export fetched on every detail request. `loadExportIndex()` in src/service.js was left as the seam for caching, which is exactly where the memo went.
- **If the export falls over, detail degrades instead of failing.** A `PortalUnavailable` or `PortalParseError` on the export still returns the meter with `hierarchy: null` and a logged warning (the caller can't tell *why* it's null, which isn't ideal). A `PortalAuthError` still fails the whole request.
- **Export paging in the service:** capped at 10 pages; stops when it's seen `total` rows, hits an empty page, or sees a repeated page with no new meter ids (warning "export may be incomplete" in the last two). Bad rows are skipped and logged as a count plus 5 samples, per the Phase 2 decision.
- **Finding an unknown meter:** via search, matching the id exactly and case-sensitively (search itself is partial). Only the detail route checks this; `/consumption` and `/consumption/daily` lean on the portal's 404 for `/energy`, which is still an unconfirmed assumption.
- **Error mapping** (always the one shape `{ error: { code, message, request_id } }`, fixed messages, nothing from upstream leaked): validation → 400 `invalid_request` naming the field; `PortalNotFound` → 404 `meter_not_found`; unknown route → 404 `route_not_found`; a `PortalUnavailable` caused by a timeout → 504 `portal_timeout`; other `PortalUnavailable` → 502 `portal_unavailable`; `PortalParseError` → 502 `portal_bad_response`; other `PortalError` → 502 `portal_error`; `PortalAuthError` → 503 `portal_auth_failed` (our credentials, not the caller's); anything else → 500 `internal_error`. 4xx log at warn, 5xx at error; stack traces only ever go to the logs.
- **`/health` always returns 200** while the process is alive; it reports the portal separately as `status: "degraded"` / `portal: "unreachable"`. It makes one cheap read-only call (dts page 1) each time, so don't aim a high-frequency prober at it without a cache.
- **On purpose: no auth on our API.** Anyone who can reach the port can read portal data through our credentials, so it binds to 127.0.0.1 by default. In production I'd put it behind a gateway with an API key or OAuth, TLS, per-client rate limits and quotas so the shared portal isn't hammered.
- **No CORS** until something actually needs it.
- **Config:** `NODE_ENV` added (default `production`); pino-pretty only kicks in when it's `development`. The `dev` script is `node --watch src/server.js` — set `NODE_ENV=development` in `.env` for readable logs.
- **OpenAPI:** components are named off each schema's `$id`; `src/openapi.js` builds the document and is shared by the export script and the drift test. `openapi.json` is generated, so it's in `.prettierignore`.
- **The meter id parameter** must match `^[A-Za-z0-9_-]{1,32}$` (assumed from `J100001`); anything else gets a 400 without ever touching the portal.

## Phase 3 follow-up — the export memo

- **A short in-memory copy of the export (this replaces the "no cache" note above).** `loadExportIndex()` now keeps one entry for 60 seconds (`EXPORT_MEMO_TTL_MS`, overridable via `exportTtlMs`). Callers arriving together share a single pull, a failed pull is never kept, and there's no invalidation or cross-process sharing — so data can be up to 60 s stale, and a changed meter's hierarchy likewise. Memory stays bounded by the dataset (at most 10 export pages). The upshot: after the first detail request in a given minute, detail only costs search + `/geo`. A proper per-endpoint cache with a real freshness policy is still a Phase 5 extension.
- **README needs to say** `/health` makes a live portal call (dts page 1) every time, so don't point a fast prober at it. (Phase 4.)
- **Also for Phase 4 docs:** the 7-day / 23:30 explanation in PROTOCOL.md; the shutdown path I wrote but never ran; and the portal behaviours I never observed (past-the-end paging, `/energy` 404 for an unknown meter, 403s).

## Phase 4 — documentation

- PROTOCOL.md and README.md are written from these notes and from the real Phase 3 sample outputs (generated from the fixtures through the real routes with a stubbed portal client — and the README says so).
- The "session lasts about an hour" line comes from the author's Phase 4 brief, not from anything I captured, so PROTOCOL.md flags it as reported-but-unverified.
- `.gitattributes` forces LF line endings so the OpenAPI drift test stays stable on Windows checkouts.