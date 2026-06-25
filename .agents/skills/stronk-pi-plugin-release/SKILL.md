---
name: stronk-pi-plugin-release
description: Use inside the stronk-pi-plugin repo for Stronk Pi plugin releases: plugin version bumps, release preparation, GitHub Actions release dispatch planning, BUILD-MANIFEST handoff, attestation checks, installed artifact smoke expectations, or questions about the plugin release SOP. Trigger for requests like "bump the Stronk Pi plugin version", "publish the plugin release", "verify the plugin attestation", or "prepare the BUILD-MANIFEST handoff". Do not use for importing the plugin into the stronk-pi distribution manifest; use the distribution release skill for that.
---

# Stronk Pi Plugin Release

This repo owns the Stronk Pi plugin source and immutable release artifact.
The `stronk-pi` distribution repo consumes the plugin release later through its
manifest import command.

## First Checks

1. Read `docs/release.md`.
2. Inspect `package.json`, `package-lock.json`, and
   `.github/workflows/release.yml`.
3. Confirm the target semantic version.
4. Do not commit, push, tag, publish, or dispatch the release workflow without
   explicit operator confirmation for the exact command.

## Bump

Prepare the plugin version bump:

```sh
npm run version:bump -- <version>
npm ci --ignore-scripts
npm run check
git diff -- package.json package-lock.json README.md scripts test docs
```

The bump command updates `package.json` and `package-lock.json`.
It does not update the distribution manifest.

Open a PR for the bump, wait for CI, and merge it to `main` before any publish
step.
If the operator has not confirmed the PR and merge state, stop and report that
publishing is blocked.

## Publish

After the bump is merged to `main` and the operator confirms the workflow
dispatch, run:

```sh
gh workflow run release.yml --ref main -f version=<version>
gh run list --workflow release.yml --branch main --limit 1
gh run watch
```

The workflow validates that the input version matches `package.json`, runs the
checks, packs the plugin, writes `BUILD-MANIFEST.json`, generates an
attestation, and creates the immutable `stronk-pi-plugin-v<version>` release.

## Handoff To Distribution

Download the release metadata and verify the attestation:

```sh
mkdir -p /tmp/stronk-pi-plugin-v<version>
gh release download stronk-pi-plugin-v<version> \
  --repo EYYCHEEV/stronk-pi-plugin \
  --pattern 'stronk-pi-plugin-<version>.tgz' \
  --pattern 'SHA256SUMS.txt' \
  --pattern 'BUILD-MANIFEST.json' \
  --dir /tmp/stronk-pi-plugin-v<version>
gh attestation verify /tmp/stronk-pi-plugin-v<version>/stronk-pi-plugin-<version>.tgz \
  --repo EYYCHEEV/stronk-pi-plugin
```

Then switch to the `stronk-pi` repo and import the downloaded
`BUILD-MANIFEST.json` with that repo's release skill.

## Eval Guidance

Lightweight skill-creator eval prompts live in `evals/evals.json`.
Use them when checking trigger behavior or revising this skill.

## Report

End with the version target, files changed, validation commands and outcomes,
the release artifact or manifest path, and the remaining distribution handoff
step.
