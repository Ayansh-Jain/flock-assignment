# Urja Meter Ops portal: how it works

What I learned about the legacy portal at `https://urja-ops.flockenergy.tech` by using it in a browser with DevTools. Nothing here comes from probing beyond what a normal logged-in user does, and no cookie, token or signing secret is recorded.

Tags used throughout:

- **[Observed]**: seen in a real request, response or the frontend JavaScript, and kept in `test/fixtures/` where it is a response.
- **[Assumed]**: inferred or taken from a field name, not verified.

## 1. Overview

- **[Observed]** The portal is a SvelteKit app. Everything the UI shows is available as JSON, so no HTML scraping is needed.
- **[Observed]** The data comes from a cookie-authenticated JSON API under `/portal/*`. Every response is an envelope `{"data": ...}` (lists also carry `total`, `page`, `pageSize`).
- **[Observed]** The UI shows meters, a meter's position in the network, 00:00 consumption rows, and an "Export all meters" button on the `/transformers` page.
- **[Observed]** SvelteKit also serves page data at `/<page>/__data.json`. It is in a compact index-pointer format ("devalue") that is awkward to parse, so I do not use it. The same facts are available as clean JSON elsewhere.

## 2. Auth and session

- **[Observed]** Login is a SvelteKit form action called with fetch: `POST /login`. The result is in the JSON **body**, not the HTTP status:
  - success: `{"type":"redirect","status":303,"location":"/meters"}` (HTTP 200)
  - bad credentials: `{"type":"failure","status":401,"data":"..."}`. The `data` string is a devalue array that echoes the submitted email, so I never log or return it.
- **[Assumed]** The login body is urlencoded `email` + `password`, sent with `x-sveltekit-action: true` and an `Origin` header. The field names come from the failure payload; the capture script used this form and got a successful login, but I did not capture the browser's own request to compare.
- **[Observed]** The session is a cookie that the portal sets on login and the API expects on `/portal/*`. I did not record its name or flags.
- **[Reported by the author, not in my captured notes, unverified]** The session lasts about an hour.
- **[Observed]** A `/portal/*` call without a valid session returns HTTP `401` with `{"error":"unauthorized","message":"A valid session is required."}`. That is an unambiguous signal: a login page is never served with HTTP 200 on the API.
- **[Observed]** Sign-out is `POST /api/auth/sign-out` -> `{"success":true}`. The service never calls it.
- **How this service reacts** (our design, not portal behaviour): log in lazily on the first request, share one login between concurrent callers, and on a `/portal/*` 401 reset the cookies, log in once more and retry once. A second 401 is reported as an auth failure.

## 3. Data endpoints

All are `GET`, cookie-authenticated, read-only.

