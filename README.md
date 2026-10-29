# Urja Meter API

A small read-only API that sits in front of the old "Urja Meter Ops" web portal. The portal is what the utility's field staff use to look up smart meters, but it has no API, so the only way to get data out was copy-pasting from the browser. This service fixes that: it logs into the portal itself, reads from the portal's own hidden JSON endpoints, tidies the data up (real numbers instead of strings, proper ISO timestamps, one consistent error format) and hands it back as a clean API that another program can use.

If you just want to see what it returns, jump to [Sample requests](#sample-requests). For how the portal actually works under the hood, see [PROTOCOL.md](PROTOCOL.md). The API description is in [openapi.json](openapi.json), and my working notes while building this are in [notes/](notes/).

## Quick start

You'll need Node.js 22.13 or newer, npm, and the portal username and password (not included in this repo).

```bash
npm ci
```

Copy the env template and fill in your credentials:

```bash
# Windows (PowerShell or cmd)
copy .env.example .env

# macOS / Linux
cp .env.example .env
```

Open `.env` and set `PORTAL_USERNAME` and `PORTAL_PASSWORD`. `.env` is git-ignored — don't commit it.

```bash
npm start          # http://127.0.0.1:3000
npm run dev        # same thing, restarts when you edit a file
```

Then open <http://127.0.0.1:3000/docs> for the interactive Swagger UI, where you can try every endpoint. The raw spec is at `/docs/json` and in [openapi.json](openapi.json).

## Sample requests

These outputs were generated from the saved, redacted portal responses in `test/fixtures/`, run through the real routes and service with a stubbed portal client. So they're real shapes, not made up. Against the live portal you'll get the same shape; only `fetched_at` changes to your request time.

### List meters

```bash
curl "http://127.0.0.1:3000/v1/meters?limit=2"
```

```json
{
  "data": [
    {
      "meterId": "J100000",
      "serialNo": "SE33962",
      "make": "HPL",
      "phaseType": "single",
      "installStatus": "Decommissioned",
      "dtCode": "DT-001"
    },
    {
      "meterId": "J100001",
      "serialNo": "GE84132",
      "make": "L&T",
      "phaseType": "single",
      "installStatus": "Installed",
      "dtCode": "DT-002"
    }
  ],
  "total": 403,
  "limit": 2,
  "offset": 0,
  "fetched_at": "2026-10-28T10:00:00.000Z"
}
```

### One meter, with location and where it sits in the network

```bash
curl "http://127.0.0.1:3000/v1/meters/J100000"
```

```json
{
  "meterId": "J100000",
  "serialNo": "SE33962",
  "make": "HPL",
  "phaseType": "single",
  "installStatus": "Decommissioned",
  "dtCode": "DT-001",
  "installType": "Whole Current",
  "build": "legacy",
  "geo": { "latitude": 26.938961002479868, "longitude": 75.83095696146852 },
  "hierarchy": {
    "zone": { "name": "Jaipur Zone 1", "code": "Z-01" },
    "circle": { "name": "Circle 1", "code": "C-01" },
    "division": { "name": "Division 1", "code": "D-01" },
    "subdivision": { "name": "Subdivision 1", "code": "SD-01" },
    "substation": { "name": "Substation 1", "code": "SS-01" },
    "feeder": { "name": "Feeder 1", "code": "F-001" },
    "dt": { "name": "Malviya Nagar DT 1", "code": "DT-001" }
  },
  "fetched_at": "2026-10-28T10:00:00.000Z"
}
```

`installType`, `build` and `hierarchy` come from the portal's bulk export. If a meter isn't in that export, these come back as `null` rather than a guess.

### Daily consumption

```bash
curl "http://127.0.0.1:3000/v1/meters/J100000/consumption/daily"
```

```json
{
  "meterId": "J100000",
  "data": [
    { "date": "2026-06-24", "kwh": 20.29, "kvah": 21.91 },
    { "date": "2026-06-25", "kwh": 20.29, "kvah": 21.92 }
  ],
  "skippedDays": 0,
  "skipped": [],
  "fetched_at": "2026-10-28T10:00:00.000Z"
}
```

Trimmed here to two of the seven days (24–30 June). `skippedDays` counts any days left out — a gap in the data, an incomplete day at the start, or a reading that went backwards (which usually means a meter reset or swap, not real usage).

### Errors

Every error looks the same, and the `request_id` matches the `X-Request-ID` header on the response, so you can line a failure up with the logs:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Invalid path parameter 'meterId': must match pattern \"^[A-Za-z0-9_-]{1,32}$\".",
    "request_id": "d8ceb9b9-aba8-43c8-9936-9617eb2c2004"
  }
}
```

## API overview

| Method | Path                                                                           | Purpose                                                                      |
| ------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| GET    | `/health`                                                                      | Service status and whether the portal is reachable                           |
| GET    | `/v1/meters?q&limit&offset`                                                    | List or search meters live from the portal (`limit` 1-200, default 50)       |
| GET    | `/v1/meters?make&phaseType&installStatus&installType&build&dtCode&zone&feeder` | **Index-backed** filters (any combination, plus `q`); needs `npm run sync`   |
| GET    | `/v1/meters/near?lat&lon&radius_km`                                            | **Index-backed** meters near a point, nearest first, with `distance_km`      |
| GET    | `/v1/sync/status`                                                              | When the local index was last synced, row counts, last run                   |
| GET    | `/v1/meters/{meterId}`                                                         | Meter detail: nameplate, location, network hierarchy                         |
| GET    | `/v1/meters/{meterId}/consumption`                                             | Raw 30-minute readings (cumulative kWh / kVAh, R-phase voltage)              |
| GET    | `/v1/meters/{meterId}/consumption/daily`                                       | Derived daily totals plus the count of skipped days                          |
| GET    | `/v1/transformers?limit&offset`                                                | Distribution transformers with feeder and capacity                           |
| GET    | `/v1/network`                                                                  | Network zones with child and meter counts                                    |
| GET    | `/v1/network/{nodeCode}`                                                       | A node at any level: its children and its path from the zone                 |
| GET    | `/v1/network/{nodeCode}/meters?limit&offset`                                   | Meters under a node (from the export), paged                                 |
| GET    | `/v1/network/issues`                                                           | Data-quality findings in the hierarchy (slower; lists all meters via search) |

The network tree is built from the portal export, so it only contains meters that are in the export. See `PROTOCOL.md` and `notes/decisions.md` for how inconsistent data is handled.

Full schemas are in [openapi.json](openapi.json), or `/docs` while the service is running. Error codes: 400 bad request, 404 unknown meter, network node or route, 502 the portal failed or returned something unreadable, 503 this service couldn't log into the portal, the portal is failing and calls are paused for a moment (`portal_circuit_open`, with `Retry-After`), or the local index was never synced (`index_not_synced`), 504 the portal timed out.

Note: `/health` makes one real call to the portal every time (never the cache), since that's the only honest way to say whether the portal is up. It also reports the circuit breaker and cache counters. Don't point a fast health-check at it.

## How it's put together

```
src/
  config.js            reads and validates env vars (frozen config object)
  server.js            starts the server; graceful shutdown; exits on fatal errors
  app.js               buildApp(): Fastify, logging, Swagger, routes (used by server and tests)
  error-handler.js     turns every failure into one error shape, including unknown routes
  schemas.js           JSON Schemas: input validation, output shaping and OpenAPI, all from one place
  service.js           ties the portal calls and parsers together into the API's objects
  openapi.js           builds the OpenAPI document (used by the script and a test)
  hierarchy.js         pure: builds the network tree from the export and collects data issues
  cache.js             small bounded TTL + LRU cache: coalescing and stale-on-error for live reads
  export-pull.js       pages the signed export defensively (shared by the cache and sync)
  sync.js              pulls the export into the SQLite index; records each run
  index-store.js       SQLite schema, upsert and queries (prepared statements only)
  index-service.js     index-backed answers: filters, near, sync status
  geo.js               pure: haversine distance and bounding box
  routes/              health.js, meters.js, transformers.js, network.js
  portal/
    client.js          login, cookies, retries, re-login, timeouts, concurrency cap, export signing
    parsers.js         pure functions: raw portal JSON in, clean objects out
    breaker.js         small circuit breaker: fail fast while the portal is failing
    errors.js          PortalAuthError, PortalNotFound, PortalUnavailable, PortalCircuitOpen, PortalParseError
