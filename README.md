# stronk-pi

Private Pi Coding Agent extension for the guarded `sp` launcher in
`agentic-workstation`.

This repo owns Pi extension code, tests, continuous integration, gitleaks, and
package lifecycle. Workstation integration remains in `agentic-workstation`.

## Contract

- Safety hooks fail closed.
- Telegram/notification hooks fail open.
- Write-capable tools are blocked unless the launcher enables scratch-write
  mode in a disposable temp git repo.
- No secrets belong in this repo.

Run checks:

```bash
npm test
npm run lint:security
```
