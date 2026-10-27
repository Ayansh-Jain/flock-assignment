# Protocol notes — Urja Meter Ops portal

Every item is tagged **[Observed]** (seen in a real request/response/page, as reported by the author) or **[Assumed]** (inferred, not verified).
Secrets (cookie values, signing secret, password) are never recorded here.

## Auth & session

- [Observed] The UI is SvelteKit. Login is a SvelteKit form action called via fetch: `POST /login`.
- [Observed] Login success: HTTP 200 with body `{"type":"redirect","status":303,"location":"/meters"}`. The 303 is inside the JSON, not the HTTP status.
- [Observed] Login failure (bad credentials): `{"type":"failure","status":401,"data":"[{\"email\":1,\"error\":2},\"<email>\",\"Invalid email or password.\"]"}`. The `data` field is a devalue-flattened array serialised as a string. Success/failure must be decided on the body `type`, not the HTTP status.
- [Observed] Sign-out: `POST /api/auth/sign-out` -> `{"success":true}`.
- [Observed] Logged-out call to the JSON API: HTTP 401 `{"error":"unauthorized","message":"A valid session is required."}`. This is a clean, machine-detectable signal (no login page served with 200 on `/portal/*`).
- [Observed] `/portal/*` uses cookie auth.
- [Observed] The logged-in user is shown as "Ops Desk" (`/meters/__data.json`).
- [Not captured] Cookie names/flags, CSRF token (if any), session lifetime, behaviour of a _page_ (non-API) request when logged out, "remember me".

## Endpoints / pages

All JSON endpoints below are cookie-authenticated and return `{"data": ...}` envelopes.

| Endpoint                              | Purpose                                                                           | Status                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `POST /login`                         | log in (SvelteKit form action)                                                    | [Observed]                                                          |
| `POST /api/auth/sign-out`             | log out                                                                           | [Observed]                                                          |
| `GET /meters/__data.json`             | SvelteKit page data; user info only                                               | [Observed]                                                          |
| `GET /meters/<id>/__data.json`        | meter detail page data: nameplate + breadcrumb in devalue index-pointer format    | [Observed] exists; deliberately **not** parsed (use export instead) |
| `GET /portal/meters/search?q=&page=N` | paged meter list/search                                                           | [Observed]                                                          |
| `GET /portal/meters/<id>/geo`         | latitude/longitude (strings)                                                      | [Observed]                                                          |
| `GET /portal/meters/<id>/energy`      | 30-minute readings                                                                | [Observed]                                                          |
| `GET /portal/dts?page=N`              | distribution transformers                                                         | [Observed]                                                          |
| `GET /portal/keys`                    | returns `{"data":{"signingSecret":"..."}}`; fetched by the frontend before export | [Observed]                                                          |
| `GET /portal/export?page=N`           | signed bulk export ("Export all meters" on `/transformers`)                       | [Observed]                                                          |

- [Observed] `GET /portal/keys` hands the HMAC signing secret to any logged-in session, so the "signature" is integrity theatre rather than access control. Worth stating in the write-up. The secret is fetched at runtime and never stored.

## Data model

Search row (`/portal/meters/search`) [Observed]:
`{meterId, serialNo, make, phaseType, installStatus, dtCode}`, e.g. `J100001 / GE84132 / L&T / single / Installed / DT-002`.

Export row (`/portal/export`) [Observed], a superset of the search row:
`meterId, serialNo, make, phaseType, installStatus, installType ("Whole Current"...), build ("legacy"/...), dtCode, hierarchy, geo`.

- `hierarchy` has 7 levels: zone, circle, division, subdivision, substation, feeder, dt. Each is `{name, code}`.
- `geo` is `{lat, lng}` as **numbers**.

Geo endpoint [Observed]: `{"data":{"latitude":"26.82...","longitude":"75.90..."}}` as **strings**.

Energy row [Observed]: `{timestamp:"23/06/2026 23:30", kwh:"42594.05", kvah:"46001.58", voltR:"231"}`.

- All values are strings.
- `kwh` / `kvah` are cumulative registers (not per-interval).
- Only `voltR` (no Y/B phase).
- Timestamp is `DD/MM/YYYY HH:mm` with no timezone ([Assumed] IST).
- 30-minute interval; the UI shows only the 00:00 rows.
- 337 readings in the saved fixture: first `23/06/2026 23:30`, last `30/06/2026 23:30` = 7 days + 1 reading at 30-minute steps (not 8 full days: 7 x 48 + 1). No gaps, duplicates or empties seen on the meter(s) examined; [Assumed] holds for all.

Transformer row (`/portal/dts`) [Observed]: `{code:"DT-021", name:"Malviya Nagar DT 21", feederCode:"F-021", capacityKva:400}`. `capacityKva` is a number.

