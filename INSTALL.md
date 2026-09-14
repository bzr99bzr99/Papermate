# PaperMate Installation Guide

PaperMate runs locally (default `http://127.0.0.1:3000`). There are two ways to install it; after that, in-app auto update keeps it current.

| Install method | For whom | Needs Node.js | Typical time |
| --- | --- | --- | --- |
| **Prebuilt package** | Anyone who just wants to use it (recommended) | No - the package ships its own `node.exe` | under a minute |
| **From source** | Developers and contributors | Node.js 22.5+ | 3-10 minutes the first time |

Both options share **one entry point**, `一键安装.bat`: it first looks at the current folder - if it contains `server.js` / `node.exe` (an extracted release zip) it installs the prebuilt package, and if it is a complete source checkout (with `app\`, `components\`, `lib\`, `next.config.ts`) it installs from source. There is no second command to remember.

## Option 1: Prebuilt package (recommended)

1. Open the project's GitHub **Releases** page and download the latest `papermate-windows-x64.zip`.
2. Extract it anywhere (avoid `C:\Program Files` and other locations that need administrator rights).
3. Double-click `一键安装.bat` inside the extracted folder.
4. On a first install you are asked where to install PaperMate (default suggestion `D:\PaperMate`); confirm and it finishes in seconds.
5. Double-click the desktop shortcut `PaperMate 论文助手` to start.

What to expect:

- No Node.js, no npm, no internet needed - the package bundles `node.exe`.
- When overwriting an existing install, the whole old folder is first moved to a sibling `.papermate-backup-<guid>` (stop the service and rename that folder back to roll back), then your data is restored: the entire `data\` folder plus any `public\*.txt` files you edited (prompts, quotes, personas).
- You can also drag-and-drop a zip onto `一键安装.bat`.
- Command-line equivalent:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-package.ps1 -PackageZip D:\Downloads\papermate-windows-x64.zip -InstallDir D:\PaperMate -Start
```

- If the target folder is non-empty and does not look like a PaperMate install, the installer refuses to overwrite unless you pass `-Force`.
- The installer creates desktop and Start menu shortcuts and registers the app in the Windows installed-apps list.
- The extracted package also carries `一键卸载.bat`, and the install folder keeps a copy, so you can uninstall from there, from the Start menu `PaperMate` folder, or from Windows Settings → Apps.

## Option 2: From source

### Windows One-Click Install

1. Double-click `一键安装.bat` in the project root.
2. If no PaperMate installation is detected, choose an installation folder. The default suggestion is `D:\PaperMate`; you can create a new folder or select another ordinary folder.
3. If an existing install is detected in `%LOCALAPPDATA%\PaperMate\config.json`, the installer skips the location picker and upgrades that installation in place.
4. Wait for the installer to copy the project, install npm dependencies, build the production app, and create shortcuts.
5. After installation, use the desktop shortcut `PaperMate 论文助手` to start the app.

The installer does not modify the original project folder when you choose a separate install location. It copies the source files into the selected folder and installs dependencies there. If you choose the project folder itself, it installs directly in place.

### Upgrading from source

Double-click `一键升级.bat` in the project root (or `一键安装.bat` again) to update an existing installation from the current project source:

- Reads the install location, port, and shortcut settings from `%LOCALAPPDATA%\PaperMate\config.json`.
- Stops the running PaperMate service before copying new source files.
- **Incremental update - only what changed is touched**:
  - The installer fingerprints the source (path, size, and last-write time). If nothing changed since the last install, it skips the project copy, dependency install, and build - the upgrade finishes in seconds.
  - When the source did change, only the changed files are copied, not the whole project.
  - `npm install` is skipped when `package.json` / `package-lock.json` are unchanged, reusing the existing `node_modules`.
  - The production build only runs when it is actually needed.
- Refreshes launchers, shortcuts, and the Windows app-list version on every upgrade; the installed `data` folder is always kept intact, including `papermate.db`, WAL/SHM files, and `papermate-backup.json`.
- To force a full rebuild, run `powershell -File scripts\install.ps1 -Upgrade -ForceFull`.

> Note: `一键升级.bat` inspects the local install first. If it is a **prebuilt package** install (installed with `一键安装.bat`, or upgraded by in-app auto update), the script switches to the development-deploy path below (build the current source, overlay only the runtime output) - which requires the current folder to be a complete development source checkout. If all you have is the extracted release zip with no source, use in-app "Check for updates" or install a release zip instead.

## Starting and Stopping

The desktop shortcut and the Start menu entry start a hidden background service and open the app in Edge or Chrome at `http://127.0.0.1:3000` (or another free port if 3000 is occupied).

Clicking the shortcut again while the service is already running just opens the page. Use `停止 PaperMate 服务` in the Start menu `PaperMate` folder when you want to stop the background process.

## Uninstalling

Double-click `一键卸载.bat` in the install directory, use the uninstall shortcut, or open Windows Settings → Apps → Installed apps and uninstall `PaperMate 论文助手`.

Uninstall:

- Stops the running PaperMate service.
- Removes desktop and Start menu shortcuts and the uninstall shortcut in the install directory.
- Removes launcher files and logs from `%LOCALAPPDATA%\PaperMate`.
- Removes PaperMate from the Windows installed-apps list.
- Removes application files, dependencies, and build output from the install location.

Your papers, notes, and local backups remain in the `data` folder of the install location and are not deleted during uninstall. To remove them too, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\PaperMate\uninstall.ps1" -RemoveAllData
```

If you installed directly into the project folder, uninstall removes shortcuts, launcher files, and the app-list entry, but does not delete the source code.

## Development: one-click deploy to the local install

The development version number is **fixed at 1**: you never bump it while coding, and a deployed development build reports version 1 in the app. Real version numbers are maintained only in the clean publishing checkout (`papermate github`) - bump it there and tag the release.

The full release path (build → package 8000+ files → zip → SHA-256 → updater swaps the folder) takes over ten minutes, which is far too slow to test one change. Only three things decide what the page actually does: `.next` (about 8 MB), `server.js`, and `package.json`.

- Edit the code, then double-click `一键升级.bat` in the project root. It picks the path that matches the local install:
  - **Prebuilt package install** (the install folder has `server.js` / `node.exe`, i.e. it came from a release zip or the in-app updater): run the tests, rebuild, back up the current runtime, copy over only `.next`, `server.js`, `package.json`, and five runtime scripts: apply-update, launch-update, start-papermate, stop-papermate, uninstall, restart the service, read the version back, and open the page. Usually under a minute.
  - **Source install** (created by `install.ps1 -Upgrade`): run the incremental source upgrade, then start the service and open the page.
- Have a `.patch` file? Drag it onto `一键升级.bat` (equivalent to `-Patch xxx.patch`). The patch is dry-run checked first, then applied, tested, and built. Any `.rej` / `.orig` leftovers abort the run before the install is touched.
- Roll back the last development deploy:

```powershell
powershell -File scripts\upgrade-local.ps1 -Undo
```

- List rollback points: `powershell -File scripts\upgrade-local.ps1 -ListBackups`. Backups live in `%LOCALAPPDATA%\PaperMate\dev-backups\` and the newest 5 are kept.
- The engine is `scripts\quick-patch.ps1` (called by `一键升级.bat`). Useful switches: `-SkipTests`, `-SkipBuild`, `-NoRestart`, `-NoBrowser`, `-IncludePublic` (also copy `public\`; by default `prompts.txt`, `quotes.txt`, and `buddy-personas.txt` are left alone because they are user data - add `-ForcePublic` to overwrite them too).

Caveats:

- The runtime-overlay path only works for a **prebuilt package install**; for a source install `一键升级.bat` automatically switches to `install.ps1 -Upgrade`.
- When the dependency list in `package.json` changed, the traced `node_modules` from the standalone output is copied as well, so the app cannot start into a `MODULE_NOT_FOUND`.
- What you deploy is a development build: `papermate-version.json` is marked `devBuild: true` and the app reports version `1`, so **in-app update keeps offering "a new version 4.x"**. That is expected; accepting it restores the official package on this machine.
- Restore an official package:

```powershell
powershell -File scripts\install-package.ps1 -PackageZip <official zip> -Force
```

- Even faster, with no build and no restart: run `npm run dev` in the source folder and let hot reload do the work.

## Manual Development Setup

PaperMate is a Next.js application and works on any OS supported by Node.js.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`, enter your DeepSeek API key in the model settings, and verify the connection.

Production build:

```bash
npm run build
npm start
```

## Requirements

- Windows 10 or Windows 11 for the installers.
- Prebuilt package install: nothing else.
- Source install: Node.js 22.5 or newer. The installer checks the version and automatically tries to install or upgrade to Node.js LTS with `winget` when it is missing or too old.
- Internet access on first source install to download npm dependencies.
- A DeepSeek API key for AI features.

## Notes

- The first release supports PDFs with a text layer only; scanned PDFs with no selectable text cannot be read.
- The original PDF is not uploaded. Only the text excerpts needed for the current request are sent to the model provider.
- Data is stored in the local SQLite database at `data/papermate.db`. Complete JSON backups are written to `data/papermate-backup.json` only when you use the backup, export, or restore actions.
