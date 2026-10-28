# Protocol notes — Urja Meter Ops portal

How the portal actually works, as I pieced it together. Every item is tagged **[Observed]** (I saw it in a real request, response, or page) or **[Assumed]** (I inferred it and didn't verify). No secrets live here — no cookie values, no signing secret, no password.

## Auth & session

- [Observed] The UI is a SvelteKit app. Login is a SvelteKit form action called over fetch: `POST /login`.
- [Observed] On success you get HTTP 200 with the body `{"type":"redirect","status":303,"location":"/meters"}`. The 303 is inside the JSON — it is not the HTTP status.
- [Observed] On bad credentials: `{"type":"failure","status":401,"data":"[{\"email\":1,\"error\":2},\"<email>\",\"Invalid email or password.\"]"}`. That `data` field is a devalue-flattened array serialised as a string. The upshot: you have to read success vs failure off the body `type`, not the HTTP status — both come back 200 at the transport level.
- [Observed] Sign-out: `POST /api/auth/sign-out` → `{"success":true}`.
- [Observed] A logged-out call to the JSON API comes back clean: HTTP 401 `{"error":"unauthorized","message":"A valid session is required."}`. Nice and easy to detect — it doesn't serve a login page with a 200 on `/portal/*`.
- [Observed] `/portal/*` is cookie-authenticated.
- [Observed] The logged-in user shows as "Ops Desk" (from `/meters/__data.json`).
- [Not captured] Cookie names and flags, any CSRF token, the exact session lifetime, what a *page* (non-API) request does when logged out, and whether "remember me" exists.

## Endpoints / pages

All the JSON endpoints below are cookie-authenticated and wrap their payload in `{"data": ...}`.

| Endpoint                              | Purpose                                                                           | Status                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `POST /login`                         | log in (SvelteKit form action)                                                    | [Observed]                                                          |
| `POST /api/auth/sign-out`             | log out                                                                           | [Observed]                                                          |
| `GET /meters/__data.json`             | SvelteKit page data; user info only                                               | [Observed]                                                          |
| `GET /meters/<id>/__data.json`        | meter detail page data: nameplate + breadcrumb in devalue index-pointer format    | [Observed] exists; deliberately **not** parsed (use the export)     |
| `GET /portal/meters/search?q=&page=N` | paged meter list / search                                                         | [Observed]                                                          |
| `GET /portal/meters/<id>/geo`         | latitude/longitude (as strings)                                                   | [Observed]                                                          |
| `GET /portal/meters/<id>/energy`      | 30-minute readings                                                                | [Observed]                                                          |
| `GET /portal/dts?page=N`              | distribution transformers                                                         | [Observed]                                                          |
| `GET /portal/keys`                    | returns `{"data":{"signingSecret":"..."}}`; the frontend fetches it before export | [Observed]                                                          |
| `GET /portal/export?page=N`           | signed bulk export (the "Export all meters" button on `/transformers`)            | [Observed]                                                          |

- [Observed] Here's the funny part: `GET /portal/keys` hands the signing secret to *any* logged-in session. So the signature is really integrity theatre, not access control — anyone logged in can sign their own export calls. Worth a line in the write-up. I fetch the secret at runtime and never store it.

## Data model

Search row (`/portal/meters/search`) [Observed]:
`{meterId, serialNo, make, phaseType, installStatus, dtCode}` — e.g. `J100001 / GE84132 / L&T / single / Installed / DT-002`.

Export row (`/portal/export`) [Observed] — a superset of the search row:
`meterId, serialNo, make, phaseType, installStatus, installType ("Whole Current"...), build ("legacy"/...), dtCode, hierarchy, geo`.

- `hierarchy` has 7 levels: zone, circle, division, subdivision, substation, feeder, dt — each `{name, code}`.
- `geo` here is `{lat, lng}` as **numbers**.

Geo endpoint [Observed]: `{"data":{"latitude":"26.82...","longitude":"75.90..."}}` — as **strings** this time.

Energy row [Observed]: `{timestamp:"23/06/2026 23:30", kwh:"42594.05", kvah:"46001.58", voltR:"231"}`.

- Every value is a string.
- `kwh` / `kvah` are running totals (cumulative registers), not per-interval usage.
- Only `voltR` — no Y/B phase voltages.
- Timestamp is `DD/MM/YYYY HH:mm` with no timezone ([Assumed] IST).
- 30-minute intervals; the UI only shows the midnight rows.
- The saved fixture has 337 readings: first `23/06/2026 23:30`, last `30/06/2026 23:30`. That's 7 days plus one reading (7 × 48 + 1), **not** 8 full days — which is exactly the thing I got wrong in Phase 1 (see mistakes.md). No gaps, duplicates or empties on the meter(s) I checked; [Assumed] the same holds for all of them.

Transformer row (`/portal/dts`) [Observed]: `{code:"DT-021", name:"Malviya Nagar DT 21", feederCode:"F-021", capacityKva:400}` — `capacityKva` is a number.

IDs [Observed]: meter IDs run `J100000`, `J100001`, ... upward; DT codes are `DT-nnn`; feeder codes are `F-nnn`. The payload never labels the energy units ([Assumed] kWh, from the field name).

## Pagination

- [Observed] `search`: `pageSize` 20, `total` 403, so 21 pages, 1-based. The response carries `data, total, page, pageSize`.
- [Observed] `dts`: 2 pages.
- [Observed] `export`: an early capture reported `total: 100` (see Quirks / Open questions). [Assumed] that was a page row-count or first-page figure, not the real dataset size.
- [Not captured] Any page-size override, sort/filter params beyond `q`, what happens past the last page, and where the export's last page is.
- [Observed] Search matches both `meterId` and `serialNo`, partially (`q=GE84` → 4 hits). An empty `q` returns everything.

## Bulk path

- [Observed] `GET /portal/export?page=N` is the bulk path, and it's richer than search (hierarchy, geo, installType, build).
- [Observed] It needs two request headers: `x-signature` (64 hex chars, [Assumed] HMAC-SHA256) and `x-timestamp` (Unix epoch seconds).
- [Observed, read from the frontend JS — no portal traffic to figure this out] The signing scheme:
  - `x-timestamp = String(Math.floor(Date.now() / 1000))` (Unix seconds).
  - `message = ["GET", "/portal/export", "page=<n>", timestamp].join("\n")` — four lines; the query line is the literal `page=<n>` with no `?`, and the path line has no query on it.
  - `x-signature = HMAC-SHA256(signingSecret, message)` as lowercase hex.
  - `signingSecret` comes from `GET /portal/keys` at runtime.
- [Observed] Confirmed live: the capture script's signed `GET /portal/export?page=1` returned HTTP 200 using exactly this scheme. The export response has only `data` and `total` at the top level — no `page` / `pageSize`.
- [Observed] The saved export fixture's original `content-length` was 231,658 bytes for page 1. Rough back-of-envelope (~575 bytes a row) puts that around 400 rows — so page 1 may already hold the whole dataset. [Assumed], and worth confirming by actually counting rows in a full page 1.
- [Observed] The portal UI hardcodes `page=1` and never loops, yet tells you "Exported 100 meters".
- [Assumed] So the export page size is bigger than search's 20 (probably 100), and more pages might exist. The sync confirms this by requesting page 2, 3, ... — one signed request per page, fresh timestamp, bounded loop.

## Quirks

- [Observed] Types are inconsistent: energy and geo come back as strings (`kwh`, `kvah`, `voltR`, lat/long), but `capacityKva` and the export's `geo` are numbers.
- [Observed] A serial's prefix has nothing to do with its `make`. Serials can contain `&` (`L&84997`), and so can makes (`L&T`), so URL-encode them in queries.
- [Observed] Energy timestamps are `DD/MM/YYYY`, no timezone, and the first reading is at 23:30, not midnight — so the day boundaries don't line up with the first row.
- [Observed] **Count conflict (mostly cleared up):** an early capture showed export `total: 100` against search's `total: 403`. But the saved `export-page1` fixture actually has `total: 403`, matching search. [Assumed] the earlier "100" was the page's row count (the UI's "Exported 100 meters"), not the real total. Still worth confirming by paging the export.
- [Observed] Login returns 200 at the transport level either way, with the real result in the body (success is a redirect envelope; failure carries its own `status: 401` inside the JSON, with `data` as a stringified devalue array).
- [Observed] The meter-detail page data is devalue-encoded (index-pointer array), not plain JSON — which is why I used the export for the hierarchy instead.
- [Observed] The same fact shows up differently across endpoints: geo is string-typed from `/geo` but numeric in the export.

## Open questions

1. **Export vs search count.** The fixture shows export `total: 403`, same as search. Working theory [Assumed]: the "100" I saw earlier was a page row-count and there are more pages. Confirm by paging the export and comparing the set of `meterId`s against search. Until then, search is the meter list and the export only enriches.
2. ~~Export signature layout~~ — resolved from the frontend JS (see Bulk path) and confirmed live (signed page 1 returned 200).
3. Signature replay window / timestamp tolerance — only matters if clock skew ever shows up.
4. The export's last page and what comes after it — empty page? 404? a repeat?
5. Does `build: "legacy"` vs other values change the shape of the data? What values even exist?
6. Meters that are in search but missing from the export (they get `hierarchy: null`); and `dtCode` values that don't appear in `/portal/dts`.
7. The timezone of the energy timestamps ([Assumed] IST).
8. Session lifetime and cookie flags — not needed, since the client just re-logs-in on any 401.
9. Rate limiting (429 / Retry-After) — never actually hit it.
10. The exact login POST encoding. [Assumed and since confirmed working] urlencoded `email` / `password`, inferred from the failure payload's `email` key; the capture script's login succeeded live with this, so it holds, though I never diffed it byte-for-byte against the browser's own request.