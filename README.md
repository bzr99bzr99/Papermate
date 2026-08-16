# PaperMate

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18.18.0-brightgreen)
![Next.js](https://img.shields.io/badge/Next.js-15-black)

PaperMate is a local-first, AI-assisted PDF reading tool for academic papers. Import a PDF with a text layer, read it in its original page layout, select passages directly on the page, and ask DeepSeek to translate, explain, answer questions, or generate reading notes, argument maps, and writing analysis.

Chinese users can read [README.zh-CN.md](README.zh-CN.md). Windows one-click installation is documented in [安装说明.md](安装说明.md) and [INSTALL.md](INSTALL.md).

## Features

- **Original-page PDF reading** - PDF.js renders pages exactly as published, with a transparent text layer for precise selection.
- **Passage selection** - Select a paragraph or combine up to 20 fragments with `Ctrl`/`Cmd` before asking a question.
- **Multi-turn chat** - Ask about the selected text, or ask freely while the app attaches the current selection as context.
- **Two model modes** - `Flash` for fast translation and routine questions; `MAX thinking` for explanation, summarization, and writing analysis.
- **Structured reading artifacts** - Generate reading notes, a collapsible paper mind map, and a writing-strategy analysis in Markdown with math rendering.
- **Local-first data** - PDFs, highlights, conversations, notes, and generated artifacts are stored in browser IndexedDB and mirrored to a local disk backup.
- **Windows one-click installer** - The included scripts install dependencies, build the production app, create desktop/Start menu shortcuts, and register an uninstall entry.

## Requirements

- Node.js 18.18 or newer (Node.js LTS recommended)
- npm
- A [DeepSeek API key](https://platform.deepseek.com/) for model requests
- Windows 10/11 for the one-click installer; manual development works on any OS supported by Node.js and Next.js

## Quick Start

```bash
npm install
npm run dev
```

Open `http://localhost:3000`, click **模型设置 / Model settings**, enter your DeepSeek API key, and verify the connection.

## Windows One-Click Install

Double-click `一键安装.bat`, choose an install location, and the installer will copy the project, install dependencies, build the production app, and create shortcuts. Uninstall is available from the Start menu, the install directory, or Windows Settings. See [INSTALL.md](INSTALL.md) and [安装说明.md](安装说明.md) for details.

## Usage

1. Drag a PDF with a text layer into the app, or click to choose a file.
2. Read the original pages and select a passage.
3. Use `Ctrl`/`Cmd` to add more fragments to the selection.
4. Ask a question, translate the selection, or generate notes, a mind map, or writing analysis.
5. Use **Flash** for fast responses and **MAX 思考** for deeper reasoning.

## Interface Overview

| Screen | Description |
| --- | --- |
| ![Library home](截图/首页.png) | Paper library: drag in PDFs, search papers, and check disk backup status. |
| ![Reading and selection](截图/辅助阅读.png) | Original-page reader with a transparent text layer for passage selection. |
| ![Chat](截图/问答.png) | Selected passage plus multi-turn questions and one-click translation/explanation prompts. |
| ![Settings](截图/设置.png) | Model settings, API key verification, themes, and local backup management. |
| ![Reading notes](截图/阅读笔记.png) | Generated reading notes with page-referenced evidence. |
| ![Mind map](截图/论文脑图.png) | Collapsible argument-structure mind map. |
| ![Writing analysis](截图/写作思路.png) | Writing-strategy analysis with reusable frameworks. |

## Saving Results

- Reading notes and writing analysis are editable Markdown. Click **保存本地** to download a `.md` file named after the paper and artifact, for example `1706.03762v7-阅读笔记.md`.
- A mind map can be downloaded as an `.svg` image with the same naming convention.
- Every generated artifact is also kept in browser IndexedDB and mirrored to `data/papermate-backup.json`, so results survive cache clearing when the project folder is preserved.
- The settings panel provides full-library backup: backup now, restore from disk, export a JSON backup, and import one on another machine.
- Sample generated files are included under `截图/`: [reading notes](截图/1706.03762v7-阅读笔记.md) and [writing analysis](截图/1706.03762v7-写作思路.md).

## Privacy

- PDFs, text blocks, selections, conversations, and generated content are stored in the current browser's IndexedDB and automatically mirrored to `data/papermate-backup.json` on local disk.
- The API key stays in page memory and is not written to IndexedDB, backup files, exports, or server logs.
- The original PDF is never uploaded. Only the text excerpts needed for the current request are sent to the model provider.
- The first release supports searchable PDFs only. OCR, DOCX, accounts, and cloud sync are not included.

## Project Structure

```text
app/          Next.js App Router pages and API routes
components/   PDF reader and UI components
lib/          PDF parsing, storage, backup, mind maps, and tests
scripts/      Windows install/start/stop/uninstall scripts
```

## Development Scripts

```bash
npm run dev    # start the development server
npm run lint   # run ESLint
npm run test   # run Vitest tests
npm run build  # create a production build
npm start      # run the production build
```

## Tech Stack

Next.js 15, React 19, TypeScript, PDF.js, IndexedDB (`idb`), DeepSeek Chat Completions with streaming, `react-markdown`, KaTeX, ESLint, and Vitest.

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening issues or pull requests, and follow our [Code of Conduct](CODE_OF_CONDUCT.md). Security issues should be reported through [SECURITY.md](SECURITY.md).

## License

Released under the [MIT License](LICENSE).
