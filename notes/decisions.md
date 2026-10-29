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


### Things I assumed in Phase 1 (and never fully checked)


- Those two fields are running totals, not per-reading usage.
- The export page is bigger than 20 rows and there may be more pages (the UI never loops, so I couldn't tell from it).


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

### Still unverified after Phase 2

- What `/geo` and `/energy` do for a meter that doesn't exist (I assume 404 → `PortalNotFound`, but never saw it).
- A 403 on `/portal/*` is treated as an auth problem — also never observed.
- How export paging really behaves (see protocol-notes, open questions).

## Phase 2 review — author's calls (these win over the matching proposals above)

- **Negative daily totals — settled.** A day where the register goes backwards (a reset or meter swap) is skipped, not reported, and the skip is visible rather than silent: `deriveDailyConsumption` returns `{ days, skipped }`, where each skip is `{ date, reason }` with reasons `register_decreased`, `missing_previous_day` and `incomplete_day`. The expected edges (the first date, and a final date that stops before 23:30) aren't listed as skips. Phase 3 has to surface the skipped count on the response and/or log it.
- **Bad export rows — settled.** `parseExport` now skips a bad *row*, keeps going, and returns `skipped: { count, samples }` (up to 5 samples, each with the row index, the `meterId` if it's readable, and the reason — never the raw value). A broken *envelope* (not an object, `data` not an array, bad `total`) still throws. The Phase 3 sync summary has to include these counts. The single-meter parsers (search, geo, energy, transformers) stay strict and throw.
- **Export paging — settled.** "The export might fit in one page (~231 KB)" stays a recorded assumption. The sync still pages defensively with a cap, and search (403) remains the authority on the meter list.

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
.

## Phase 3 follow-up — the export memo

- **A short in-memory copy of the export (this replaces the "no cache" note above).** `loadExportIndex()` now keeps one entry for 60 seconds (`EXPORT_MEMO_TTL_MS`, overridable via `exportTtlMs`). Callers arriving together share a single pull, a failed pull is never kept, and there's no invalidation or cross-process sharing — so data can be up to 60 s stale, and a changed meter's hierarchy likewise. Memory stays bounded by the dataset (at most 10 export pages). The upshot: after the first detail request in a given minute, detail only costs search + `/geo`. A proper per-endpoint cache with a real freshness policy is still a Phase 5 extension.
- **README needs to say** `/health` makes a live portal call (dts page 1) every time, so don't point a fast prober at it. (Phase 4.)
- **Also for Phase 4 docs:** the 7-day / 23:30 explanation in PROTOCOL.md; the shutdown path I wrote but never ran; and the portal behaviours I never observed (past-the-end paging, `/energy` 404 for an unknown meter, 403s).

## Phase 4 — documentation

- PROTOCOL.md and README.md are written from these notes and from the real Phase 3 sample outputs (generated from the fixtures through the real routes with a stubbed portal client — and the README says so).
- The "session lasts about an hour" line comes from the author's Phase 4 brief, not from anything I captured, so PROTOCOL.md flags it as reported-but-unverified.
- `.gitattributes` forces LF line endings so the OpenAPI drift test stays stable on Windows checkouts.
## Phase 5B — network hierarchy

- **Tree from the export, not from /dts.** `src/hierarchy.js` (pure) unions the 7-level chain on every export row. Nodes are keyed by normalised code (trim + upper-case) because the API addresses a node by code alone; raw spellings are kept as `aliases`. The tree only covers meters that are in the export, which is documented in PROTOCOL.md and the README.
- **First-seen wins, nothing dropped.** A code under a second parent, with a second name, or at a second level is reported and the first placement is kept. A level conflict (the only way a cycle could arise) means the row cannot be placed: the meter goes to `unplaced` and is reported. Tree walks have a visited set and a depth bound anyway.
- **Only the issue kinds I could design for are covered, none seen in real data.** The saved export fixture has 3 clean rows. The messy-data handling is tested on hand-built input only; the full 403-row export is unchecked.
- **`meter_not_in_export` is only computed by `/v1/network/issues`**, because it needs every meter id from portal search (about 21 calls, sequential, bounded to 25 pages, memoised 60 s). The tree endpoints do not pay for it. This is the one place I went beyond "export + /dts"; if you would rather not, drop it and compare totals only.


## Phase 5A — bulk sync and local SQLite index

- **Driver: `node:sqlite`, no new dependency.** You chose it over `better-sqlite3`. It is built in (no native build, no lockfile change) but experimental: Node prints a startup warning and the API may change. `engines` is now `>=22.13`, the first release where it needs no flag (checked on 22.13.0 here). Lint needed no change (`allowExperimental` was already on).
- **One export puller for two callers.** The paging guard moved out of `service.js` into `src/export-pull.js` and both the 60 s request memo and `npm run sync` use it. Signing was not touched. Existing service tests pass unchanged. `pullExport` now logs an info line per page.
- **Sync writes, never deletes.** It upserts and records a `sync_runs` row (ok / incomplete / failed). I did not prune meters missing from a pull because a skipped bad row would look like a deletion; the cost is that removed meters linger. Documented.
- **Status words.** `ok` = the pull reached `total`; `incomplete` = the repeat/cap guard stopped it (data is stored, exit code 2); `failed` = it threw. `synced_at` is the finish time of the last `ok` or `incomplete` run.
- **Index routes are opt-in per request.** `GET /v1/meters` goes live unless one of make, phaseType, installStatus, installType, build, dtCode, zone or feeder is present; then it answers from the index. This changes the *source* of the data depending on the query string, so every list now carries `source` (`portal` or `index`), and index answers carry `synced_at`. `source` is a new required field on `MeterList` (it was added to the live path too). The network meter list says `portal` because it comes from the live export memo.
- **Never-synced index = 503 `index_not_synced`** (not an empty 200), so an empty result is never confused with "nobody has synced yet". `/v1/sync/status` still answers 200 with nulls.
- **The database opens lazily on first index request,** creating `data/` if needed, so the OpenAPI export and most tests never touch a file. Queries use the synchronous `node:sqlite` API inside request handlers: fast on this data size, but it blocks the event loop while it runs.
- **Filters** are exact and case-insensitive; code filters are trimmed and upper-cased like the tree. `q` is a case-sensitive substring (the live search's case behaviour is unknown). The only SQL built from strings joins constant fragments; all values are bound parameters (a test sends a quote-injection value).
- **`near`:** `radius_km` default 5, max 500, `lat`/`lon` required. Bounding box in SQL (handles the antimeridian and the poles), exact haversine in JS, nearest first, ties by meterId, `distance_km` rounded to 3 decimals. The paging total is the count inside the radius.
- **Data-quality summary in sync** reuses `buildNetwork` with an empty transformer list and drops `dt_not_in_transformers`, so it makes no extra portal calls. The transformer cross-check and search-vs-export check stay in `/v1/network/issues`.
- **Not verified:** I did not run `npm run sync` against the live portal (the rules forbid it here). It is covered by tests with a mocked portal. The first real run, and what the export does past 403 rows, is yours to confirm.
- **Dependency note:** `.env.example` got a commented `DB_PATH`; `data/` is git-ignored.

## Phase 5C — caching and robustness

- **Own cache, no `lru-cache`.** `src/cache.js` (about 130 lines with comments) is a Map-based TTL + LRU: a hit re-inserts the key, an insert past `CACHE_MAX_ENTRIES` drops the oldest. No dependency added, as the brief defaulted to. It replaces the 60 s `memoised()` helper in `service.js`, which is deleted; `export-pull.js` paging is unchanged.
- **TTLs (all [Assumed], per kind, env-tunable):** energy 2 min, meter detail and the search-id list 5 min, export 10 min, transformers 30 min. The reasoning is in the README; the honest caveat is that I never observed how often the portal data changes, so these are judgements. `0` disables a kind.
- **What is cached.** Cache keys: `meter:<id>` (search row + geo, loaded together so an unknown id is a 404 before geo is asked), `energy:<id>` (shared by raw and daily), `dts:<page>`, `export`, `search-ids`. Not cached: `GET /v1/meters` live list (source of truth, free-text `q`), `/health` (must be a real probe).
- **The derived network tree is not cached.** It is rebuilt from the cached export and transformers per request (cheap at 403 meters). Caching it would store a value computed from possibly stale inputs and then call it fresh for another 10 minutes.
- **`fetched_at` changed meaning slightly:** it is now when the data was actually fetched (the cache entry's timestamp), not when the request arrived. For a composite response (meter detail) it is the oldest part's, so a response never looks fresher than its data. Live-list and health responses still use request time.
- **Stale-on-error.** Any `PortalError` except `PortalNotFound` may fall back to an entry expired less than `CACHE_STALE_GRACE_MS` (15 min) ago. 404 stays 404 so a deleted meter does not live on. Body gets `stale: true` (absent otherwise, so existing consumers are unaffected), plus `X-Cache: STALE`. Worst state wins across parts: if only the export part is stale, the whole meter response says STALE.
- **How the header gets out.** The service returns the body with its cache state on a Symbol property; a `preSerialization` hook in `app.js` turns it into `X-Cache`. The symbol is invisible to JSON/serialisation, so no route or schema carries a header field in the body. Routes declare the header for OpenAPI via `cachedOk()` in `schemas.js`.
- **Coalescing** lives in the cache (one in-flight promise per key, cleaned up by every waiter so a synchronously throwing loader cannot leave a stuck entry). I did not reuse the login single-flight code: that one is tied to session state, and a generic keyed version was simpler than parameterising it.
- **Circuit breaker: built, ~50 lines with comments** (`src/portal/breaker.js`), so it stays. A failure is a request that still failed after its retries (`PortalUnavailable`); any portal answer counts as success. Defaults 5 failures, 30 s cool-off. Half-open lets exactly one probe through. `PortalCircuitOpen` extends `PortalUnavailable` (so the existing export-degrade and stale paths treat it like an outage) and maps to 503 `portal_circuit_open` with `Retry-After`.
- **Breaker sits around retries, not inside them,** so one flaky request does not burn the budget; it counts logical requests. Login goes through it too.
- **`/health`:** adds `circuit` and `cache` counters; `degraded` if the portal is unreachable or the circuit is not closed. It is still a real call, so when the circuit is half-open the health check is the probe. Counters are since process start and are not a metrics system.
- **Reviewed, not changed:** keep-alive (Node's built-in fetch reuses connections; a connection the portal closed shows up as a network error and the existing retry covers it), timeouts (`AbortSignal.timeout` covers body reads too), 429/`Retry-After` (honoured, capped 30 s), re-login on 401 (single-flight, one retry).


## Incomplete hierarchy rows (after the first live run)

- **Keep, do not drop.** The live export has 14 rows with an empty code at one or more hierarchy levels. The parser used to reject the whole row, so those meters vanished from the index and the tree (389 instead of 403). Now `parseHierarchy` turns a level with no usable code (not an object, name not a string, or blank code) into `null` and keeps the row. A `hierarchy` that is not an object at all is still a malformed row and is skipped.
- **Tree placement.** The walk stops at the first unusable level; the meter sits at the deepest valid ancestor and is counted there and above. Levels below the gap are not attached to a guessed parent. If the zone itself is unusable the meter is in `unplaced`. This means zone totals add up to 403 but a gap-meter is not under its own feeder or DT in the tree, even though meter detail still shows those deeper levels.
- **New issue type `incomplete_hierarchy`** (meter id, deepest valid node code, and which levels lack a code). `meter_not_in_export` now means only "in portal search, absent from the export". The `dtCode` mismatch check (`orphan_meter`) only runs when the meter reached its DT node.
- **Index.** Hierarchy columns are nullable. An index file created by the earlier version (columns NOT NULL) is detected on open and emptied, with its run history cleared, so `/v1/sync/status` says "never synced" and the next `npm run sync` refills it. Chosen over `ALTER TABLE` because the index is rebuildable and SQLite cannot drop NOT NULL in place.
- **Schema.** `HierarchyNode` is now nullable, so each level of `hierarchy` in meter detail can be `null`.
- **Live result:** sync stores 403 and rejects 0; `/v1/network` zone totals sum to 403 (189 + 101 + 113); `/near` and filters see all 403; issues are 80 `conflicting_parent`, 14 `incomplete_hierarchy`, 8 `duplicate_code_name`, and no `meter_not_in_export`.
