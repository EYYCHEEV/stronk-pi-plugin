# Stronk Pi Plugin Release SOP

This repo owns the plugin source and the immutable GitHub release artifact.
The `stronk-pi` distribution repo consumes the release after it exists.

## Bump

```bash
npm run version:bump -- 0.2.0
npm ci --ignore-scripts
npm run check
git diff -- package.json package-lock.json README.md scripts test docs
```

Open and merge a PR for the bump after CI passes.

## Publish

After the bump PR is on `main`, run the release workflow:

```bash
gh workflow run release.yml --ref main -f version=0.2.0
gh run list --workflow release.yml --branch main --limit 1
gh run watch
```

Download the release metadata for the distribution repo:

```bash
mkdir -p /tmp/stronk-pi-plugin-v0.2.0
gh release download stronk-pi-plugin-v0.2.0 \
  --repo EYYCHEEV/stronk-pi-plugin \
  --pattern 'stronk-pi-plugin-0.2.0.tgz' \
  --pattern 'SHA256SUMS.txt' \
  --pattern 'BUILD-MANIFEST.json' \
  --dir /tmp/stronk-pi-plugin-v0.2.0
```

Verify the attestation before importing into setup:

```bash
gh attestation verify /tmp/stronk-pi-plugin-v0.2.0/stronk-pi-plugin-0.2.0.tgz \
  --repo EYYCHEEV/stronk-pi-plugin
```

## Handoff To Distribution

In `stronk-pi`, import the downloaded `BUILD-MANIFEST.json` with the
distribution release command documented in that repo.

The release is inert until `stronk-pi` consumes it in `manifests/current.json`.
