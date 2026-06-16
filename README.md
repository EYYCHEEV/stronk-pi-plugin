# stronk-pi

Guarded Pi Coding Agent extension for Stronk Pi.

This repo owns Pi extension code, tests, continuous integration, gitleaks, and
release artifacts. Setup and installation are handled by the separate
`stronk-pi-setup` repository.

## Contract

- Safety hooks fail closed.
- Telegram/notification hooks fail open.
- Top-level `bash`, `write`, and `edit` route through the shared
  Claude/Codex dangerous-command hook and Stronk Pi path/secret checks.
- Pi child write-swarms in real repos require launcher-owned SQLite task claims
  with explicit `OWNERSHIP`; `--scratch-write` is retained for guard tests.
- Stronk-owned OpenCode parity tools registered here: `glob`, `todowrite`,
  `todoread`, `question`, and guarded `stronk_fetch_content`.
- When Pi UI exposes `ctx.ui.addAutocompleteProvider`, Stronk Pi layers
  metadata-only `$skill` autocomplete on top of the built-in composer;
  submitted-prompt injection remains the source of truth.
- Community package tools are allowed only when loaded by the guarded Stronk Pi
  launcher:
  `pi-web-access` for `web_search`, `code_search`,
  `get_search_content`, and `pi-ask-user` for `ask_user`.
- `apply_patch` stays denied until a full patch parser and shared hook
  validation path exists.
- On normal interactive shutdown, Stronk Pi prints a Pi-native
  `pi --session <id>` resume hint when a persisted session is available.
- No secrets belong in this repo.

Run checks:

```bash
npm test
npm run lint:security
```
