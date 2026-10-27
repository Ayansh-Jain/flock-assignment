# PROJECT CONTEXT — Flock Energy engineering take-home

## What this is

I am completing a take-home assignment for Flock Energy. A distribution utility runs an
ageing internal web portal, "Urja Meter Ops", used by field/operations staff to look up
smart-meter information: meter details, where a meter sits in the network, and its recent
consumption. The portal has NO API. Teams copy-paste from the browser.

Task: build a clean, documented API service in front of the portal that another engineer
or program can consume without ever touching the original portal.

Portal URL: https://urja-ops.flockenergy.tech
Credentials: provided to me; they live ONLY in a local .env file
(PORTAL_USERNAME, PORTAL_PASSWORD). Never ask me to paste them into code or chat.

## Time budget

4–6 hours total. A focused, well-reasoned partial solution beats an exhausted "complete"
one. If over budget, stop and document what would come next.

## Evaluation order (optimise for this)

1. Problem solving — breaking down an unfamiliar system
2. Engineering judgment — trade-offs, appropriately sized (not over/under-engineered)
3. Learning ability
4. Communication — clear explanation of what was built, assumed, and why
5. Code quality — readable, sensibly organised, maintainable
6. Architecture, testing, speed (least important)
   No points for fancy tools.

## Required deliverables (public GitHub repo)

1. Source code for the API service.
2. README.md — the front door, assumes zero prior context. Must contain or link to: what
   was built and how it's structured; install/configure/run; a sample request;
   assumptions; design decisions & trade-offs; what was intentionally skipped; what I'd
   improve with more time; where to find PROTOCOL.md and openapi.json; Reflection.
3. PROTOCOL.md — how the portal actually works as discovered: data available, how to get
   it, how auth/access works, quirks and surprises. One of the most valuable deliverables.
