# PaperMate Installation Guide

PaperMate includes a Windows one-click installer for people who do not want to run npm commands. Developers can also run it manually with Node.js.

## Windows One-Click Install

1. Double-click `一键安装.bat` in the project root.
2. Choose an installation folder. The default suggestion is `D:\PaperMate`; you can create a new folder or select another ordinary folder.
3. Wait for the installer to copy the project, install npm dependencies, build the production app, and create shortcuts.
4. After installation, use the desktop shortcut `PaperMate 论文助手` to start the app.

The installer does not modify the original project folder when you choose a separate install location. It copies the source files into the selected folder and installs dependencies there. If you choose the project folder itself, it installs directly in place.

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

- Windows 10 or Windows 11 for the one-click installer.
- Node.js LTS. The installer automatically tries to install it with `winget` when it is missing.
- Internet access on first install to download npm dependencies.
- A DeepSeek API key for AI features.

## Notes

- The first release supports PDFs with a text layer only; scanned PDFs with no selectable text cannot be read.
- The original PDF is not uploaded. Only the text excerpts needed for the current request are sent to the model provider.
- Data is stored in the browser IndexedDB and mirrored to `data/papermate-backup.json` on local disk.
