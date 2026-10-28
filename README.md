# Urja Meter API

A small read-only API that sits in front of the old "Urja Meter Ops" web portal. The portal is what the utility's field staff use to look up smart meters, but it has no API, so the only way to get data out was copy-pasting from the browser. This service fixes that: it logs into the portal itself, reads from the portal's own hidden JSON endpoints, tidies the data up (real numbers instead of strings, proper ISO timestamps, one consistent error format) and hands it back as a clean API that another program can use.

If you just want to see what it returns, jump to [Sample requests](#sample-requests). For how the portal actually works under the hood, see [PROTOCOL.md](PROTOCOL.md). The API description is in [openapi.json](openapi.json), and my working notes while building this are in [notes/](notes/).

## Quick start

You'll need Node.js 22 or newer, npm, and the portal username and password (not included in this repo).

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

| Method | Path                                     | Purpose                                                         |
| ------ | ---------------------------------------- | --------------------------------------------------------------- |
| GET    | `/health`                                | Service status and whether the portal is reachable              |
| GET    | `/v1/meters?q&limit&offset`              | List or search meters (`limit` 1-200, default 50)               |
| GET    | `/v1/meters/{meterId}`                   | Meter detail: nameplate, location, network hierarchy            |
| GET    | `/v1/meters/{meterId}/consumption`       | Raw 30-minute readings (cumulative kWh / kVAh, R-phase voltage) |
| GET    | `/v1/meters/{meterId}/consumption/daily` | Derived daily totals plus the count of skipped days             |
| GET    | `/v1/transformers?limit&offset`          | Distribution transformers with feeder and capacity              |

Full schemas are in [openapi.json](openapi.json), or `/docs` while the service is running. Error codes: 400 bad request, 404 unknown meter or route, 502 the portal failed or returned something unreadable, 503 this service couldn't log into the portal, 504 the portal timed out.

Note: `/health` makes one real call to the portal every time, since that's the only honest way to say whether the portal is up. Don't point a fast health-check at it.


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
  routes/              health.js, meters.js, transformers.js
  portal/
    client.js          login, cookies, retries, re-login, timeouts, concurrency cap, export signing
    parsers.js         pure functions: raw portal JSON in, clean objects out
    errors.js          PortalAuthError, PortalNotFound, PortalUnavailable, PortalParseError
scripts/
  export-openapi.js    writes openapi.json (npm run openapi)
  capture-fixtures.js  one-off script I used to save the redacted test fixtures
test/                  unit and API tests, with fixtures in test/fixtures/
notes/                 my working notes: protocol findings, decisions, mistakes

```

The flow for a request is: the **route** checks the input and declares what it returns, the **service** works out which portal calls are needed, the **portal client** handles logging in and actually fetching, and the **parsers** turn the portal's messy JSON into clean objects (or throw if the shape is wrong). If anything fails anywhere, the **error handler** catches it and returns the one standard error shape.

One small bit of caching: the service keeps a single copy of the portal's bulk export in memory for 60 seconds, so that back-to-back meter-detail requests don't each re-download ~230 KB. That's the only caching in here.


The flow for a request is: the **route** checks the input and declares what it returns, the **service** works out which portal calls are needed, the **portal client** handles logging in and actually fetching, and the **parsers** turn the portal's messy JSON into clean objects (or throw if the shape is wrong). If anything fails anywhere, the **error handler** catches it and returns the one standard error shape.

One small bit of caching: the service keeps a single copy of the portal's bulk export in memory for 60 seconds, so that back-to-back meter-detail requests don't each re-download ~230 KB. That's the only caching in here.

## How the portal works (short version)

The portal is a SvelteKit app. Once you log in through its form, the browser quietly calls cookie-authenticated JSON endpoints under `/portal/*` for meters, location, 30-minute energy readings and transformers — so there was a real API hiding behind the page all along, just an undocumented, internal one. There's also a bulk export with richer data (including the full seven-level network hierarchy), but it's locked behind an HMAC signature. The interesting part is that the portal hands the signing key to any logged-in session, so the service can sign its own export requests. The full write-up, including the quirks and the things I couldn't confirm, is in [PROTOCOL.md](PROTOCOL.md).

## Configuration

Config is read once at startup from the environment (a `.env` file is loaded if it's there). If a required variable is missing or invalid, the service refuses to start and tells you which one.

| Variable             | Default         | Meaning                                                        |
| -------------------- | --------------- | -------------------------------------------------------------- |
| `PORTAL_BASE_URL`    | none (required) | Portal address, e.g. `https://urja-ops.flockenergy.tech`       |
| `PORTAL_USERNAME`    | none (required) | Portal login email                                             |
| `PORTAL_PASSWORD`    | none (required) | Portal login password                                          |
| `REQUEST_TIMEOUT_MS` | `20000`         | Timeout for each request to the portal                         |
| `MAX_CONCURRENCY`    | `3`             | How many requests hit the portal at once (1 to 4)              |
| `MAX_RETRIES`        | `3`             | Retries after a timeout, network error, 5xx or 429 (0 to 10)   |
| `HOST`               | `127.0.0.1`     | Address to listen on                                           |
| `PORT`               | `3000`          | Port to listen on                                              |
| `LOG_LEVEL`          | `info`          | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` |
| `NODE_ENV`           | `production`    | Set to `development` for readable logs (`pino-pretty`)         |

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
- The export probably returns everything in one page — I'm going off the response size, I didn't confirm it.
- The login is a urlencoded form with `email` and `password`. It worked first try, so I didn't dig further into the browser's exact request.
- An unknown meter returns 404 from the portal's location/energy endpoints. I never actually saw this happen; the detail route doesn't rely on it.
- Meter IDs are letters, digits, `_` and `-`, up to 32 characters — based on the one format I saw (`J100000`).

## Design decisions and trade-offs

- **Node + Fastify instead of Express.** Fastify validates input and shapes output straight from JSON Schema, has logging built in, and can generate the OpenAPI spec from the same schemas. Speed wasn't the reason — the portal is always going to be the slow part.
- **Plain JavaScript, not TypeScript.** For a service this small, skipping a build step and a compiler felt like the right trade. JSDoc covers the exported functions.
- **One set of JSON Schemas does everything.** The same schema validates the request, shapes the response (and quietly drops anything not in it), and feeds `openapi.json`. A test fails if the committed spec drifts from the code.
- **Search is the source of truth; the export just enriches.** The export and search disagreed about the meter count early on, so the list always comes from search. Meters not in the export get `null` for hierarchy rather than a made-up value.
- **Signing the export.** I worked out the signature by reading the portal's own frontend code, not by firing trial requests at it. The key is fetched from `/portal/keys` at request time, used in memory, and never stored or logged.
- **Re-login on 401.** If a `/portal/*` call comes back 401, the client logs in once more and retries once; a bunch of requests arriving together share a single login. A second 401 is reported as an auth failure instead of looping forever.
- **Strict for single meters, forgiving for the bulk pull.** A broken response for one meter's data is an error. A single broken row in the big export is skipped and logged (with a count and a sample) so one bad meter doesn't sink the whole thing.
- **Skipped days are reported, not hidden.** If a day's reading goes backwards (a reset or meter swap) it's left out and counted in `skippedDays`, rather than showing a negative or nonsense figure.
- **A 60-second memo of the export, not a real cache.** Without it, every meter-detail request would pull ~230 KB. A proper cache needs a freshness policy, size limits and invalidation, which I left for later. The memo is one entry, shared by callers, never caches a failure, and can be up to 60 seconds stale.
- **Retries and being polite to a shared system.** Timeouts, network errors, 5xx and 429 are retried with backoff and jitter (respecting `Retry-After`, capped at 30 s); other 4xx aren't retried. At most 3–4 requests run at once, everything has a timeout, and every loop over pages is bounded.
- **No auth on this API yet.** Anyone who can reach the port can read portal data through the service's credentials, so it binds to `127.0.0.1` by default. In production I'd put it behind a gateway with an API key or OAuth, TLS and per-client rate limits.
- **Portal problems aren't the caller's fault.** If the service's own login to the portal fails, the API returns 503, not 401 — the caller didn't do anything wrong.

## What I intentionally skipped

- Auth, CORS and rate limiting on this API (see above).
- A general cache with freshness rules, and any database or local index — apart from the 60-second export memo, every request reads live from the portal.
- The optional extensions: a `/v1/network` hierarchy endpoint, a "meters near this location" query, and a web client.
- Rebuilding the upper hierarchy levels for meters missing from the export — they just get `null`.
- Parsing the portal's per-page `__data.json` (awkward format, and the same data is available as clean JSON anyway).
- Docker, queues, an ORM, a frontend framework — overkill at this size.

## What I'd improve with more time

- A real cache with a clear freshness rule, and a background sync so no request has to wait on the 230 KB export.
- Actually confirming the bits I guessed: the export's real page size and what happens past the last page, and how the portal responds to an unknown meter.
- The optional extensions — a `/v1/network` tree, a local index (SQLite would probably be plenty for a fleet this size) for filtering and "near me" queries, and a small web client.
- Rebuilding hierarchy for meters outside the export using `dtCode` and the transformer list.
- Running the shutdown path for real and doing a quick load test, plus an opt-in test that checks real portal responses against the fixtures to catch the portal changing.
- Auth and per-client rate limits on this API.

## Reflection

**What assumptions did you make?** Mostly small, practical ones. I assumed the search endpoint was the full list of meters and used that as my main source, treating the export mainly as extra detail. I assumed an unknown meter would come back as a 404, that values coming through as text could just be parsed into numbers, and that the first page of results was enough to understand the shape before handling the rest. Most of these I only wrote down as assumptions rather than fully verifying, mainly to save time.

**Which part was most difficult, and how did you get unstuck?** Definitely the signed export. That endpoint needed an `x-signature` and a timestamp header, and I couldn't just copy them because they change every time. The code that builds them was minified so it was hard to read. My first idea was to just keep trying different formats against the server until one matched, but that felt wrong to do to a shared system I was told to treat as read-only, so I stopped. What actually worked was opening the frontend JavaScript in the browser's Sources tab, pretty-printing it, and searching for the header name until I found the function that builds the signature. It showed the secret comes from a `/portal/keys` call and that the signed message is just the method, path, query and timestamp joined by newlines. Once I copied that exactly, the first request came back 200 and I was pretty relieved.

**If you had another day, what would you improve?** I'd add a real cache instead of the 60-second in-memory copy I have now, because meter detail still quietly downloads the whole export, and that doesn't feel great. I'd also go back and actually confirm the things I only guessed, what the export does past the last page, and what the portal returns for a meter that doesn't exist,instead of leaving them as assumptions. After that I'd try one of the optional extensions, probably the network hierarchy, since the data for it is already there. And I'd test the graceful shutdown properly; I wrote it but never got to run it on my machine.

**What mistake did you make?** I spent way too long trying to read the minified frontend code line by line before it clicked that I could just use the browser's search to jump straight to the part I needed. I wasted a good chunk of time doing it the hard way.

**If you were reviewing your own submission, what would you criticise?** Honestly, a lot of it is based on small samples, one metre's energy, three export rows,a few responses ,so some of my "assumptions" are really just educated guesses I never confirmed. The tests all use mocks, so they'd never notice if the real portal changed; only the optional smoke test hits the live site. Meter detail can be slow once the 60-second copy expires, and `/health` calls the portal every single time, which isn't ideal. There's no auth on the API, and the field naming is a bit inconsistent (`camelCase` from the portal, `snake_case` for my own fields) because I didn't decide on one early.I also didn't get to any of the extensions.
