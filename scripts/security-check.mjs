#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const denied = [
  /rm\s+-rf\s+\//,
  /curl\b[^\n|;]*\|\s*(sh|bash|zsh)\b/,
  /wget\b[^\n|;]*\|\s*(sh|bash|zsh)\b/,
  /eval\s+\$/,
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
];

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    if (['.git', 'node_modules', 'coverage'].includes(entry)) continue;
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) {
      yield* files(path);
    } else if (st.isFile()) {
      yield path;
    }
  }
}

let failed = false;
for (const path of files(root)) {
  const text = readFileSync(path, 'utf8');
  for (const pattern of denied) {
    if (pattern.test(text)) {
      console.error(`security-check: denied pattern ${pattern} in ${path}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log('security-check: ok');
