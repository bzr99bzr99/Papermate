# Changelog

All notable changes to PaperMate are documented in this file.

## [4.2.0] - 2026-08-16

### Added

- **Install without Node.js.** The `papermate-windows-x64.zip` published with a release could previously only be consumed by the in-app update helper, leaving a new user with no way to install it. The package now ships `一键安装.bat` and `scripts/install-package.ps1`: extract, double-click, pick a location, and it is installed in seconds — no Node.js, no npm, no internet, because the package bundles `node.exe`. Overwriting an existing install first moves the whole old folder to a sibling `.papermate-backup-<guid>` (stop the service and rename it back to roll back), then restores `data\` and any `public\*.txt` the user actually edited — compared byte-for-byte against the package default, so untouched files keep the new defaults. A zip can also be dragged onto the .bat. Desktop and Start menu shortcuts plus the Windows installed-apps entry are created, and the package carries `一键卸载.bat` so the install folder can uninstall itself without the Start menu.
- **One-click development deploy.** `一键升级.bat` (→ `scripts/upgrade-local.ps1`, engine `scripts/quick-patch.ps1`) inspects the local install and picks the right path: a prebuilt package install receives only the runtime output (`.next` at about 8 MB, `server.js`, `package.json`, plus five runtime scripts: apply-update, launch-update, start-papermate, stop-papermate, uninstall) instead of an 8000+ file package, while a source install goes through `install.ps1 -Upgrade`. For the runtime overlay it dry-run checks and applies an optional `.patch`, runs the tests, rebuilds, backs up the current runtime to `%LOCALAPPDATA%\PaperMate\dev-backups\<timestamp>` (newest 5 kept), copies the runtime over, restarts the service, reads the reported version back, and opens the page. `-Undo` rolls back and `-ListBackups` lists rollback points. When the dependency list changed it also copies the traced `node_modules` from the standalone output, so the app cannot start into a `MODULE_NOT_FOUND`.
- **`一键升级.bat` is back with a clear job.** v4.0 had removed it (together with `scripts/upgrade.ps1`) as redundant, but the install docs kept referencing it and there was no obvious "push this source into the installed app" entry point. It now dispatches by install type: a prebuilt package install gets the development runtime overlay, a source install gets `install.ps1 -Upgrade`.
- **One install entry point instead of two.** The old `安装PaperMate.bat` duplicated `一键安装.bat` for the "install" job, and it could not even run from a source checkout — a source tree has no `server.js` / `node.exe` to validate. Only `一键安装.bat` remains now: `scripts/install-local.ps1` inspects the current folder and dispatches to `install-package.ps1` (prebuilt package) or `install.ps1` (source checkout: first install, or an incremental upgrade when an install already exists). Release packages ship `一键安装.bat` too, and the root now has exactly three entries: `一键安装.bat` / `一键升级.bat` / `一键卸载.bat`.

### Fixed

- **Selection dropped fragments.** When a pointer pair spanned several text fragments on one visual line, the old code derived a column band from the two fragments (taking the intersection whenever the boxes overlapped by more than 35% of the narrower one) and only kept fragments whose centre point fell inside that band (±2 px). A PDF text layer splits one visual line into dozens of absolutely positioned spans, so trailing superscripts, inline symbols such as `⋆`, and the centre of the last word on a line fell outside the band and were dropped entirely — middle rows lost 10/23 and 15/41 fragments in measurements (`extreme`, `biased`, `Enrico`, `Zio`, superscripts `c`/`d`/`e`). Range computation now lives in a pure module, `lib/selection-range.ts`: fragments are grouped into visual rows (vertical overlap greater than half of the shorter box), rows are split into segments on gaps of `max(6, median row height × 0.8)`, a segment participates as a whole when it holds an anchor or intersects the anchor column band (±6 px), anchor rows always participate, and the result is trimmed to the index window between the first and last fragment. `components/pdf-reader.tsx` only feeds spans in and builds the quote. After the fix the same probe reports 23 / 41 / 29 fragments fully covered, 0 uncovered.
- **Uninstalling a prebuilt package install left the program files behind.** `uninstall.ps1` used `.papermate-installed.json` as its only proof that a folder is a PaperMate install, and a prebuilt package install has no such marker: uninstall removed the shortcuts, launcher and installed-apps entry, then skipped the folder, leaving roughly 260 MB of program files on disk. It now also accepts a prebuilt package marker (`papermate-version.json` + `server.js` + `node.exe`), so the folder is cleaned properly while `data\` is still preserved unless `-RemoveAllData` is passed. The protected-path check also had to exclude that case, because a prebuilt install's `sourceProjectDir` equals the install directory itself.
- **The source upgrader no longer silently overwrites a prebuilt install.** Running `install.ps1 -Upgrade` against a folder that has `server.js` / `node.exe` but no source marker used to copy source over it, discarding the packaged runtime layout and potentially downgrading the version. It now refuses and explains the three options: in-app "Check for updates", a released package, or installing the source to a different location.

### Changed

- The quote library gained 264 more quotes (`public/quotes.txt`).
- `INSTALL.md` / `安装说明.md` and both READMEs were rewritten around the new flow: prebuilt package (recommended, no Node.js) versus source install, the single `一键安装.bat` entry point, drag-and-drop installation, and the development deploy. The development checkout's own version number stays fixed at `1`; real versions are maintained only here and tagged.
- The repository no longer ships the obsolete `scripts/update-installed-*.ps1` deployment helpers, the `public/prompts0818.txt` snapshot, or two screenshots the READMEs never referenced. The sample artifacts under `截图/` were refreshed.

### Engineering & Quality

- Selection range logic was extracted from `components/pdf-reader.tsx` into a pure module (`selectItemIndexes` / `buildSelectionQuote`) with 12 new regression tests: cross-fragment column bands, pointer on a line's top edge, two-column isolation, index-window exclusion, offset trimming, and blockIds. The suite is now **232 tests** across 17 files.
- The packager's assertions now cover the user-facing entries: `一键安装.bat`, `一键卸载.bat` and `scripts/install-package.ps1` must be in the package, while `scripts/quick-patch.ps1` must not be (a development tool; a prebuilt install has no source). The release workflow checks the same list after unpacking the zip.
- Dead code removed: 45 exports that nothing outside their own module imported were demoted to module-private symbols, and two entirely unused declarations (`writeDiskBackup` in `lib/db.ts`, `TextLineCluster` in `lib/pdf.ts`) were deleted. `tsc --noEmit`, the 232 tests, and the production build all pass after the cleanup.

### Notes

- `一键升级.bat` routes by install type: a prebuilt package install gets the development runtime overlay (when a complete source checkout is present), while a source install gets `install.ps1 -Upgrade`. With only the extracted release zip there is no source, so use in-app "Check for updates" or a release package instead.
- A development deploy rewrites the installed `package.json` version to the development version 1 and marks `papermate-version.json` with `devBuild: true`, so in-app update keeps offering the latest release. Accepting that offer restores the official package on that machine.
- The prebuilt package installer currently supports Windows x64 only. Development version numbering is documented in `INSTALL.md`.

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
