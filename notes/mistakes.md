# Mistakes & dead ends

Honest log, feeds the README Reflection. Entries are added only when they actually happen.

## Phase 1

_None yet._

## Phase 2

- **Phase 1 wrong claim (mine):** I wrote that the energy series was "exactly 8 days". The fixture has 337 readings, which is 7 days plus one reading (23:30 on the first day). Noticed while reading the fixture; corrected in protocol-notes. It matters because the first day can never be a complete day.
- **Phase 1 plan, dropped:** the first capture plan proposed brute-forcing candidate signature layouts against the live portal. That conflicts with the ground rules, so the layout was read from the frontend JS instead.
- **Dead end, env-schema:** used `format: 'uri'` for the base URL; env-schema has no `uri` format and threw at startup. Replaced with a pattern.
- **Dead end, tests:** called `assertNoPendingInterceptors` on a mock pool; it exists only on `MockAgent`. Wrapped in a helper.
- **Dead end, tooling:** a large multi-file shell heredoc failed with a quoting error and wrote nothing; I switched to writing files one at a time. No impact on the repo.
- **ESLint:** `n/no-unsupported-features` flagged `process.loadEnvFile` (experimental until Node 22.21); resolved with `allowExperimental` rather than raising `engines`.
- **Process (Phase 2 review):** my first parser version made one bad export row fail the whole page, and silently dropped skipped days. The author's review changed both (see decisions.md). Lesson: for bulk paths, decide up front what happens to bad rows, and never skip silently.
