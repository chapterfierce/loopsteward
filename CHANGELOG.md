# Changelog

## 2.9.0

- Multi-agent session ingestion: Codex, Claude Code, Claude Desktop Code/Cowork, Qoder, ZCode, WorkBuddy, Hermes, DeepSeek Harness, Antigravity CLI.
- Local SQLite loop store with dedupe, stable refs, feedback calibration, and evidence-based reconcile.
- Daily digest with project focus, revisit budget, cooldown, review rotation, and session-start skill integration.
- Read-only MCP server (`loops_context`, `loops_search`, `loops_get`, `loops_closing`) for agent integration.
- Closing review lists loops that were shown but never closed, ordered by presentation count.
- Closing review JSON includes stable refs, so a user can close or defer an item without another lookup.
- Zero-state digest points to the closing review when shown loops remain open.
- Cross-platform CI on Linux and Windows, including the full Open Loops suite, build, and Docker smoke test.
- Packaging, global install, backup/restore, doctor, audit, and skill/policy installers.