scripts/
  export-openapi.js    writes openapi.json (npm run openapi)
  capture-fixtures.js  one-off script I used to save the redacted test fixtures
test/                  unit and API tests, with fixtures in test/fixtures/
notes/                 my working notes: protocol findings, decisions, mistakes

```

The flow for a request is: the **route** checks the input and declares what it returns, the **service** works out which portal calls are needed, the **portal client** handles logging in and actually fetching, and the **parsers** turn the portal's messy JSON into clean objects (or throw if the shape is wrong). If anything fails anywhere, the **error handler** catches it and returns the one standard error shape.

Live reads go through a small in-memory cache and a circuit breaker; see [Caching & freshness](#caching--freshness).

## How the portal works (short version)

The portal is a SvelteKit app. Once you log in through its form, the browser quietly calls cookie-authenticated JSON endpoints under `/portal/*` for meters, location, 30-minute energy readings and transformers — so there was a real API hiding behind the page all along, just an undocumented, internal one. There's also a bulk export with richer data (including the full seven-level network hierarchy), but it's locked behind an HMAC signature. The interesting part is that the portal hands the signing key to any logged-in session, so the service can sign its own export requests. The full write-up, including the quirks and the things I couldn't confirm, is in [PROTOCOL.md](PROTOCOL.md).

## Configuration

Config is read once at startup from the environment (a `.env` file is loaded if it's there). If a required variable is missing or invalid, the service refuses to start and tells you which one.

| Variable                    | Default         | Meaning                                                                |
| --------------------------- | --------------- | ---------------------------------------------------------------------- |
| `PORTAL_BASE_URL`           | none (required) | Portal address, e.g. `https://urja-ops.flockenergy.tech`               |
| `PORTAL_USERNAME`           | none (required) | Portal login email                                                     |
| `PORTAL_PASSWORD`           | none (required) | Portal login password                                                  |
| `REQUEST_TIMEOUT_MS`        | `20000`         | Timeout for each request to the portal                                 |
| `MAX_CONCURRENCY`           | `3`             | How many requests hit the portal at once (1 to 4)                      |
| `MAX_RETRIES`               | `3`             | Retries after a timeout, network error, 5xx or 429 (0 to 10)           |
| `CACHE_TTL_ENERGY_MS`       | `120000`        | Cache lifetime for energy readings (see Caching & freshness)           |
| `CACHE_TTL_METER_MS`        | `300000`        | ... for meter detail and the meter-id listing                          |
| `CACHE_TTL_TRANSFORMERS_MS` | `1800000`       | ... for transformer pages                                              |
| `CACHE_TTL_EXPORT_MS`       | `600000`        | ... for the portal export behind the network tree                      |
| `CACHE_STALE_GRACE_MS`      | `900000`        | How long past its TTL an entry may still be served if the portal fails |
| `CACHE_MAX_ENTRIES`         | `500`           | Cache size bound (least recently used goes first)                      |
| `BREAKER_THRESHOLD`         | `5`             | Consecutive failed portal requests that open the circuit               |
| `BREAKER_COOLOFF_MS`        | `30000`         | How long calls fail fast before one probe is let through               |
| `DB_PATH`                   | `data/urja.db`  | SQLite index file written by `npm run sync` (git-ignored)              |
| `HOST`                      | `127.0.0.1`     | Address to listen on                                                   |
| `PORT`                      | `3000`          | Port to listen on                                                      |
| `LOG_LEVEL`                 | `info`          | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`         |
| `NODE_ENV`                  | `production`    | Set to `development` for readable logs (`pino-pretty`)                 |

## Caching & freshness

Two different things keep requests off the portal, and they are deliberately separate:

- **The SQLite index** (see [Sync & local index](#sync--local-index)) is the durable, fast path. It is filled by `npm run sync`, survives restarts, and its freshness is the `synced_at` it reports.
- **An in-memory cache** for the _live_ reads (meter detail, energy, transformers, the export behind the network tree). It is small, bounded, lost on restart, and its freshness is a TTL. The old 60-second export memo is **retired**: this replaces it, using the same export pull underneath.

### What is cached, and for how long

Every cached response carries `fetched_at` (when the data was **actually** fetched from the portal, not when you asked) and an `X-Cache` header.

| Kind                                                                   | Default TTL | Env var                     | Why                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------- | ----------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Energy readings (`/consumption`, `/consumption/daily`, shared)         | 2 min       | `CACHE_TTL_ENERGY_MS`       | Changes most. Readings are 30-minute steps (observed), so 2 minutes is a small fraction of one step, yet it still absorbs a dashboard polling or a burst of identical requests.                                                   |
| Meter detail (search row + location) and the all-meter-ids listing     | 5 min       | `CACHE_TTL_METER_MS`        | Attributes and coordinates change when a meter is swapped or surveyed: rare, and not minute-by-minute. 5 minutes is long enough to matter for repeat lookups, short enough that a status change shows up within one coffee break. |
| Transformers (per page)                                                | 30 min      | `CACHE_TTL_TRANSFORMERS_MS` | The distribution-transformer list is network master data: it changes with field works, not with load. It is also what the network checks read, so a long TTL saves the most calls.                                                |
| Portal export (hierarchy, install type, build; backs the network tree) | 10 min      | `CACHE_TTL_EXPORT_MS`       | The heaviest call (about 230 KB, several signed pages, a key fetch), and hierarchy changes are rare. This used to be 60 seconds; 10 minutes pays for itself and the index is the answer for anyone who needs it durable.          |

**[Assumed]** These are judgements from how the data should behave. I did not observe how often the portal's data really changes (the fixtures are single snapshots), so treat them as sensible starting points and tune them with the env vars. `0` turns caching off for a kind.

Not cached, on purpose: the live meter list/search (`GET /v1/meters` without index filters) is the source of truth, and its `q` is free text, so caching it would mostly fill the cache with one-off keys. `/health` always asks the portal, because a cached "reachable" is worthless.

The network tree itself is rebuilt from the cached export and transformers on each request (a few milliseconds for 403 meters). Caching the derived tree would let stale inputs look fresh, so I don't.

### How it behaves

- **Bounded, LRU.** At most `CACHE_MAX_ENTRIES` (default 500) entries; past that the least recently used entry goes. The biggest entries are energy series (337 readings each), so the worst case is in the low tens of MB.
- **Coalescing.** If 8 requests ask for the same thing at once, one portal call is made and all 8 get its result. Failures are shared too (one failed call, not 8) and are never stored.
- **Stale-on-error.** If a refresh fails because the portal is down, slow, or returned something unreadable, and an entry that expired less than `CACHE_STALE_GRACE_MS` ago (default 15 min) is held, you get that old copy with HTTP 200, `X-Cache: STALE` and `"stale": true` in the body. `fetched_at` still says how old it really is. Beyond the grace window, or with nothing cached, you get the normal error (502/503/504). A 404 is never answered from stale data: a meter that is really gone stays gone.
- **The trade-off.** A slightly old answer is usually more useful to an operator than an error, but it can be wrong. That is why the staleness is stated twice (header and body), why the window is short, and why a client that cannot tolerate it can simply check `stale`.
- **`X-Cache` values.** `HIT` served from memory; `MISS` fetched from the portal for this request; `STALE` as above. When one response combines several cached parts (meter detail = meter + export), the worst state wins and `fetched_at` is the oldest part's.
- **A cache fault never fails a request.** Every read and write of the store is wrapped; a fault is logged and treated as a miss.
- **Single process.** The cache is in memory, so each instance has its own, and a restart empties it. Cached values are shared between requests and treated as read-only.

### Circuit breaker

After `BREAKER_THRESHOLD` (default 5) consecutive requests that still failed after their retries (timeouts, network errors, 5xx, 429), the client stops calling the shared portal for `BREAKER_COOLOFF_MS` (default 30 s). During that time calls fail immediately with 503 `portal_circuit_open` and a `Retry-After` header (cached data can still be served stale). After the cool-off one probe is let through (half-open): success closes the circuit, failure re-opens it. A portal answer of any kind (even 404 or 401) counts as the portal being up.

`GET /health` shows it: `circuit` is `closed`, `open` or `half-open`, `cache` has `entries`, `hits`, `misses` and `stale` counters, and `status` is `degraded` if the portal is unreachable **or** the circuit is not closed. While half-open, the health call is itself the probe.

### Long-running session

Reviewed rather than rewritten: the session cookie lasts about an hour, and the client logs in again on the first 401 (one shared login, one retry, then a clear error), every request has a timeout that also covers reading the body, retries use backoff with jitter and honour `Retry-After` (capped at 30 s), and connection reuse is Node's built-in keep-alive. A reused connection that the portal closed shows up as a network error and is simply retried. Known gap: if the configured password is wrong, every incoming request tries to log in again; the breaker does not cover that, because the portal does answer. See "What I'd improve".

## Sync & local index

The portal can only search by id or serial. The bulk export has more (make, phase, status, hierarchy, coordinates), so `npm run sync` pulls all of it into a local SQLite file and some routes answer from there.

```bash
npm run sync        # needs the portal credentials in .env; writes data/urja.db
npm start           # then use the index-backed routes below
```

What the sync does: logs in once, then reads `/portal/export` page by page through the same signed client (a fresh signature per page, 0.5 s pause between pages, bounded to 10 pages, stops on an empty or repeated page or when it has `total` rows). Rows that are badly broken (no usable `hierarchy` object, bad coordinates) are skipped and logged; rows that only have an empty hierarchy code at some level are **kept**, with that level null, rows are upserted in batches of 100 (one transaction each, so re-running never duplicates), and each run is recorded in a `sync_runs` table. It prints a data-quality summary (rejected rows, duplicate ids, hierarchy inconsistencies). Exit code 0 = complete, 2 = incomplete (the paging guard stopped early), 1 = failed.

What it enables:

| Request                                                                                                        | Served from                                            |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `GET /v1/meters` with none of the filters below                                                                | **Live portal** (`source: "portal"`, has `fetched_at`) |
| `GET /v1/meters?make=&phaseType=&installStatus=&installType=&build=&dtCode=&zone=&feeder=` (any mix, plus `q`) | **Index** (`source: "index"`, has `synced_at`)         |
| `GET /v1/meters/near?lat=&lon=&radius_km=`                                                                     | **Index**                                              |
| `GET /v1/sync/status`                                                                                          | **Index**                                              |
| Everything else (`/v1/meters/{id}`, consumption, transformers, network)                                        | **Live portal** (cached: see Caching & freshness)      |

Index answers can be stale: read `synced_at` (or `/v1/sync/status`). Before the first sync, index routes return 503 `index_not_synced`. Filters are exact, case-insensitive matches; zone, feeder and DT codes are normalised like the network tree. `near` uses a latitude/longitude box in SQL, then an exact haversine distance (spherical Earth, about 0.5% error) and sorts nearest first.

**Limits and how it would scale.** This is a full-table, sync-on-demand design: every sync re-reads the whole export, nothing is deleted from the index (a meter removed from the portal stays until you delete `data/urja.db`), and `near` loads every row in the bounding box into memory and sorts it in JS. For the 403 meters here that costs nothing. Where it would start to struggle, roughly: the sync at tens of thousands of meters (the export is one big signed response and the portal is shared; I never saw how it behaves past 403 rows), `near` at a few hundred thousand rows with large radii (the lat/lon b-tree index only helps on one axis), and SQLite itself once several processes write or the data outgrows one machine. What I'd change: an incremental "changed since" sync (needs the portal to support it, otherwise hash-compare pages), deleting meters that disappear from a complete pull, a scheduled job instead of a manual command, and Postgres with PostGIS (or at least an R-tree index) for the geo queries.

`node:sqlite` is built into Node but still marked experimental, so Node prints a one-line warning at startup and the API could change in a later Node release.

## Tests, lint, and the OpenAPI file

```bash
npm test                # unit and API tests; no network; ~3 seconds
npm run lint
npm run format:check
npm run openapi         # regenerate openapi.json after changing a route schema
```

`npm test` also checks that the committed `openapi.json` still matches the route schemas, and tells you to run `npm run openapi` if it's gone stale.

The tests never touch the real portal — the client is tested against a mocked HTTP layer, and any unmocked network call fails the test. There's one optional smoke test that does a single real login and read, and it's skipped unless you opt in:

```bash
# macOS / Linux
RUN_LIVE_TESTS=1 npm test
# Windows PowerShell
$env:RUN_LIVE_TESTS = "1"; npm test
```

## Assumptions

These are things the portal doesn't actually tell you, so I made a call and wrote it down. Fuller list in [notes/decisions.md](notes/decisions.md).

- Energy timestamps (`DD/MM/YYYY HH:mm`, no timezone) are treated as IST (UTC+05:30) and returned as ISO-8601 with `+05:30`.
- `kwh` is kWh and `kvah` is kVAh, going by the field names — the portal gives no units.
- Those two are running meter totals, not per-day usage, so a day's consumption is one reading minus another.
- The portal's search is the real list of which meters exist (403 of them). The bulk export only adds extra detail on top.
- **Observed (first live sync):** the export is one page: all 403 rows with `total: 403`. I never asked for `page=2`, so what the portal does past the end is still unknown. The real data also has 14 rows with an empty hierarchy code, 80 `conflicting_parent` and 8 `duplicate_code_name` findings (see `/v1/network/issues`).
- The login is a urlencoded form with `email` and `password`. It worked first try, so I didn't dig further into the browser's exact request.
- An unknown meter returns 404 from the portal's location/energy endpoints. I never actually saw this happen; the detail route doesn't rely on it.
- Meter IDs are letters, digits, `_` and `-`, up to 32 characters — based on the one format I saw (`J100000`).

## Design decisions and trade-offs

- **Node + Fastify instead of Express.** Fastify validates input and shapes output straight from JSON Schema, has logging built in, and can generate the OpenAPI spec from the same schemas. Speed wasn't the reason — the portal is always going to be the slow part.
- **Plain JavaScript, not TypeScript.** For a service this small, skipping a build step and a compiler felt like the right trade. JSDoc covers the exported functions.
- **One set of JSON Schemas does everything.** The same schema validates the request, shapes the response (and quietly drops anything not in it), and feeds `openapi.json`. A test fails if the committed spec drifts from the code.
- **Search is the source of truth; the export just enriches.** The export and search disagreed about the meter count early on, so the list always comes from search. Meters not in the export get `null` for hierarchy rather than a made-up value, and a meter in the export with an empty code at one level keeps its other levels and gets `null` for that one (reported as `incomplete_hierarchy`, not as missing from the export).
- **Signing the export.** I worked out the signature by reading the portal's own frontend code, not by firing trial requests at it. The key is fetched from `/portal/keys` at request time, used in memory, and never stored or logged.
- **Re-login on 401.** If a `/portal/*` call comes back 401, the client logs in once more and retries once; a bunch of requests arriving together share a single login. A second 401 is reported as an auth failure instead of looping forever.
- **Strict for single meters, forgiving for the bulk pull.** A broken response for one meter's data is an error. A single broken row in the big export is skipped and logged (with a count and a sample) so one bad meter doesn't sink the whole thing.
- **Skipped days are reported, not hidden.** If a day's reading goes backwards (a reset or meter swap) it's left out and counted in `skippedDays`, rather than showing a negative or nonsense figure.
- **A small hand-written cache instead of `lru-cache`.** One small file (about 130 lines with comments), no new dependency, and it does exactly what's needed: per-kind TTLs, an entry bound, coalescing and stale-on-error. It is in-memory and per-process; if this ran as several instances I'd move to a shared cache (or lean on the index). Details: [Caching & freshness](#caching--freshness).
- **Stale data is allowed, but never silent.** On a portal failure a recently expired copy is served with `X-Cache: STALE` and `stale: true`, and `fetched_at` shows its real age. Better an honest old answer than an error for the common outage; a 404 is never served stale.
- **A circuit breaker, kept small.** One small file (about 55 lines with comments). The portal is shared, so after repeated failures we stop calling it for 30 seconds rather than keep retrying on every request.
- **Retries and being polite to a shared system.** Timeouts, network errors, 5xx and 429 are retried with backoff and jitter (respecting `Retry-After`, capped at 30 s); other 4xx aren't retried. At most 3–4 requests run at once, everything has a timeout, and every loop over pages is bounded.
- **No auth on this API yet.** Anyone who can reach the port can read portal data through the service's credentials, so it binds to `127.0.0.1` by default. In production I'd put it behind a gateway with an API key or OAuth, TLS and per-client rate limits.
- **Portal problems aren't the caller's fault.** If the service's own login to the portal fails, the API returns 503, not 401 — the caller didn't do anything wrong.

## What I intentionally skipped

- Auth, CORS and rate limiting on this API (see above).
- Caching the live meter list/search (free-text `q`, and it is the source of truth), cache invalidation (there is none: only TTLs), and a shared cache across instances.
- Deleting meters from the index when they disappear from the portal, and incremental sync.
- The web client.
- Repairing hierarchy levels that the export leaves empty (14 meters live), or rebuilding them for meters missing from the export — they are reported in `/v1/network/issues` (`incomplete_hierarchy`, `meter_not_in_export`) and just get `null` for those levels on meter detail.
- Parsing the portal's per-page `__data.json` (awkward format, and the same data is available as clean JSON anyway).
- Docker, queues, an ORM, a frontend framework — overkill at this size.

## What I'd improve with more time

- A background refresh (serve cached, refresh behind the scenes) and a scheduled sync, so no request ever waits on the 230 KB export.
- Back off on repeated login failures: with a wrong password every request currently retries the login, which a shared portal could treat as an attack.
- Measure how often the portal's data really changes and tune the TTLs from that, instead of from my judgement.
- Actually confirming the bits I guessed: what the portal does past the last page (I never requested `page=2` of the export), and how it responds to an unknown meter.
- A scheduled, incremental sync with deletions, Postgres + PostGIS if the fleet grew by orders of magnitude, and a small web client.
- Rebuilding hierarchy for meters outside the export using `dtCode` and the transformer list.
- Running the shutdown path for real and doing a quick load test, plus an opt-in test that checks real portal responses against the fixtures to catch the portal changing.
- Auth and per-client rate limits on this API.

## Reflection

**What assumptions did you make?**

Yes,I made a few small assumptions to keep things moving. The portal has two ways to list meters,but the counts didn't match,so I used the search endpoint as the main source and treated the export as additional information. Some values came back as text,like '42594.05',so I assumed they could be safely converted into numbers. I also checked the first page of results to understand the data structure before looking at the rest.

**Which part was most difficult, and how did you get unstuck?**

Okay,its the signed export. That endpoint needed an `x-signature` and a timestamp, and I couldn't just copy them because they change every time. The code that builds them was minified, so it was rough to read. My first instinct was to keep trying different formats against the server until one worked, but that felt wrong to do to a shared system I was told to treat as read-only,so I backed off. What actually worked was opening the frontend JavaScript in the browser's Sources tab, pretty-printing it, and searching for the header name until I found the function that builds the signature. It showed that the secret comes from a `/portal/keys` call and that the signed message is just the method, path, query and timestamp joined by newlines. Once I copied that exactly, the first request came back 200 and I was pretty relieved.

**If you had another day, what would you improve?**

The thing I keep thinking about is making the data trustworthy over time, not just correct right now. I'd add a small webhook or notification path so that when a sync finishes, or when `/v1/network/issues` finds something off, like an orphan meter or a transformer that doesn't line up,it actually tells someone, instead of the problem just sitting in a JSON response nobody looks at. Right now the service can find bad data but can't raise its hand about it. I'd also like to put some basic metrics behind it (how often the cache is actually helping, how slow the portal really is) so the tuning I did by gut feel could be checked against real numbers. Neither is in the brief, but both are the kind of thing that would make this usable by an actual ops team rather than just a demo.

**What mistake did you make?**

I spent way too long trying to read the minified frontend code line by line before it clicked that I could just use the browser's search to jump straight to the part I needed. I wasted a good chunk of time doing it the hard way.

**If you were reviewing your own submission, what would you criticise?**

Honestly, a lot of it rests on small samples, one metre's energy, three export rows, a handful of responses, so some of my "assumptions" are really just educated guesses I never confirmed. The tests all use mocks, so they'd never catch the real portal changing; only the opt-in smoke test hits the live site. The field naming ended up a bit inconsistent (`camelCase` from the portal, `snake_case` for the fields I add) because I didn't decide on one early. And I'll admit I went further into the extensions,the network tree, the sync/index, the caching, than I strictly needed to, which was fun, but it's fair to ask whether that time would've been better spent hardening the core and confirming the things I guessed at.
