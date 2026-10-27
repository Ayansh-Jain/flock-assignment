# Decisions & assumptions

Status: **Decided** (author's choice), **Proposed** (mine, awaiting review), **Assumed** (unverified).

## Phase 1: decisions made by the author

1. **Meter list source of truth:** `/portal/meters/search` (total 403). The export only enriches meters it covers; meters not in the export get `hierarchy: null`. Upper levels are NOT reconstructed from `dtCode` for now (possible future improvement).
2. **Export signature:** resolved by reading the frontend JS (see protocol-notes, Bulk path). The secret is fetched from `/portal/keys` at runtime and never stored.
3. **Hierarchy:** from the export where available, else `null`.
4. **Daily consumption:** group readings by IST calendar day. Daily total = last reading of the day minus last reading of the previous day (registers are cumulative). Because the first reading is 23:30 on the first day, the first day has no previous-day anchor and incomplete days at the ends are skipped rather than reporting a wrong figure. Document this in the API description.
5. **Timezone:** timestamps treated as IST; output ISO-8601 with `+05:30`.
6. **Units:** `kwh` / `kvah` exposed as numbers; OpenAPI description says the unit is assumed kWh / kVAh.
7. **Session handling:** the client re-logs-in once on any 401 and retries. Cookie flags and lifetime are not investigated.
8. **Export paging:** our sync pages the export itself (page=2,3,...), one signed request per page with a fresh timestamp, with an upper bound on pages.
9. **Dependencies:** `tough-cookie` approved (installed at 6.0.2, exact). `npm audit`: 0 vulnerabilities.
10. **Commit trailer:** use `Co-Authored-By: Ayansh Jain` on commits (no Claude co-author line). The author commits and pushes.
11. **Fixtures:** no `__data.json` fixture; hierarchy comes from the export.

## Assumptions (unverified)

- Energy timestamps (`DD/MM/YYYY HH:mm`, no zone) are IST (UTC+05:30).
- `kwh` is kWh and `kvah` is kVAh (from field names; no unit in payload).
- `kwh` / `kvah` are cumulative registers.
- Export page size is larger than 20 and more export pages exist (UI never loops).
- Login POST is urlencoded `email` + `password` with an `x-sveltekit-action` header; the capture script relies on this.
- The 8-day energy window, no gaps/dupes, was seen on the meter(s) checked; assumed for all.

## Phase 2 (portal client + parsers)

All of these are mine and open to review; none were specified by the portal.

- **Timeouts:** `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` per attempt (default 20 s; it covers reading the body too). Config values are validated at startup and the config object is frozen.
- **Retry policy:** retry only timeouts/network errors (`TimeoutError`, `AbortError`, fetch `TypeError`), HTTP 5xx and 429, up to `MAX_RETRIES` (default 3). Backoff is exponential with full jitter (250 ms base, 5 s ceiling). Other 4xx are never retried. After the last attempt the client throws `PortalUnavailable`.
- **429:** wait for `Retry-After` (seconds or HTTP-date), capped at 30 s; without the header, use the normal backoff.
- **Re-login trigger:** only `/portal/*` + HTTP 401 + body `{"error":"unauthorized"}`. The jar is reset, one login runs (single-flight), the request is retried once; a second 401 raises `PortalAuthError`. A generation counter makes sure concurrent expired requests trigger one reset, not many.
- **Login success:** decided from the body (`type: "redirect"`), not the HTTP status. The error message never includes the response, because the failure body echoes the email.
- **Concurrency:** one `p-limit` around each logical request (login and retries included), default 3, config max 4 (ground rule: 2-4 concurrent).
- **Export signing:** per CLAUDE.md/Phase 1 scheme. The signing key is fetched via `/portal/keys` on every `fetchExport` call (not cached) and the signature is computed per attempt, so a retry after backoff carries a fresh timestamp. The secret and signature are never logged.
- **Timestamps:** parsed strictly as `DD/MM/YYYY HH:mm`, real calendar times only, output `YYYY-MM-DDTHH:mm:00+05:30`. Readings are sorted chronologically in the parser.
- **Daily consumption (refines Phase 1 decision 4):** a day is reported only if it ends at 23:30 and the previous calendar day also ends at 23:30. The first day of the series, which has no anchor, is therefore never reported, and days whose previous day is missing are skipped. **Added by me, please confirm:** a day where the register goes backwards (negative difference, e.g. a reset or meter swap) is skipped rather than reported. Differences are rounded to 2 decimals to remove float noise.
- **Strictness vs resilience:** every parser throws `PortalParseError` on an unexpected shape. For `/portal/export` that means one malformed row fails the whole page; only 3 export rows have been seen so far. Revisit in Phase 3 (skip-and-log bad rows) if the full dataset shows messy rows.
- **Unified geo:** export `geo {lat,lng}` and `/geo` `{latitude,longitude}` are both parsed to `{latitude, longitude}` numbers.
- **Config:** `PORTAL_BASE_URL` is checked with a pattern (`^https?://\S+$`) because env-schema ships no `uri` format. `process.loadEnvFile()` is called only when no override object is passed. ESLint is told to allow it (`allowExperimental`), since the rule flags it below Node 22.21 even though `>=22` runs it.
- **Test runner glob:** `npm test` runs `node --test "test/**/*.test.js"` instead of bare `node --test`, so `test/helpers.js` is not run as a test file.
- **Tests use undici's own `fetch`** (injected through `fetchImpl`) with a `MockAgent`, so the real network is never reachable and no global patching of Node's built-in fetch is needed.

### Assumptions still unverified after Phase 2

- Unknown-meter behaviour of `/geo` and `/energy` (assumed HTTP 404 maps to `PortalNotFound`); never observed.
- 403 on `/portal/*` is treated as an auth problem (`PortalAuthError`); never observed.
- Export pagination is still unknown (see protocol-notes, Open questions).

## Phase 2 review: decisions by the author (supersede the matching Phase 2 proposals above)

- **Negative daily totals: DECIDED.** A day where the register goes backwards (reset or meter swap) is skipped, not reported. Skips are visible, not silent: `deriveDailyConsumption` now returns `{ days, skipped }`, where `skipped` lists `{ date, reason }` with reasons `register_decreased`, `missing_previous_day` (gap) and `incomplete_day` (interior). The expected edges (the first date, which only anchors the next day, and a final date that stops before 23:30) are not listed. Phase 3 must expose the skipped count on the daily response and/or log it.
- **Export bad rows: DECIDED.** `parseExport` skips a malformed ROW, continues, and returns `skipped: { count, samples }` (samples capped at 5, each with row index, `meterId` if readable, and the reason, which never contains the raw value). A malformed ENVELOPE (response not an object, `data` not an array, bad `total`) still throws `PortalParseError`. The sync summary in Phase 3 must include these skipped counts and samples. Single-meter parsers (search, geo, energy, transformers) stay STRICT and throw.
- **Export paging: DECIDED.** Keep "export may fit in one page (~231 KB)" as a recorded assumption. The sync still pages defensively with a bound, and search (403) stays the source of truth for the meter list.
- **Labelled assumptions kept:** 404 -> `PortalNotFound`, 403 -> `PortalAuthError`; `process.loadEnvFile` allowed in the lint config instead of raising `engines`.
- **Documentation to write:** PROTOCOL.md must explain that the energy series gives 7 daily totals (24-30 Jun) because its first reading is 23:30 on 23 Jun.
- **Housekeeping:** `notes/` added to `.prettierignore` so prose is not reflowed. Existing notes were not rewritten.

## Phase 3 (service layer, routes, openapi.json)

Mine unless stated; open to review.

- **limit/offset onto portal pages.** The portal pages by 20 (Observed for search and dts). The service always fetches upstream page 1 first (it carries `total` and lets us check `pageSize === 20`), then only the pages the window needs, never beyond the last page, because the portal's behaviour past the end was never observed. Costs: an offset past the end is 1 upstream call; offset >= 20 costs one extra call (page 1). A changed upstream page size raises `PortalParseError` instead of mis-slicing. limit default 50, max 200 (at most 11 upstream pages).
- **Response wrapper is `{ data, total, limit, offset, fetched_at }`**, not `{ page, pageSize }` as in the brief, because our API pages by limit/offset and echoing page numbers would mislead.
- **Field names follow the parsers**, so `geo` is `{ latitude, longitude }` (the brief said `{lat, lng}`; the export's `lat/lng` is normalised by the parser). `fetched_at` and `request_id` are snake_case as specified, so naming is deliberately mixed: camelCase for portal-derived fields, snake_case for fields we add. Easy to unify later.
- **Daily series** carries `kvah` as well as `kwh` (the parser returns both), plus `skippedDays` (count) and `skipped` (`{date, reason}` list), and the service logs a warning when days are skipped.
- **installType, build, hierarchy are `null` (not omitted)** when the meter is not in the export, so the response shape is stable.
- **Meter detail = 4 upstream calls and no cache:** search (exact-id check), `/geo`, `/portal/keys` and the full export pull. The export (~230 KB) is fetched on every detail request until the cache extension exists; `loadExportIndex()` in src/service.js is the seam. Detail latency is therefore the slowest in the API.
- **Export outage degrades, auth does not.** If the export fails with `PortalUnavailable` or `PortalParseError`, the detail still returns with `hierarchy: null` and a warning is logged (the caller cannot tell why it is null). A `PortalAuthError` still fails the request.
- **Export paging in the service:** bounded to 10 pages, stops when rows seen >= `total`, on an empty page, or on a repeated page (no new meter ids), warning "export may be incomplete" in the last two cases. Bad rows are skipped and logged as count + 5 samples (Phase 2 decision).
- **Unknown meter** is found via search, matching the id exactly and case-sensitively (search is partial). It is checked on the detail route only; `/consumption` and `/consumption/daily` rely on the portal's 404 for `/energy`, which is still an assumption (never observed).
- **Error mapping** (single shape `{ error: { code, message, request_id } }`, messages are fixed text, nothing from upstream): validation -> 400 `invalid_request` naming the field; `PortalNotFound` -> 404 `meter_not_found`; unknown route -> 404 `route_not_found`; `PortalUnavailable` whose cause is a timeout -> 504 `portal_timeout`; other `PortalUnavailable` -> 502 `portal_unavailable`; `PortalParseError` -> 502 `portal_bad_response`; other `PortalError` -> 502 `portal_error`; `PortalAuthError` -> 503 `portal_auth_failed` (our credentials, not the caller's); anything else -> 500 `internal_error`. Logged at warn for 4xx and error for 5xx; stack traces appear only in logs.
- **/health always returns 200** while the process is up; `status: "degraded"` / `portal: "unreachable"` reports the portal. It makes one cheap read-only call to the portal (dts page 1) per request, so do not point a high-frequency prober at it without adding a cache.
- **Intentional skip: no authentication on our API.** Anyone who can reach the port can read portal data through our credentials. It binds to 127.0.0.1 by default. In production: API key or OAuth at a gateway, TLS termination, per-client rate limits, and request quotas so the shared portal is not hammered.
- **No CORS** until a web client needs it.
- **Config:** `NODE_ENV` added to the schema (default `production`); pino-pretty is used only when it is `development`. The `dev` script is now `node --watch src/server.js` (set `NODE_ENV=development` in `.env` for pretty logs).
- **OpenAPI:** components are named by schema `$id` via swagger's `refResolver`; `src/openapi.js` generates the document and is shared by `scripts/export-openapi.js` and `test/openapi.test.js`. `openapi.json` is generated, so it is in `.prettierignore`.
- **Meter id parameter** must match `^[A-Za-z0-9_-]{1,32}$` (Assumed from `J100001`); other ids get 400 without touching the portal.

## Phase 3 follow-up (author-approved Phase 3, memo folded in)

- **Export index memo (supersedes "no cache" for meter detail above).** `loadExportIndex()` in src/service.js now keeps ONE in-process entry for 60 s (`EXPORT_MEMO_TTL_MS`, overridable via `exportTtlMs`). Concurrent callers share a single pull; a failed pull is never kept; there is no invalidation and nothing shared across processes, so data can be up to 60 s stale (and `hierarchy` for a changed meter likewise). Memory is bounded by the dataset (at most 10 export pages). Effect: after the first detail request in a minute, detail costs search + `/geo` only. The general cache (per-endpoint, LRU, freshness policy) remains a Phase 5 extension.
- **README must say** that `/health` makes a live portal call (dts page 1) on every request, so a fast prober should not be pointed at it. Phase 4 to-do.
- **Also for Phase 4 docs:** the 7-day / 23:30 explanation in PROTOCOL.md; the unexercised shutdown path; the unobserved portal behaviours (past-the-end page, `/energy` 404 for unknown meter, 403).