IDs [Observed]: meter IDs `J100000`, `J100001`, ... (from J100000 upward); DT codes `DT-nnn`; feeder codes `F-nnn`. Units for kWh are not labelled in the payload ([Assumed] kWh from the field name).

## Pagination

- [Observed] `search`: `pageSize` 20, `total` 403, 21 pages, `page` is 1-based. Response carries `data, total, page, pageSize`.
- [Observed] `dts`: 2 pages.
- [Observed] `export`: reports `total: 100` (see Quirks/Open questions). [Assumed] this is the page size or the first-page row count rather than the dataset size.
- [Not captured] Page-size override, sort/filter params other than `q`, behaviour past the last page, and the export's last page.
- [Observed] Search semantics: `q` matches both `meterId` and `serialNo`, partially (`q=GE84` -> 4 hits). Empty `q` returns everything.

## Bulk path

- [Observed] `GET /portal/export?page=N` is a bulk path with richer data than search (hierarchy, geo, installType, build).
- [Observed] Requires two request headers: `x-signature` (64 hex chars, [Assumed] HMAC-SHA256) and `x-timestamp` (Unix epoch seconds).
- [Observed, read from the frontend JS by the author; no portal traffic] Signing scheme:
  - `x-timestamp = String(Math.floor(Date.now() / 1000))` (Unix seconds).
  - `message = ["GET", "/portal/export", "page=<n>", timestamp].join("
")` (four lines; the query line is the literal `page=<n>`, no `?`; the path line has no query).
  - `x-signature = HMAC-SHA256(signingSecret, message)` as lowercase hex.
  - `signingSecret` comes from `GET /portal/keys` at runtime.
- [Observed] Confirmed live: the capture script's signed `GET /portal/export?page=1` returned HTTP 200 using this scheme. The export response has top-level keys `data` and `total` only (no `page` / `pageSize`).
- [Observed] The saved export fixture's original `content-length` header was 231658 bytes for page 1. At ~575 bytes per row (3 kept rows are ~1.1 KB pretty-printed, so this is a rough estimate), that is on the order of 400 rows, i.e. page 1 may already hold the whole dataset. [Assumed], to be confirmed by counting rows in a full page 1.
- [Observed] The portal UI hardcodes `page=1` and never loops, yet shows "Exported 100 meters".
- [Assumed] Therefore the export page size is larger than search's 20 (probably 100) and more pages may exist. To be confirmed by requesting page 2, 3, ... in the sync (one signed request per page, fresh timestamp, bounded loop).

## Quirks

- [Observed] Numbers are returned as strings in energy and geo (`kwh`, `kvah`, `voltR`, lat/long) but as numbers elsewhere (`capacityKva`, export `geo`). Inconsistent typing.
- [Observed] Serial prefix is unrelated to `make`. Serials may contain `&` (e.g. `L&84997`). Makes can contain `&` too (`L&T`), so URL-encode when used in queries.
- [Observed] Energy timestamps are `DD/MM/YYYY`, no timezone. The first reading is at 23:30, not 00:00, so day boundaries do not line up with the first row.
- [Observed] **Count conflict (partly resolved):** earlier capture showed export `total: 100` vs search `total: 403`. The saved `export-page1` fixture has `total: 403`, matching search. [Assumed] the earlier "100" was the first page's row count (the UI's "Exported 100 meters"), not `total`. Still to confirm by paging the export.
- [Observed] Login returns HTTP 200 for both outcomes' transport, with the real result in the body (success is a redirect envelope; failure carries its own `status: 401` inside JSON). Failure `data` is a stringified devalue array.
- [Observed] Meter detail data is devalue-encoded (index-pointer array), not plain JSON.
- [Observed] Different representations of the same fact across endpoints: geo is string-typed in `/geo` and numeric in `export`.

## Open questions

1. **Export vs search count.** The fixture shows export `total: 403`, equal to search. Working theory [Assumed]: the 100 seen earlier was the page row count, and further pages exist. Confirm by paging the export and comparing the union of `meterId`s to search. Until then: search is the meter list, export only enriches.
2. ~~Export signature layout~~ resolved from the frontend JS (see Bulk path). Pending live confirmation.
3. Signature replay window / timestamp tolerance (matters only if clock skew shows up).
4. Export last page and what follows it (empty page? 404? repeat?).
5. Does `build: "legacy"` vs other values change the data shape? Which values exist?
6. Meters present in search but missing from the export (hierarchy `null`); `dtCode` values that do not exist in `/portal/dts`.
7. Timezone of energy timestamps ([Assumed] IST).
8. Session lifetime and cookie flags (not needed: client re-logs-in on any 401).
9. Rate limiting (429 / Retry-After) not yet seen.
10. Exact login POST encoding (urlencoded vs multipart vs JSON) and field names: [Assumed] `email` / `password` urlencoded, from the failure payload (`email` key). The capture script assumes this; verify against DevTools.
