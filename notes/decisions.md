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
