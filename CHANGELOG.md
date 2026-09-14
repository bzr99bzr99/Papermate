# Changelog

All notable changes to PaperMate are documented in this file.

## [4.1.0] - 2026-08-16

### Fixed

- **In-app update could not replace the program files.** `installUpdate()` spawned the update helper directly with the install directory as the child's working directory. Windows refuses to replace files while a process still holds that directory, so the swap failed. The updater now writes a separate launcher (`scripts/launch-update.ps1`) into the updates directory — outside the install directory — and starts it from there; the launcher runs the real helper with `-WorkingDirectory` set to the updates directory and redirects its output to `install.log` / `install-error.log`, then hands the helper PID back through `helper-pid.json` (`lib/updater.ts`, `scripts/apply-update.ps1`).
- **A failed update left the app unusable.** The helper's exit was not observed, so the app could stay in `installing` forever, and the update lock was never released — after a failed update the user could no longer ask questions. An abnormal launcher exit now reports the exit code together with the diagnostic log path, a launcher that exits without handing over a PID reports that too, and every failure path releases the update lock and clears the lock file.
- Narrow-screen collapsing only changed opacity, so a "collapsed" sidebar kept occupying layout space. Collapsed sidebars are now removed from the grid and release their column.
- The reader re-rendered the PDF continuously while a sidebar was toggled or a width was dragged. The three-column layout now starts at its final widths, and the reader waits for the layout to settle (120 ms debounce plus an animation frame) before committing the new width (`components/pdf-reader.tsx`, `app/globals.css`).

### Added

- **Install-stage progress.** The update helper reports milestones (`installStage` / `installProgress`) as it works — verify, extract, stop service, back up, preserve data, replace files, start, health-check, complete — and also reports when it is rolling back, so the install phase has its own progress bar next to the download bar (`scripts/apply-update.ps1`, `lib/update-types.ts`).
- A resumable update window: closing the dialog (button or `Esc`) leaves an "更新进行中 · 查看进度" button in the corner instead of hiding the update, and the settings button becomes "查看更新进度" while an update is active.
- Connection warnings while the app cannot be reached: a stall message if the install status has not advanced for two minutes, and a restart message if the service has been unreachable for 90 seconds — both telling the user to close the window rather than start the install again.
- A "刷新页面" button once the update reports `complete`.

### Changed

- The release package checks now assert `scripts/launch-update.ps1`, the file the updater actually spawns, so a packaging regression fails the build instead of failing on a user's machine (`scripts/package-update.mjs`, `.github/workflows/release.yml`).

## [4.0.1] - 2026-08-16

### Fixed

- Prompt caching could return the wrong file's contents. The caches behind `public/prompts.txt` (task, system and web-search prompts) and `public/buddy-personas.txt` were keyed only on the file modification time, so two different files written within the same millisecond collided and the second read returned the first file's parsed prompts. The cache key now includes the resolved file path (`lib/prompts.ts`). This reproduced reliably on Linux, where consecutive file writes share a millisecond, and intermittently on Windows; the regression test now pins both files to an identical timestamp so it fails on every platform without the fix.
- CI failed on Linux: the in-app auto update is a Windows x64 feature, but its suite ran on `ubuntu-latest` and asserted Windows-only behaviour. Those tests are now skipped on other platforms instead of failing, and CI runs on both `ubuntu-latest` and `windows-latest` so the updater keeps full coverage.
- Flaky updater test: the "double-click does not download twice" case started a background download and never waited for it. Because the status file path is resolved from `PAPERMATE_APP_DATA` at write time, that stale download kept running into the following tests, picked up their `fetch` stub, and wrote its own message into their `status.json` — so the declared-size test intermittently reported the checksum-failure message instead. Every test that starts a download now waits for a terminal phase before finishing.

## [4.0.0] - 2026-08-16

### Added

- **Web search (联网搜索)**: a three-state switch (off / auto / force) that lets any chat model answer with up-to-date external information. Auto mode only searches when the question concerns external facts, recency, tools, products, prices, or versions; force mode searches on every question. Results are returned as numbered, clickable citation badges, and the paper body is never sent — only the question text reaches the search provider. Failures degrade to an offline answer instead of blocking the question. Providers: Zhipu (`search_std`, `search_pro`, `search_pro_sogou`, `search_pro_quark`), Bocha, Tavily, or a custom endpoint (`lib/web-search.ts`, `lib/web-search-store.ts`, `app/api/web-search/route.ts`, `data/search.json`).
- **Smart translation and auto-translate**: `Alt`+`T` translates the selection; `Alt`+`Shift`+`T` toggles auto-translate, which translates each newly selected passage automatically as a fresh single-fragment session. Single sentences and paragraphs get a short grammar explanation after the translation, while multi-fragment selections are labelled `# 1`/`# 2`.
- **In-app auto update**: checks GitHub formal releases in the background and only prompts when a newer version exists, with release notes, a progress bar, SHA-256 verification, and a standalone helper that stops the service, backs up the previous installation, swaps program files, health-checks the new build and rolls back automatically on failure. Detection deliberately avoids `api.github.com` and uses the `github.com/releases/latest` redirect plus the Atom feed, so the unauthenticated 60-requests-per-hour limit cannot lock users out of updating (`lib/updater.ts`, `lib/update-version.ts`, `lib/update-guard.ts`, `lib/update-activity.ts`, `components/update-manager.tsx`, `app/api/updates/route.ts`, `scripts/apply-update.ps1`, `scripts/package-update.mjs`).
- Custom web-search prompt rules can be edited in the `[websearch]` block of `public/prompts.txt`.

