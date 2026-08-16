# Security Policy

## Supported Versions

The `main` branch and the latest tagged release receive security fixes.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Reporting a Vulnerability

Please use GitHub's private vulnerability reporting in the **Security** tab of the repository when it is available. If private reporting is not enabled yet, open a GitHub issue with the `security` label and describe the vulnerability without including secrets or private data.

Please include:

- Affected version or commit
- Steps to reproduce
- Impact description
- Suggested fix, if you have one

Do not create a public issue that exposes an API key, private PDF, or personal data. The maintainers will confirm receipt and coordinate a fix before public disclosure.

## Security Notes for This Project

- The DeepSeek API key is kept in page memory and is sent only from the browser to the local Next.js API route for the current request.
- The original PDF is never uploaded; only the text fragments needed for a task are sent to the model provider.
- The SQLite database and backups under `data/` contain local paper data and should not be committed to the repository. They are already ignored by `.gitignore`.
- Complete JSON backups are written only when you use the backup, export, or restore actions.
