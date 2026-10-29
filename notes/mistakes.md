# Mistakes & dead ends

An honest log of things I got wrong or paths that went nowhere. It feeds the Reflection in the README. I only add an entry when something actually happened — no padding.



## Phase 2

- **My original signing plan, scrapped.** My first idea for the capture script was to fire different candidate signature layouts at the live portal until one worked. That's brute-forcing a shared system, which breaks the ground rules, so I dropped it and read the layout out of the frontend JS instead. Should've seen that sooner.

- **Wrong mock method.** I called `assertNoPendingInterceptors` on a mock pool; turns out it only exists on the `MockAgent`. Wrapped it in a helper.
- **Shell heredoc fought back.** Tried to write several files at once with a big shell heredoc and it failed on a quoting error, writing nothing. Switched to writing files one at a time. No harm to the repo, just wasted a minute.
- **ESLint vs `process.loadEnvFile`.** The linter flagged it as experimental (it is, until Node 22.21). I allowed it in the lint config rather than bumping the `engines` range.


## Phase 3

- **OpenAPI component names.** Swagger first spat out the schemas as `def-0 ... def-14`, which is useless to read. Fixed it with the `refResolver` option so the names come from each schema's `$id`.
- **"Default Response" everywhere.** My `$ref` responses all showed up as "Default Response" in the docs. Putting a `description` next to the `$ref` fixes it in @fastify/swagger, so I set one per route.
- **Two bugs in my own tests.** A `q` match count that was off by one, and comparing `request.query` (which has a null prototype) against a plain object. Both were mistakes in the tests, not the code — but they still cost me time to track down.
- **The heredoc thing again.** Same quoting failure as Phase 2 when I tried to write several files in one shell command. Wrote them one at a time. I should've remembered the first time.
- **Didn't actually run the shutdown path.** The SIGINT/SIGTERM handling and the unhandledRejection path are written but never exercised — I smoke-tested the server on Windows with dummy credentials, only hit the validation, 404 and /docs routes, then killed it. So that code is unproven.


## Phase 5B

- A blank-code test failed because I forgot that an unplaced meter leaves the transformer list pointing at a DT with no meters, so `transformer_without_meters` also fired. The code was right and the test expectation was wrong; fixed the test.
- My first README/PROTOCOL table edits were not Prettier-formatted, so `format:check` failed; fixed with `prettier --write` (whitespace/table alignment only).

## Phase 5A

- My first batch of patches was a single huge shell command with nested heredocs; the shell rejected it with a quoting error and applied none of it. I re-did the edits through a script file instead.
- The first index-API test run failed with "unable to open database file": the test created the database before its parent directory existed. The service creates the directory itself; the test setup did not. I made the test create it and added a separate test for the service creating a missing directory.


## Phase 5C

- I again sent a long Python patch as a shell heredoc and the shell rejected it with a quoting error (same mistake as Phase 5A), applying nothing. Second time, so: patch scripts go in a file written with the file tool, then get run.
- I made `circuitState` and `cache` required on `/health`, which broke the fake services in two test files (a 500 because a fake client had no `fetchTransformers`/`circuitState`). Fixed the fakes, not the schema.
- My schema patch added `stale` twice to one schema (a string edit that matched twice); ESLint's `no-dupe-keys` caught it.



## First live run (Phase 5C review)

- `npm run sync` failed on its first real run with `logger.debug is not a function`: the script's console logger had no `debug`, which the portal client calls. The tests all use a recording logger that has every level, so none of them could catch it. Added a no-op `debug` to `scripts/sync.js`. Lesson: the mocked suite proves logic, not wiring; run each entry point once for real.
- Live finding: the export returns all 403 rows in a single page, but 14 rows have an empty hierarchy code (for example `hierarchy.circle.code`), and the strict parser rejects the whole row, so they are not in the index. They show up in `/v1/network/issues` as `meter_not_in_export`, which is slightly misleading: they are in the export, just malformed.
- Resolved after the first live run: those 14 rows are now kept (see decisions.md, "Incomplete hierarchy rows") and labelled `incomplete_hierarchy`.