### Changed

- **Interface refresh**: unified theme accents and companion styling, refined layout, and themed in-app confirmation dialogs replacing the browser's native `confirm` for deleting artifacts and their version history.
- **Operation logic optimised**: requests from cross-site pages are rejected on the update endpoint while the app's own requests pass (same-origin checks based on the raw `Host` header, since browsers do not always send `Origin` on same-origin `POST`); model requests are paused while an update installs, and in-flight translations, questions and saves are awaited before installing.
- `Enter` sends a chat message and `Shift`+`Enter` inserts a newline, without swallowing IME composition.
- The reading companion now receives the actual conversation content (original passage, question, and answer) or the paper abstract, and its personas are freer: it may ask questions and raise topics, with a new mentor persona.

### Fixed

- Failed generation no longer overwrites existing reading notes, mind maps or writing analysis; a failure now shows a dismissible warning overlay with the reason and a copy button, and the previous content is restored.
- Failed chat sends no longer write to the conversation history — the reused conversation is restored, an empty new conversation is removed, and the unsent text goes back into the input box.
- Removed the non-existent "DeepSeek Max" tier and aligned every model label with its real model id (`glm-4-flash`, `glm-4.7-flash`, `deepseek-v4-flash`, `kimi-k2.6`); the quick/deep buttons now toggle the thinking switch rather than switching models.
- The quick/deep buttons no longer switch model tiers; the backend sends a uniform `thinking` parameter for all four models.
- Companion appearance fixed per level (laptop only at L5, manuscripts, magnifier, coffee cup, staff, and literature pile all grounded rather than floating); the speech bubble widened to 360px, flips direction near viewport edges, and idle chatter frequency now follows the talkativeness slider.
- `Ctrl`/`Cmd` + wheel zoom only scales the page content, keeps page labels at a constant size, compensates grid slots precisely, resolves the zoom anchor over the toolbar, labels, gaps and margins, and bounds canvas bitmap memory at high zoom.
- `kimi-k2.5` corrected to the actually available `kimi-k2.6`, with `kimi-k3` → `kimi-k2.5` fallback, fixing "connection test passes but generation returns 404".
- Paper title, keyword and journal parsing now combines first-page layout blocks, Crossref and OpenAlex lookups, and local extraction; wrapped titles are merged and journal headers excluded.
- Application icons regenerated from `papermate.png`, and shortcuts created by the installer use the new icon.
- Removed the obsolete `scripts/upgrade.ps1` and `一键升级.bat`; `一键安装.bat` alone handles both fresh and upgrade installs.
- Removed the dead `/api/deepseek/*` routes left over from the retired provider layout.

### Engineering & Quality

- Test suite expanded to 215 tests across 16 files covering conversations, library ordering, web search, prompt loading, the updater, update guards, update version comparison, model configuration, storage and PDF handling.
- Release workflow `.github/workflows/release.yml` builds, verifies (secret-leak assertions plus a real boot smoke test) and uploads a draft release for a matching `vX.Y.Z` tag.

## [3.6.0] - 2026-08-16

### Added

- Visual refresh stylesheet (`app/visual-refresh.css`, imported by `app/layout.tsx`) that unifies theme accents and companion styling on top of the per-theme rules in `globals.css`.
- Paper library sorting by recent reading: papers are ordered by pinned state, then last-read time, then creation time (`lib/library-order.ts`); last-read timestamps are tracked through storage and the paper API.
- Companion size controls: the reading companion can be scaled from 40% to 180% with dedicated buttons, and the choice is persisted locally (`lib/buddy-layout.ts`).
- `scripts/sync-prompt-defaults.mjs` keeps the editable `public/prompts.txt` and the bundled fallback prompts in sync.

### Changed

- Prompts optimized (task prompts and companion personas).
- Application icons regenerated.

### Fixed

- Various bug fixes and code cleanups.

## [3.3.0] - 2026-08-16

### Added

- Reader panning shortcut: hold `Alt` and drag with the left mouse button to pan the paper freely (the toolbar hand-button mode is unchanged; the old Space+drag shortcut is removed because Space also scrolls the page).
- Double-click a word in the original PDF text layer to select it instantly, ready to ask about or translate.

### Fixed

- Translation prompt rewritten: concise, direct output with no preamble/ending/summary; multi-fragment selections are labeled `# 1`/`# 2`; single sentences and paragraphs now get a grammar explanation after the translation. Synced into `public/prompts.txt`, the built-in fallback (`lib/prompts.ts`), and the legacy DeepSeek route.

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
