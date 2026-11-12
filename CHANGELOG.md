# Changelog

## [3.0.0](https://github.com/chapterfierce/loopsteward/compare/v2.9.2...v3.0.0) (2026-11-12)


### ⚠ BREAKING CHANGES

* extraction now requires LOOPSTEWARD_BASE_URL and LOOPSTEWARD_MODEL (MAGPIE_* remain aliases), and setup/install commands default to detected agents instead of a hard-coded Hermes target.

### Features

* prepare LoopSteward 3.0.0 for public npm use ([7578c24](https://github.com/chapterfierce/loopsteward/commit/7578c24fcb5e3290a58e986aee59584e1c08e064))

## [2.9.2](https://github.com/chapterfierce/loopsteward/compare/v2.9.1...v2.9.2) (2026-11-12)


### Bug Fixes

* **calibrate:** honor injected clock when filtering snoozed loops ([e3e5ebf](https://github.com/chapterfierce/loopsteward/commit/e3e5ebf91ecb8ecef71d5f55c1c053f9c279c8eb))

## 2.9.1

- Added `npm run release:check`, one gate that runs type-check, the full test suite, build, package verification, and the legacy suite in order; `docs/RELEASE.md` records publish, post-publish token revocation, tagging, and rollback steps.
- The daily/weekly inventory now separates temporary-session loops from real-project backlog (for example “76 条待办（其中 48 条来自临时会话）”) and exposes `userActiveSessionOnly` in JSON, so a one-off chat workspace no longer looks like a real project commitment.
- Ingestion now holds a session when its last message is a user question younger than five minutes, even with `--settle-minutes 0`; a question that is answered seconds later no longer becomes a false open loop. The existing false positive was dropped after backup.
- Daily and weekly closing hints now break down completion evidence by origin; when user-sourced completion candidates exist, the hint reports “用户 N 条” and points directly to “只看我的完成项” instead of making the user scan the full closing list.
- MCP `loops_closing` now has a combined regression test for `completionOnly + origin`, proving the two filters compose; the README tool table and MCP docs now list both arguments together.
- `loops:doctor` now verifies that every installed skill's wrapper path still exists; a hash-matching copy that points at a moved or deleted package is reported as broken instead of passing.
- `loops:doctor` now reports per-agent signal freshness (`codex 3.4h`, `claude 15.2h`, ...), so a client update that silently stops one session source is visible without reading the raw signals table.
- Docker production install now uses `npm ci --omit=dev`; docs and tests no longer claim the image is express-free, because the MCP SDK brings express transitively. The image boundary is the absence of the legacy `dist/src/index.js` entrypoint.
- CI now keeps the Open Loops suite as the only blocking test job; the deprecated HTTP intent and milestone suites moved to a separate non-blocking `legacy` job, and a new `package` job runs `verify:package` against the packed tarball, CLI closing ref, and MCP tool list.
- Empty daily digest now surfaces the highest-priority completion candidate for the current project with its ref, confidence, and evidence, so a likely-done item can be confirmed immediately; user-sourced candidates rank before mixed and assistant, and nothing closes without an explicit reply.
- Empty daily digest now surfaces the top actionable user-owned loop for the current project with its ref, so the user can say “做这条” without opening the full weekly review; assistant-only items, noise, snoozed loops, and completion candidates stay excluded.
- `loops:doctor` now checks Codex, Claude, and Cursor MCP client configs and verifies that each configured server path exists; clients with no MCP config stay optional and do not raise warnings.
- New `loops:archive-sessions` previews stale session-only loops (default 7 idle days, 20 shown) and archives only the shown batch as `dropped` with `--apply`; loops the user explicitly marked forgotten are never archived, and archived loops can be restored with `update --status open`.
- `loops:stats` now splits open and pending counts into real projects versus temporary session workspaces.
- `loops:doctor` now reports the real/temporary split in its weekly-review line, so the 240-item inventory is not mistaken for 240 real project tasks.
- The empty hot digest now renders as a short three-block message (header, inventory, closing entry) instead of one 160-character line.
- Weekly review's remaining count now reports the temporary-session share separately (for example, 185 remaining with 126 from temporary sessions), so the backlog reads as actionable instead of endless.
- Review remaining now counts the actual unseen queue after excluding the current batch, replacing the previous seen-vs-displayed subtraction.
- Closing review now ranks user-sourced items before mixed and assistant suggestions after completion evidence, so the user's own commitments are not buried under assistant-only backlog.
- Daily and weekly closing hints now offer a direct “只看完成证据” shortcut whenever completion evidence exists, linking the revisit flow straight to the evidence-first closing pass.
- The completion-only closing view now offers an explicit “全部完成” batch path; the skill repeats the count and requires one confirmation before closing, and still never closes from silence or evidence alone.
- Closing review now supports `--completion` (and MCP `completionOnly`) to show only items with high-confidence completion evidence; the filtered view still requires explicit confirmation and never auto-closes.
- Hot digest now fills at most one leftover slot with a high-confidence assistant suggestion (confidence >= 0.8), labeled “助手建议”; user-owned loops always come first, and recently presented suggestions are skipped. The weekly review teaser still excludes unconfirmed assistant loops.
- The doctor's weekly-review line now labels its count as “all open/pending”, so it is not confused with the digest's remaining count, which excludes completion candidates and forgotten feedback.
- Weekly review and the hot review teaser no longer select high-confidence completion candidates as normal open items; candidates stay in the separate completion section and closing review, and the review remaining count excludes them.
- Weekly review now appends the closing entry with the user/assistant/mixed breakdown and the number of items that already have completion evidence; review reads 30-day reconcile candidates instead of only the last 24 hours.
- Daily digest completion candidates now share one cache read; hot close prompts can surface up to three candidates, and `closingCompletionTotal` / `focusClosingCompletionTotal` expose the evidence count.
- Republish from current `main` (`d8e7c48`); the npm `2.9.0` tarball was built before M152–M154.
- Closing review now puts items with 30-day reconcile completion evidence first (confidence >= 0.9), exposes `completion` and `completionTotal`, and shows the reason before the next action; it remains read-only and still requires explicit user confirmation.
- `closing --json` now includes the stable `ref` field, so closing items can be acted on without another lookup.
- Loop detail and MCP `loops_get` now report total `presentationStats`, matching the closing review count.
- `closing --project .` resolves relative paths against the current directory.
- Digest snooze checks honor the caller's reference time, keeping historical and replayed digests deterministic.
- Added `npm run verify:package`, which packs, installs into a temporary directory, and verifies the CLI closing `ref` plus the MCP version and read-only tool list.
- Hot digest now moves high-confidence completion candidates out of the active list and into the close-confirmation prompt, so finished loops are not shown as new work.
- Hot digest now excludes assistant-only loops unless the user has explicitly confirmed them with `forgotten` feedback; weekly review still lists them for confirmation.
- Daily inventory now separates user-owned loops from assistant-only suggestions; `activeTotal` stays for compatibility while `userActiveTotal` and `assistantBacklog` drive the digest copy.
- Normal hot digest now appends a closing hint when previously shown loops remain open, linking the everyday revisit flow to the closing review.
- Closing review items now expose `origin`; assistant-only suggestions are labeled “助手来源” so they can be triaged separately from user commitments.
- `closing` now accepts `--origin user|assistant|mixed`, and MCP `loops_closing` accepts the matching `origin` argument. Responses include `originTotals` so the user can see the full source mix before filtering.
- The Open Loops skill now passes `--origin` when the user asks to separate user commitments from assistant suggestions, reports all three source counts first, and does not silently fall back to the unfiltered list.
- Closing review text now prints the source composition at the top, and filtered views state the full scope counts before the filtered rows.
- The daily hot digest closing nudge now includes the user/assistant/mixed breakdown and points to “只看助手建议” for separate cleanup.
- Zero-state closing hints now use the focused project's origin counts, state how many remain globally, and distinguish “收尾本项目” from the global “收尾”; the wrapper resolves `--project .` to the caller's current directory.

## 2.9.0

- Multi-agent session ingestion: Codex, Claude Code, Claude Desktop Code/Cowork, Qoder, ZCode, WorkBuddy, Hermes, DeepSeek Harness, Antigravity CLI.
- Local SQLite loop store with dedupe, stable refs, feedback calibration, and evidence-based reconcile.
- Daily digest with project focus, revisit budget, cooldown, review rotation, and session-start skill integration.
- Read-only MCP server (`loops_context`, `loops_search`, `loops_get`, `loops_closing`) for agent integration.
- Closing review lists loops that were shown but never closed, ordered by presentation count.
- Closing review JSON includes stable refs, so a user can close or defer an item without another lookup.
- Loop detail reports total presentation stats separately from the fatigue counter, matching the closing review.
- Digest reads honor the caller's reference time for snooze expiration, so historical or replayed digests stay deterministic.
- Closing review resolves relative project filters, so `--project .` works from the project root.
- Zero-state digest points to the closing review when shown loops remain open.
- Cross-platform CI on Linux and Windows, including the full Open Loops suite, build, and Docker smoke test.
- Packaging, global install, backup/restore, doctor, audit, and skill/policy installers.
