# Changelog

All notable changes to PaperMate are documented in this file.

## [3.2.0] - 2026-08-16

### Changed

- One-click install/update is now incremental: the installer computes a SHA-256 source fingerprint (path + size + mtime, excluding build-irrelevant files); when the source is unchanged it skips copying and rebuilding, and robocopy only copies changed files, making updates faster.
- Operation logic improvements and bug fixes.

## [3.1.0] - 2026-08-16

### Added

- Custom models: add, edit, and delete OpenAI-compatible chat/completions models in settings (custom base URL, model name, and API key); `/api/chat` routes custom model requests from the saved configuration.
- Model system refactored: four built-in models (GLM-4-Flash, GLM-4.7-Flash, DeepSeek, Kimi) with stable ids; the quick/deep buttons now only toggle the thinking switch instead of switching models.

### Changed

- UX improvements.

## [3.0.1] - 2026-08-16

### Added

- `public/prompts0818.txt` prompt snapshot included in the repo.

### Changed

- Reading-companion personas and UI styles refined.
- README interface overview updated with the Q&A and reading-companion screenshots; sample outputs and the screenshot folder synced to the current project.

## [3.0.0] - 2026-08-16

### Added

- AI reading companion (陪读小人): five personas (sarcastic, gentle, philosophical, encouraging, mentor) that react to question types and completed answers; can be hidden entirely (fully unloaded, no model requests); persona prompts are editable at `public/buddy-personas.txt` (cached by file mtime) with local fallback lines when no API key is available.
- Twenty reading themes (ten new ones, e.g., classified archive and e-ink).
- GLM dual-tier models: `glm-4-flash` (free, officially supports high concurrency) as the primary GLM model, with `glm-4.7-flash` as its fallback (and vice versa).

### Changed

- Prompts optimized (tasks and companion personas).
- UI polish and visual refinements.

### Fixed

- Various bug fixes.

## [2.9.0] - 2026-08-16

### Changed

- Kimi provider upgraded to `kimi-k2.6` with a fallback model list (model availability may vary by account).
- Prompts optimized across tasks.

### Added

- Generated results (reading notes, mind map, writing analysis) now keep version history: view, modify, or delete previously generated data; a failed generation never overwrites the existing data.
- README interface overview gains a prompt-library screenshot.

### Fixed

- UX improvements and bug fixes.

## [2.8.0] - 2026-08-16

### Added

- Kimi provider (`kimi-k2.5` via Moonshot) as the third model provider, with its own API key and connection test in the unified settings panel.
- Quote library (拾句): quotes are shown in the sidebar and can be refreshed; content is editable at `public/quotes.txt` (plain text, one quote per line, `#` for comments).
- User-editable prompt library at `public/prompts.txt`: each task block starts with a `[task-name]` line; edits take effect on the next request, and deleting a block falls back to the built-in default prompt.
- API key management: keys are now stored server-side in `data/apikey.txt` (plain text, `data/` is gitignored) with quick add/edit/delete from the settings panel; the browser no longer holds the keys.

### Changed

- DeepSeek and Kimi support concurrent conversations; the free GLM tier stays single-task.
- README (Chinese and English) updated: three providers, quotes & prompt library, and the new local API key storage.

### Fixed

- Sidebar layout bug fixes.
- Other experience and stability fixes.

## [2.1.0] - 2026-08-16

### Changed

- Unified settings panel: model provider API keys with connection tests (DeepSeek and Zhipu GLM), reading themes, and complete JSON backup management now live in a single two-column settings sheet with a header and a Done button; header buttons were renamed from "模型设置"/"API 设置" to "设置".
- Settings panel restyled: wider sheet, sectioned blocks, stable close button, and a two-column main/side layout.
- README (Chinese and English) rewritten as a detailed formal-release introduction covering the current feature set, with the settings screenshots merged into a single `设置.png`.

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
