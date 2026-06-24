#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function fail(message) {
  console.error(`stronk-pi-plugin version:bump: ${message}`);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const version = process.argv[2];
if (!version) {
  fail('usage: npm run version:bump -- <semver>');
}
if (!VERSION_RE.test(version)) {
  fail(`invalid semver: ${version}`);
}

const pkg = readJson('package.json');
const lock = readJson('package-lock.json');

if (pkg.name !== 'stronk-pi-plugin') {
  fail(`package.json name must be stronk-pi-plugin, got ${pkg.name}`);
}
if (lock.name !== 'stronk-pi-plugin') {
  fail(`package-lock.json name must be stronk-pi-plugin, got ${lock.name}`);
}
if (!lock.packages?.['']) {
  fail('package-lock.json missing packages[""] root entry');
}
if (lock.packages[''].name && lock.packages[''].name !== 'stronk-pi-plugin') {
  fail(`package-lock root name must be stronk-pi-plugin, got ${lock.packages[''].name}`);
}

pkg.version = version;
lock.version = version;
lock.packages[''].version = version;

writeJson('package.json', pkg);
writeJson('package-lock.json', lock);

console.log(`stronk-pi-plugin version:bump: ${version}`);
