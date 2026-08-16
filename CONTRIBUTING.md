# Contributing to PaperMate

Thank you for considering a contribution to PaperMate.

## Ways to Contribute

- Report bugs by opening an issue with steps to reproduce.
- Suggest improvements through a feature request issue.
- Improve documentation, tests, code, or Windows installer scripts.
- Help review pull requests and answer questions.

## Reporting Issues

Before opening an issue:

- Search existing issues to avoid duplicates.
- Use the issue templates when available.
- Include the version, OS, browser, Node.js version, and the exact steps that caused the problem.
- Never include API keys, passwords, private PDFs, or other sensitive data.

## Development Setup

PaperMate is a Next.js 15 application.

```bash
npm install
npm run dev
```

Open `http://localhost:3000` and use the model settings to enter your own DeepSeek API key.

## Code Style and Checks

Before submitting changes, run:

```bash
npm run lint
npm run test
npm run build
```

Keep changes focused and consistent with the existing code style. Add or update tests in `lib/` when behavior changes.

## Pull Requests

1. Fork the repository and create a branch from `main`.
2. Make a focused change with a clear commit message.
3. Run lint, tests, and a production build locally.
4. Open a pull request and fill in the template.
5. Keep the description concise and mention any related issues.

Small, reviewable pull requests are preferred over large unrelated changes.

## Windows Installer Changes

Changes to `scripts/` affect the one-click install, start, stop, and uninstall experience. When modifying these scripts:

- Keep the default experience zero-configuration.
- Preserve the data folder during uninstall by default.
- Test both the install-to-project and install-to-new-folder paths when possible.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

---

# 参与贡献

欢迎向 PaperMate 提交 Issue、Pull Request 或文档改进。

## 提交问题

提交前请先搜索是否已有相同问题。Issue 中请说明系统版本、浏览器、Node.js 版本、复现步骤和预期结果，不要粘贴 API Key、密码、私人 PDF 等敏感信息。

## 本地开发

```bash
npm install
npm run dev
```

修改代码后请运行：

```bash
npm run lint
npm run test
npm run build
```

## Pull Request

从 `main` 创建分支，尽量做单一且聚焦的改动。提交前完成 lint、测试和生产构建，并在 PR 描述中说明改动内容和关联 Issue。

## 安装脚本

修改 `scripts/` 时，请保持默认零配置体验，并默认保留用户 `data` 文件夹中的数据。