4. openapi.json — OpenAPI 3.x description of OUR clean API (not the portal's).
   Rendered view (Swagger UI) is optional but nice.
5. Notes: assumptions, design decisions & trade-offs, what was left out and why, what
   I'd improve.
6. Reflection (## Reflection in README), a paragraph each:
   - What assumptions did you make?
   - Which part was most difficult, and how did you get unstuck?
   - If you had another day, what would you improve?
   - What mistake did you make (there's always one)?
   - If reviewing your own submission, what would you criticise?

## Optional extensions (only if time)

- Network hierarchy: reconstruct and expose it; watch for messy/inconsistent data.
- Local index/query layer: answer questions the portal can't (cross-attribute filters,
  "what's near this location?"); note at what scale it would struggle and what to change.
- Freshness/caching: how staleness is decided.
- Robustness: long-running sessions, portal misbehaviour, handled gracefully.
- Full dataset: there may be a bulk path out of the portal; using it well is a plus.
- Modern web client on top of OUR API (charts, map, hierarchy explorer, anomalies).

## Chosen stack (do not change or add libraries without asking me)

Language: plain JavaScript (NOT TypeScript), ES modules ("type": "module").
Runtime: Node.js 22 LTS or newer ("engines" field in package.json; .nvmrc).
Package manager: npm, package-lock.json committed, exact versions (.npmrc save-exact=true).
HTTP framework: Fastify v5 — chosen over Express for built-in JSON Schema validation,
fast serialisation, a built-in structured logger (pino) and first-class OpenAPI support.
(Raw framework speed is NOT the reason: the upstream portal is the bottleneck.)
API docs: @fastify/swagger (generates openapi.json from route schemas) +
@fastify/swagger-ui (serves /docs).
Schemas: plain JSON Schema objects in one module — one definition drives request
validation, response serialisation and OpenAPI. No zod, no TypeBox.
Config: env-schema (Fastify ecosystem, same JSON Schema style) + Node's built-in
process.loadEnvFile() when a .env exists. No dotenv.
Portal HTTP client: Node's built-in fetch (undici). Cookies via tough-cookie
(fetch does NOT keep cookies). Timeouts via AbortSignal.timeout(). Use
redirect: "manual" where we must detect redirects to the login page.
Concurrency: p-limit. Retries/backoff: a small hand-written helper (no retry library).
HTML parsing: cheerio — ONLY if the portal turns out to be server-rendered HTML.
Tests: Node's built-in test runner (node:test + node:assert), undici MockAgent to mock
the portal, fastify.inject() for API tests, node:test mock.timers for time. No Jest.
Lint/format: ESLint (flat config, @eslint/js recommended + eslint-plugin-n) + Prettier.
Types without TypeScript: JSDoc on exported functions; optional // @ts-check.
Extensions only: better-sqlite3 (index), lru-cache (cache), @fastify/static (web client).

## Project layout

src/
config.js # env loading + validation (env-schema), frozen config object
portal/client.js # login, cookie jar, retries, re-login, timeouts, concurrency cap
portal/parsers.js # pure functions: raw portal response -> plain objects
portal/errors.js # PortalError, PortalAuthError, PortalNotFound, # PortalUnavailable, PortalParseError
schemas.js # JSON Schemas for OUR API (requests, responses, errors)
service.js # client + (later) cache + normalisation
routes/health.js, routes/meters.js, routes/network.js
app.js # buildApp(options) factory — used by server AND tests
server.js # listen + graceful shutdown (SIGINT/SIGTERM)
scripts/export-openapi.js, scripts/capture-fixtures.js
test/ (fixtures/, parsers.test.js, client.test.js, api.test.js, openapi.test.js,
live-smoke.test.js)
notes/ (protocol-notes.md, decisions.md, mistakes.md)

## npm scripts

dev (node --watch src/server.js), start, test (node --test), lint, format,
format:check, openapi (writes openapi.json), capture-fixtures, sync (extension only).

# PORTAL FACTS (confirmed in Phase 1) — build against these

STACK

- SvelteKit app + better-auth session cookies + a cookie-authed JSON API under /portal/*.
- No HTML scraping needed; cheerio NOT required.
- robots.txt allows everything.

AUTH

- Login: POST /login, content-type application/x-www-form-urlencoded, body fields
  email + password, header x-sveltekit-action: true, Origin set to the portal.
  Success -> HTTP 200 with body {"type":"redirect","status":303,"location":"/meters"}.
  Bad credentials -> HTTP 200/401 with body {"type":"failure","status":401,...}.
  Read the RESULT FROM THE BODY, not the HTTP status.
- Session cookie __Secure-better-auth.session_token; lifetime ~1 hour.
- Any /portal/* call while logged out -> HTTP 401 {"error":"unauthorized",
  "message":"A valid session is required."}. Client detects this -> re-login once -> retry.
- Logout: POST /api/auth/sign-out -> {"success":true} (clears cookies). Not needed by client.

DATA ENDPOINTS (GET, cookie auth, application/json)

- /portal/meters/search?q=<text>&page=<n>
  -> {"data":[{meterId,serialNo,make,phaseType,installStatus,dtCode}],
  "total":403,"page":1,"pageSize":20}. 1-based pages, 21 pages. q matches meterId AND
  serialNo, partial. Empty q returns all. THIS IS THE SOURCE OF TRUTH for the meter list.
- /portal/meters/<id>/geo -> {"data":{"latitude":"26.8...","longitude":"75.9..."}} (strings)
- /portal/meters/<id>/energy -> {"data":[{"timestamp":"DD/MM/YYYY HH:mm","kwh":"..",
  "kvah":"..","voltR":".."}]} = exactly 8 days of 30-MINUTE readings
  (first 23/06/2026 23:30, last 30/06/2026 23:30), no gaps/dupes/empties; all values
  strings; kwh/kvah are CUMULATIVE registers. voltR only (no Y/B phase).
- /portal/dts?page=<n> -> {"data":[{code,name,feederCode,capacityKva(number)}]} (2 pages).
- /portal/keys -> {"data":{"signingSecret":"..."}}. Fetch at RUNTIME before export.
  NEVER hardcode/log/commit/fixture this secret.
- /portal/export?page=<n> -> richer rows: adds installType, build, full 7-level hierarchy
  {zone,circle,division,subdivision,substation,feeder,dt} each {name,code}, and
  geo {lat,lng} as NUMBERS. Requires signed headers (below).

EXPORT SIGNING (confirmed from frontend JS and verified live)

- x-timestamp = String(Math.floor(Date.now()/1000)) (Unix seconds).
- message = [method, path, query, timestamp].join("\n"), i.e. four lines:
  GET
  /portal/export
  page=<n>
  <timestamp>
  3rd line is the literal query "page=<n>" (no "?"); path line has no query.
- x-signature = HMAC-SHA256(signingSecret, message) as lowercase hex.
- Node:
  import { createHmac } from "node:crypto";
  const ts = String(Math.floor(Date.now()/1000));
  const msg = ["GET", "/portal/export", `page=${page}`, ts].join("\n");
  const sig = createHmac("sha256", signingSecret).update(msg).digest("hex");
  // headers: { "x-timestamp": ts, "x-signature": sig }
- The portal UI only ever signs page=1, but our sync may page it ourselves (fresh timestamp
  per page) — one signed request per page, read-only, within the rules.

DECISIONS (locked in Phase 1)

1. Meter list = search (403). Export only ENRICHES meters it covers; meters not in the
   export get hierarchy: null. Do not reconstruct upper levels from dtCode (note as a
   future improvement). Export reported total:100 vs search 403 — open question, search wins.
2. Hierarchy source: export where available, else null.
3. Daily consumption: group readings by IST calendar day; daily total = last reading of the
   day minus last reading of the previous day (cumulative registers). Document how the 23:30
   first reading and day boundaries are handled; skip incomplete end days rather than report
   a wrong figure.
4. Timezone: treat timestamps as IST; output ISO-8601 with +05:30 (documented assumption).
5. Units: expose kwh/kvah as numbers; OpenAPI says the unit is assumed kWh/kVAh.
6. Numbers-as-strings (kwh, kvah, voltR, lat, long) are parsed to numbers in parsers;
   capacityKva already a number.

FIXTURES AVAILABLE in test/fixtures/ (captured, secret-free):
login-page, login-success, meters-search-page1, dts-page1, export-page1 (3 rows),
meter-geo, meter-energy (8 days), session-expired (401).

# GROUND RULES — follow in every session, every phase

## Git

- NEVER run git push, git commit, git remote, git reset, git rebase, git stash,
  git checkout of other branches, force operations, or create PRs/tags.
- You MAY run read-only git commands: git status, git diff, git log.
- At the end of each phase, give me suggested commit messages (Conventional Commits
  style, small logical commits) and the files each one should include. I commit and
  push myself.

## Secrets

- Credentials come only from environment variables via src/config.js.
- Never hardcode, log, console.log, or put credentials, cookies, session IDs or CSRF
  tokens in code, tests, fixtures, docs, URLs or query strings.
- Configure the Fastify/pino logger with `redact` for cookie, set-cookie,
  authorization and any password fields.
- .env is in .gitignore from the first commit. Commit only .env.example with
  placeholder values.
- Redact cookies/tokens/password fields from any saved fixture or HAR before it
  touches the repo.
- Never disable TLS verification: no NODE_TLS_REJECT_UNAUTHORIZED=0, no
  rejectUnauthorized: false.

## The portal is read-only and shared

- Only the login request and read requests (GET, or whatever the UI itself uses to
  read). No create/update/delete calls, no form submissions other than login.
- No fuzzing, brute force, auth bypass, injection, vulnerability probing, or scanning
  for hidden admin pages. Everything needed is available to a normal logged-in user.
- Be polite: max 2–4 concurrent requests, small delay between pages, honour 429 and
  Retry-After, back off on errors. Never write loops that hammer the portal.
- Tests NEVER hit the live portal by default. A live smoke test is opt-in via
  RUN_LIVE_TESTS=1 and skipped otherwise. Unmocked network calls in tests must fail
  (MockAgent.disableNetConnect()).

## Honesty

- Never invent portal endpoints, fields, formats or behaviour. If you haven't seen it
  in my notes or a fixture, ask me or leave a clearly marked TODO.
- In docs, label things as Observed vs Assumed.
- Never fabricate reflection answers or experiences; draft only from my notes and
  leave [ME: ...] placeholders for anything you don't know.
- When unsure about a portal behaviour or a design choice that is mine to make, STOP
  and ask me instead of guessing.

## Node.js / code quality

- Plain JavaScript ES modules only: import/export, no require(), no CommonJS, no
  TypeScript files. Use node: prefixes for built-ins (node:fs/promises, node:test).
- async/await everywhere; no callback-style code, no .then() chains, no floating
  promises (every promise awaited or explicitly handled). No sync fs calls in request
  paths (readFileSync only at startup/scripts).
- Always throw Error objects (custom classes extending Error with a `code`), never
  strings. No empty catch blocks; never swallow errors; add context with { cause }.
- Central error handling: Fastify setErrorHandler + setNotFoundHandler. Never send
  stack traces or raw upstream bodies to clients.
- Use the Fastify/pino logger (request.log / app.log). No console.log in src/
  (scripts may print progress, never secrets).
- Validate ALL input (params, query, body) with JSON Schema on the route, and declare
  response schemas so output is serialised and documented. No manual ad-hoc checks
  where a schema can do it.
- Config read once at startup, validated, frozen; fail fast with a clear message.
  No process.env reads scattered across modules.
- Every outbound fetch has a timeout (AbortSignal.timeout). Every loop over remote
  pages has an upper bound.
- Graceful shutdown: on SIGINT/SIGTERM call app.close(), stop accepting requests,
  close the portal client. Log unhandledRejection/uncaughtException, then exit(1).
- Small focused modules and functions; JSDoc on exported functions; clear names.
- No dead code, commented-out blocks, unused imports or unused dependencies.
  No `var`; prefer const. Strict equality (===) only.
- Dependencies: minimal, well-maintained, exact versions, package-lock.json
  committed. Run `npm audit` and report results. Never install globally; never
  `npm install` packages I didn't approve (ask first).
- Run `npm run lint`, `npm run format:check` and `npm test` before declaring a phase
  done.
- Don't commit node_modules, .env, *.db, *.har, coverage/, data dumps, logs.

## Scope

- Keep it appropriately sized: no Docker/Kubernetes/microservices/queues/auth servers/
  ORMs/frontend frameworks/bundlers/build steps unless I explicitly ask.
- Stay inside the project folder.
- Do only the current phase. Don't start the next phase on your own.

## End-of-phase checklist (always)

1. lint + format:check + test results (paste the summary).
2. Files created/changed, one line each.
3. Assumptions made this phase -> also appended to notes/decisions.md.
4. Mistakes or dead ends hit -> appended to notes/mistakes.md.
5. Suggested commit messages + files per commit.
6. Then STOP and wait for me.
