# Mistakes & dead ends

An honest log of things I got wrong or paths that went nowhere. It feeds the Reflection in the README. I only add an entry when something actually happened — no padding.

## Phase 1

Nothing logged here. (The one real Phase 1 slip — claiming the energy data was "exactly 8 days" — I didn't catch until Phase 2, so it's written up there.)

## Phase 2

- **My original signing plan, scrapped.** My first idea for the capture script was to fire different candidate signature layouts at the live portal until one worked. That's brute-forcing a shared system, which breaks the ground rules, so I dropped it and read the layout out of the frontend JS instead. Should've seen that sooner.
- **env-schema and `uri`.** I used `format: 'uri'` for the base URL and it threw at startup — env-schema doesn't ship that format. Swapped it for a regex pattern.
- **Wrong mock method.** I called `assertNoPendingInterceptors` on a mock pool; turns out it only exists on the `MockAgent`. Wrapped it in a helper.
- **Shell heredoc fought back.** Tried to write several files at once with a big shell heredoc and it failed on a quoting error, writing nothing. Switched to writing files one at a time. No harm to the repo, just wasted a minute.
- **ESLint vs `process.loadEnvFile`.** The linter flagged it as experimental (it is, until Node 22.21). I allowed it in the lint config rather than bumping the `engines` range.
- **The one that was actually a process mistake (caught in review).** My first parser made a single bad export row blow up the whole page, and it dropped skipped days without saying anything. The review changed both (see decisions.md). The lesson I took: for a bulk path, decide up front what happens to a bad row, and never drop something silently.

## Phase 3

- **OpenAPI component names.** Swagger first spat out the schemas as `def-0 ... def-14`, which is useless to read. Fixed it with the `refResolver` option so the names come from each schema's `$id`.
- **"Default Response" everywhere.** My `$ref` responses all showed up as "Default Response" in the docs. Putting a `description` next to the `$ref` fixes it in @fastify/swagger, so I set one per route.
- **Two bugs in my own tests.** A `q` match count that was off by one, and comparing `request.query` (which has a null prototype) against a plain object. Both were mistakes in the tests, not the code — but they still cost me time to track down.
- **The heredoc thing again.** Same quoting failure as Phase 2 when I tried to write several files in one shell command. Wrote them one at a time. I should've remembered the first time.
- **Didn't actually run the shutdown path.** The SIGINT/SIGTERM handling and the unhandledRejection path are written but never exercised — I smoke-tested the server on Windows with dummy credentials, only hit the validation, 404 and /docs routes, then killed it. So that code is unproven.

## Phase 4

- **I corrupted my own notes file.** A scripted edit of protocol-notes.md turned the literal `"\n"` in the signing message into an actual line break. I spotted it while writing PROTOCOL.md and fixed it by hand, then wrote PROTOCOL.md from the repaired version.
- **Windows line endings (caught in the audit).** Git warned it would convert `openapi.json` to CRLF on checkout, which would have broken the OpenAPI drift test and `prettier --check` on Windows. Added a `.gitattributes` (`* text=auto eol=lf`) to force LF.