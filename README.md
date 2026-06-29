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
  `todoread`, `question`, `image_read`, `image_preflight_read`, `web_search`,
  `code_search`, and guarded `fetch_content`.
- Prompt-time image preflight keeps the inline block bounded, but when a
  Stronk Pi session binding is available it also saves an extended bounded
  sanitized text analysis as a private session artifact.
  The vision provider still receives one multi-image request; only the saved
  readback artifacts are split into three-image groups.
  The inline block is only a compact artifact index: image labels, safe
  filenames, MIME/size hints, and opaque handles grouped at up to three images
  per handle.
  Text-only models must call `image_preflight_read` with the relevant handle
  before making visual claims, without receiving raw image bytes, base64, or
  unnecessary absolute local paths.
- `image_read` is the explicit agentic image-reading tool for text-only models
  that discover local image files after the prompt starts.
  It reads exactly one image per call, using either one explicit path or one
  bounded directory scan that resolves exactly one image.
  It reuses the configured image vision preflight model route, byte limit,
  timeout, safe failure classification, Image Evidence Index, and
  image-scoped evidence IDs.
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
- `stronkpi` loads the installed plugin artifact whose directory version
  matches this repo's `package.json` version.
  After changing this repo's runtime tool surface, refresh the setup-managed
  artifact and verify `stronkpi --validate-only` plus `stronkpi --diagnose`.
- `stronk_subagent` requires an explicit role manifest from the harness. The
  default manifest is `~/.stronk-pi/config/roles.toml`; the optional local
  overlay is `~/.stronk-pi/config/roles.local.toml`.
- `stronk_subagent` is the only public Stronk-owned subagent lifecycle tool.
  Raw upstream `subagent` calls and user-supplied model, tool, skill, worktree,
  chain, context, background, and output-path overrides are denied.
- Public `stronk_subagent` results are path-clean.
  They do not expose child `cwd`, upstream temp paths, durable output paths,
  private ledger paths, or debug artifact paths.
  Debug mode may expose non-path diagnostics such as run IDs, project refs,
  counts, hashes, and booleans.
- Child runs use fresh context.
  Parent-loaded `$skill` content is passed through the prompt context rather
  than through public `skills` override fields.
- Role aliases are transparent in tool results.
  Check `roleRequested`, `roleUsed`, and `aliasResolved` in role routing
  reports instead of assuming the requested role is what ran.
- Use long waits for real child work.
  If a wait returns `timedOut=true`, follow `recommendedNextAction` and wait
  again or diagnose rather than treating the child as terminal.
- Use `wait_all` when coordinating multiple known children.
  Pass explicit current-run `childIds`; duplicate, invalid, over-limit,
  unknown, or foreign child IDs are denied before waiting starts.
  Batch results preserve request order and show terminal, non-terminal, failed,
  and timed-out children separately.
- Provider capacity failures are retryable lifecycle state, not child findings.
  When a child has `failureClass="provider_capacity"`, `retryable=true`, or
  `retryableCapacityChildIds` in `wait_all`, do not synthesize from that child.
  If `retryPolicy="after_retry_after"`, wait for `nextRetryAfterMs`; if
  `retryPolicy="after_nonterminal_drain"`, wait for the rest of the batch to
  finish first.
  Then use guarded `revive` to retry capacity-blocked children in the next batch.
  Do not switch models, add fallback models, or add provider/concurrency
  overrides.
  Capacity error prose is intentionally not exposed as readable child output.
- Terminal children may include an opaque `childOutputHandle` for sanitized
  durable output.
  Lifecycle responses do not include inline output previews.
  Use `read_output` with `outputHandle`, `offset`, and `maxChars` for bounded
  chunks.
  Handles are not paths and remain readable after close for final synthesis and
  audit.
- Use `close_all` for explicit batch cleanup.
  A valid batch close can still report per-child close or cleanup failures;
  inspect `failedCloseChildIds`, `cleanupFailedChildIds`, `cleanupState`,
  `processLive`, and `cleanupVerified` instead of treating aggregate tool
  success as proof that every child cleaned up.
- Do not synthesize from partial lifecycle state.
  Wait until every child is terminal, then close completed children after
  synthesis and report `cleanupState`, `processLive`, and `cleanupVerified`.
- Recheck file-line citations at synthesis time.
  Child output can be stale; cite current file references only after rereading
  the referenced lines.
- When Pi UI exposes `ctx.ui.addAutocompleteProvider`, Stronk Pi layers
  metadata-only `$skill` autocomplete on top of the built-in composer;
  submitted-prompt injection remains the source of truth.
- Community package tools are allowed only when loaded by the guarded Stronk Pi
  launcher: `pi-ask-user` for `ask_user`.
- `apply_patch` stays denied until a full patch parser and shared hook
  validation path exists.
- On normal interactive shutdown, Stronk Pi prints a wrapper-owned
  `stronkpi --session <id>` resume hint when a persisted session is available.
- No secrets belong in this repo.

Run checks:

```bash
npm test
npm run lint:security
```

## Release Bump

Prepare a plugin version bump in this repo:

```bash
npm run version:bump -- 0.2.2
npm ci --ignore-scripts
npm run check
```

After the bump PR is merged, publish the release from GitHub Actions:

```bash
gh workflow run release.yml --ref main -f version=0.2.2
```

The release workflow verifies that the workflow input matches `package.json`,
packs the plugin, writes `BUILD-MANIFEST.json`, generates an attestation, and
publishes the immutable `stronk-pi-plugin-v<version>` release.

The `stronk-pi` distribution repo consumes that release in a separate PR.
Agents can also use the project-scope `stronk-pi-plugin-release` skill in this
repo.
