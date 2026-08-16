# Changelog

All notable changes to PaperMate are documented in this file.

## [2.0.0] - 2026-08-16

### Added

- Clickable citation and figure links in reading artifacts that jump to the target page or open external URLs (original PDF links only).
- Annotation cleanup: saved conversations and annotations can be deleted.
- Paper library drag-and-drop reordering with pin-to-top support (`/api/storage/papers/order`).
- Refined theme with a unified CSS variable palette.

### Changed

- Model calling logic optimized for the DeepSeek and free Zhipu GLM providers (streaming, context trimming, error handling).
- Task prompts further optimized for translation, context explanation, concept explanation, free questions, reading notes, mind maps, and writing analysis.
- Persistent storage optimized (SQLite write path and workspace data handling).
- Removed the separate `一键升级.bat` / `scripts/upgrade.ps1`; `一键安装.bat` now handles both fresh install and in-place upgrade automatically.
- Documentation updated (README, install guides).

### Fixed

- Ctrl/Cmd+wheel zoom: live zoom now applies only to the page stack; P.x page labels stay constant instead of following the zoom and snapping back on commit.
- Ctrl/Cmd+wheel zoom: grid slot height compensation is computed precisely, so lower pages no longer jump vertically at zoom commit.
- Ctrl/Cmd+wheel zoom: anchor parsing works when the cursor is over the sticky toolbar, page labels, page gaps, or side margins; zoom no longer jumps.
- Ctrl/Cmd+wheel zoom: commit uses a drift threshold with a two-stage delay, so small or rapid back-and-forth zooms no longer trigger repeated full re-renders; effective DPR is budgeted at high zoom so per-page canvas memory stays bounded.

## [1.1.0] - 2026-08-16

### Added

- Free Zhipu GLM provider (`glm-4.7-flash`) alongside DeepSeek, selectable per request.
- One-click upgrade (`一键升级.bat`) updates an existing install from the current source while preserving the installed `data` folder.
- `一键安装.bat` automatically enters upgrade mode when an existing PaperMate install is detected.

### Changed

- Replaced browser IndexedDB as the primary store with a local SQLite database at `data/papermate.db`.
- Full JSON backup is now manual only: export/import, backup now, and restore from `data/papermate-backup.json`.
- Existing `papermate-backup.json` and legacy IndexedDB data are migrated once on first startup and then kept as historical data.
- Node.js 22.5 or newer is required.
- Installer version metadata is read from `package.json` instead of being hard-coded.
- Context explanation now answers the user's input-box question first, grounds it in the full paper and selected passage, and explicitly separates original-text evidence from inference and supplementary explanation.
- Paper title/keyword/journal parsing now combines first-page layout blocks, Crossref and OpenAlex lookups, and local keyword/journal extraction; wrapped titles are merged and journal headers are excluded.
- Structured task prompts for translation, context explanation, concept explanation, free questions, reading notes, mind maps, and writing analysis (`lib/prompts.ts`).

## [1.0.0] - 2026-08-16

### Added

- Original-page PDF reading with PDF.js and a transparent selection layer.
- Paragraph selection with multi-fragment `Ctrl`/`Cmd` selection.
- Multi-turn DeepSeek chat with Flash and MAX thinking modes.
- Translation, context explanation, concept explanation, and free questions.
- Reading notes, paper mind maps, and writing-strategy analysis.
- IndexedDB storage with local disk backup in `data/papermate-backup.json`.
- Windows one-click install, start, stop, and uninstall scripts.
