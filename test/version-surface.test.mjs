import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('package and lock versions stay aligned', () => {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');

  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
});

test('installed artifact smoke path is version-derived', () => {
  const smoke = readFileSync('scripts/installed-artifact-smoke.mjs', 'utf8');
  const readme = readFileSync('README.md', 'utf8');

  assert.match(smoke, /STRONK_PI_SMOKE_PLUGIN_VERSION/);
  assert.doesNotMatch(smoke, /stronk-pi-plugin-\d+\.\d+\.\d+\/package\/src\/index\.mjs/);
  assert.doesNotMatch(readme, /stronk-pi-plugin-\d+\.\d+\.\d+\/package\/src\/index\.mjs/);
});

test('project scope release skill points at release commands', () => {
  const skill = readFileSync('.agents/skills/stronk-pi-plugin-release/SKILL.md', 'utf8');
  const evals = readJson('.agents/skills/stronk-pi-plugin-release/evals/evals.json');

  assert.match(skill, /name: stronk-pi-plugin-release/);
  assert.match(skill, /npm run version:bump -- <version>/);
  assert.match(skill, /gh workflow run release\.yml --ref main -f version=<version>/);
  assert.match(skill, /BUILD-MANIFEST\.json/);
  assert.match(skill, /publishing is blocked/);
  assert.equal(evals.skill_name, 'stronk-pi-plugin-release');
  assert.ok(evals.evals.length >= 4);
});