| Endpoint                          | Returns                                                                                       | Notes                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/portal/meters/search?q=&page=N` | `{data:[{meterId, serialNo, make, phaseType, installStatus, dtCode}], total, page, pageSize}` | `q` partially matches `meterId` and `serialNo` (`q=GE84` gave 4 hits). Empty `q` returns everything. |
| `/portal/meters/<id>/geo`         | `{data:{latitude, longitude}}`                                                                | Both values are **strings**.                                                                         |
| `/portal/meters/<id>/energy`      | `{data:[{timestamp, kwh, kvah, voltR}]}`                                                      | 30-minute readings; all values are **strings**. See section 6.                                       |
| `/portal/dts?page=N`              | `{data:[{code, name, feederCode, capacityKva}], total, page, pageSize}`                       | Distribution transformers. `capacityKva` is a number.                                                |
| `/portal/keys`                    | `{data:{signingSecret}}`                                                                      | Fetched by the frontend before an export. See section 5.                                             |
| `/portal/export?page=N`           | `{data:[...rich meter rows...], total}`                                                       | Needs `x-signature` and `x-timestamp` headers. See section 5.                                        |

- **[Observed]** The export row is a superset of the search row: it adds `installType`, `build`, a 7-level `hierarchy` and numeric `geo`.
- **[Observed]** The meter IDs look like `J100000`, `J100001`, ... Transformer codes look like `DT-001`, feeder codes like `F-001`.

## 4. Pagination

- **[Observed]** Search: `pageSize` 20, `total` 403, so 21 pages. `page` is 1-based.
- **[Observed]** Transformers: `pageSize` 20, `total` 40, so 2 pages.
- **[Observed]** The export response has only `data` and `total`. See section 5 for what its page size seems to be.
- **[Not observed]** What any endpoint returns for a page past the last one. The service therefore never requests a page past the last.
- **[Not observed]** Whether the page size can be changed, and any sort or filter parameters other than `q`.

## 5. Bulk path and signing

`/portal/export` is the one bulk path. It returns richer rows than search, including the network hierarchy.

- **[Observed]** Each request needs two headers:
  - `x-timestamp`: Unix epoch **seconds**, as a string.
  - `x-signature`: 64 lowercase hex characters, an HMAC-SHA256.
- **[Observed, read from the frontend JavaScript]** The signed message is four lines joined with `\n`:

  ```
  GET
  /portal/export
  page=<n>
  <timestamp>
  ```

  The third line is the literal query string without `?`; the second line has no query. The key is the `signingSecret` returned by `GET /portal/keys`.

  ```js
  import { createHmac } from 'node:crypto';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = ['GET', '/portal/export', `page=${page}`, timestamp].join('\n');
  const signature = createHmac('sha256', signingSecret).update(message).digest('hex');
  ```

- **[Observed]** I did this from the frontend JavaScript and then confirmed it: a signed `GET /portal/export?page=1` returned HTTP 200.
- **[Observed]** `/portal/keys` hands the signing secret to **any** logged-in session. The signature therefore proves the caller can run the portal's frontend code, not that it has special access. It is an integrity check at best, not access control.
- **[Observed]** The portal UI always requests `page=1` and never loops, yet reports "Exported 100 meters".
- **[Observed]** The `content-length` of the original page-1 response was 231,658 bytes.
- **[Assumed]** From that size, page 1 may hold the whole dataset (roughly 400 rows at about 575 bytes each) rather than 100. The export's page size, and whether pages 2+ exist, are not confirmed. The service pages the export defensively: bounded, and stopping on an empty or repeated page.
- **[Unknown]** How long a signature stays valid (the replay window). The service signs each attempt with a fresh timestamp.

## 6. Data model and normalisation

| Portal value                                                                    | What this service does                                                                               |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `kwh`, `kvah`, `voltR`, `latitude`, `longitude` come as strings                 | Parsed to numbers. An empty, non-numeric or out-of-range value is a parse error, never `0` or `NaN`. |
| Timestamps like `"23/06/2026 23:30"` have no timezone                           | **[Assumed]** IST. Output as ISO-8601 with `+05:30`, e.g. `2026-06-23T23:30:00+05:30`.               |
| `kwh` and `kvah` are cumulative registers                                       | **[Assumed]** from the values: they grow reading by reading. Per-day totals are differences.         |
| No units anywhere                                                               | **[Assumed]** kWh and kVAh, from the field names. Only R-phase voltage is available.                 |
| Export `geo` is `{lat, lng}` numbers; `/geo` is `{latitude, longitude}` strings | Both normalised to `{latitude, longitude}` numbers.                                                  |

**Network hierarchy** **[Observed]** is seven levels in the export, each `{name, code}`: `zone` > `circle` > `division` > `subdivision` > `substation` > `feeder` > `dt`. Search rows only carry a `dtCode`, so a meter outside the export has no hierarchy here (`null`). The upper levels are not reconstructed from `dtCode`.

**Daily consumption** is derived, not provided. For each IST calendar day, the total is the last reading of that day minus the last reading of the previous day. A day is reported only if it ends at 23:30 and the previous day also does.

- The sample meter has **337 readings**, from `23/06/2026 23:30` to `30/06/2026 23:30`. That is 7 days of 48 readings plus one extra reading, not 8 full days.
- The first reading (23 Jun, 23:30) is not midnight, so 23 Jun is never a complete day. It only anchors 24 Jun.
- The result is **7 daily totals, 24 to 30 June**.
- A day is skipped, and counted in `skippedDays`, if there is a gap before it, it ends early, or the register went backwards (a reset or meter swap would give a negative figure). The first day and a short last day are expected edges and are not counted.
- Differences are rounded to two decimals to remove float noise.

## 7. Quirks and surprises

- **Mixed types.** Energy and `/geo` values are strings; `capacityKva` and the export's `geo` are numbers.
- **Login status code.** A failed login is HTTP 200 with the failure inside the JSON body. Reading only the HTTP status would treat bad credentials as success.
- **Serials.** The serial prefix is unrelated to `make` (for example `GE84132` is an L&T meter). Serials can contain `&` (for example `L&84997`) and `make` can too (`L&T`), so values going into URLs must be encoded.
- **Export count.** An early capture showed the export reporting `total: 100` while search reported 403. The saved export response has `total: 403`, matching search. **[Assumed]** the 100 was the UI's "Exported 100 meters" figure, not the export's `total`. Search stays the source of truth for the meter list.
- **First reading at 23:30.** The energy series starts at 23:30, not 00:00, so the first day is never complete and a series gives 7 daily totals.
- **Two shapes of the same fact.** Location is a string pair on one endpoint and a numeric pair on another.
- **The signing secret is public to any session** (section 5).
- **The UI hides data.** It shows only the 00:00 energy rows, but the API returns all 30-minute readings.

## 8. Open questions and not observed

- Behaviour for a page past the last one (all paged endpoints), and the export's real page size and last page.
- What `/portal/meters/<id>/geo` and `/energy` return for an unknown meter. The service assumes HTTP 404 and maps it to "meter not found"; this has never been seen.
- What the portal returns with HTTP 403. The service treats it as an auth problem; never seen.
- Signature replay window; session lifetime and cookie flags; rate limiting (no HTTP 429 or `Retry-After` has been seen, though the client honours them).
- Whether `build` has values other than `legacy`, and whether meters or `dtCode` values exist that are missing from the other endpoints.
- Whether every meter's energy series has the same window (23 Jun 23:30 to 30 Jun 23:30) and no gaps. I checked only the sample meter.
- Graceful shutdown of this service on SIGINT/SIGTERM is implemented but I did not exercise it.
