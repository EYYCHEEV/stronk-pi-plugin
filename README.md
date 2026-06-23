# stronk-pi-plugin

Guarded Pi Coding Agent extension for Stronk Pi.

> Status: Public preview / integration component
>
> This repository contains the Stronk Pi plugin source and tests. It is not a
> standalone Pi distribution and is not meant to be installed directly by end
> users yet.
>
> It is consumed by the public `stronk-pi` bundle contract, which owns
> the guarded `stronkpi` harness, role manifests, Model Context Protocol (MCP)
> policy, trusted runtime pins, default config, and local overlay paths.

This repo owns Pi extension code, tests, continuous integration, gitleaks, and
release artifacts. Setup and installation are handled by the separate
`stronk-pi` distribution repository. This repository was previously named
`stronk-pi`; old release URLs must not be used after the distribution repo
takes that name.

## Contract

- Safety hooks fail closed.
- Telegram/notification hooks fail open.
- Top-level `bash`, `write`, and `edit` route through the shared
  Claude/Codex dangerous-command hook and Stronk Pi path/secret checks.
- Pi child write-swarms in real repos require launcher-owned SQLite task claims
  with explicit `OWNERSHIP`; `--scratch-write` is retained for guard tests.
- Stronk-owned OpenCode parity tools registered here: `glob`, `todowrite`,
  `todoread`, `question`, `web_search`, `code_search`, and guarded
  `fetch_content`.
- Stronk-owned `web_search` supports exactly `exa`, `brave`, `tavily`, and
  `gemini` via `STRONK_PI_SEARCH_PROVIDER`. Provider keys are read only from
  local environment variables: `EXA_API_KEY`, `BRAVE_SEARCH_API_KEY`,
  `TAVILY_API_KEY`, and `GEMINI_API_KEY`.
- The setup-owned guarded `stronkpi` harness sets
  `STRONK_PI_SEARCH_PROVIDER=exa` when unset; direct plugin use still follows
  the explicit provider contract.
- `web_search.workflow` is a closed `auto|summary-review|none` enum. Omitted
  workflow is `auto`: it emits live `summary-review` progress when Pi UI/update
  support is available, and falls back to deterministic result-only `none`
  without UI. Initial `queries` run through a dependency-free provider pool
  capped at 3 active calls.
- For research-quality answers, comparisons, current facts, and uncertain
  topics, prompt the agent to use one `web_search` call with
  `workflow=summary-review` and 5-10 varied `queries`. Reserve
  `workflow=none` for quick single-query lookup, tests, and headless runs.
- In guarded launcher sessions, `summary-review` stays in the CLI. It emits
  compact redacted progress updates, renders active calls/results when the Pi
  CLI supports render hooks, prints current review state, and exposes
  keep/dismiss/fetch/fetch-kept/follow-up/finish/status actions. Result actions
  can use `resultRank` or `resultId` selectors, bulk keep/dismiss can use
  `resultRanks`, `resultIds`, or `searchResultUrls`, and `searchResultUrl`
  stays an exact-URL fallback from structured details. It never opens a browser
  window for operator curation.
- `web_search` and `code_search` keep provider titles, URLs, snippets, and
  answer blobs out of visible progress/render text; sanitized bounded result
  records and provider answers stay in returned tool content for the model, and
  full normalized records remain in structured `details.results` plus optional
  `details.answer` for runtime/review state. Results can include source
  reliability, same-host/duplicate, restricted-access/fetch-risk, and
  fetch-before-use signals.
- Stronk-owned `code_search` prefers `EXA_API_KEY` and automatically falls back
  to the configured `web_search` provider when Exa is unavailable; both paths
  emit redacted progress updates when UI/update support is available.
- Use `fetch_content` for public result URLs that need page content;
  `get_search_content` is not implemented for Stronk-owned search. Curator
  fetch actions, including explicit `fetch-kept`, call the same guarded
  `fetch_content` path, return full readable text to the model, render only
  compact metadata in the CLI, do not authorize page-content fetches from
  search-result URLs alone, and do not run automatic background page-content
  fetches. Finished reviews label kept results as `fetched`, `fetch-failed`, or
  `snippet-only`; treat `snippet-only` as a prompt to fetch before citing.
- `stronkpi` loads the installed plugin artifact at
  `~/.stronk-pi/artifacts/stronk-pi-plugin-0.1.0/package/src/index.mjs`.
  After changing this repo's runtime tool surface, refresh the setup-managed
  artifact and verify `stronkpi --validate-only` plus `stronkpi --diagnose`.
- `stronk_subagent` requires an explicit role manifest from the harness. The
  default manifest is `~/.stronk-pi/config/roles.toml`; the optional local
  overlay is `~/.stronk-pi/config/roles.local.toml`.
- When Pi UI exposes `ctx.ui.addAutocompleteProvider`, Stronk Pi layers
  metadata-only `$skill` autocomplete on top of the built-in composer;
  submitted-prompt injection remains the source of truth.
- Community package tools are allowed only when loaded by the guarded Stronk Pi
  launcher: `pi-ask-user` for `ask_user`.
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
