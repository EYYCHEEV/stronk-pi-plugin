import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { internals } from '../src/index.mjs';

function tempScript(source) {
  const dir = mkdtempSync(join(tmpdir(), 'stronk-pi-sensitive.'));
  const script = join(dir, 'helper.mjs');
  writeFileSync(script, source);
  chmodSync(script, 0o700);
  return script;
}

function captureAllowScript(capturePath) {
  return tempScript(`#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let input = '';
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(capturePath)}, input);
  console.log(JSON.stringify({ allow: true, reason: 'ok' }));
});
`);
}

function withEnv(env, fn) {
  const old = {};
  for (const key of Object.keys(env)) {
    old[key] = process.env[key];
    process.env[key] = env[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(env)) {
        if (old[key] === undefined) delete process.env[key];
        else process.env[key] = old[key];
      }
    });
}

function tempCapture() {
  const dir = mkdtempSync(join(tmpdir(), 'stronk-pi-sensitive-capture.'));
  return join(dir, 'capture.json');
}

test('benign sensitive vocabulary in tool_call input reaches the guard', async () => {
  const capture = tempCapture();
  const script = captureAllowScript(capture);

  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([script]) }, async () => {
    const result = await internals.handleToolCall({
      toolName: 'bash',
      input: {
        command: 'printf ok',
        token: 'page cursor placeholder',
        auth: 'none',
        nested: {
          apiKey: 'example key from docs',
          password: 'placeholder only',
          secret: 'not a credential',
        },
      },
      cwd: process.cwd(),
    });

    assert.equal(result, undefined);
  });

  const captured = readFileSync(capture, 'utf8');
  assert.match(captured, /printf ok/);
  assert.doesNotMatch(captured, /page cursor placeholder/);
  assert.doesNotMatch(captured, /example key from docs/);
  assert.match(captured, /<redacted>/);
});

test('benign sensitive assignment vocabulary in user_bash reaches the guard', async () => {
  const capture = tempCapture();
  const script = captureAllowScript(capture);

  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([script]) }, async () => {
    const result = await internals.handleUserBash({
      command: "printf 'apiKey: example password=placeholder auth=none token=dummy'",
      cwd: process.cwd(),
      excludeFromContext: false,
    });

    assert.equal(result, undefined);
  });

  const captured = readFileSync(capture, 'utf8');
  assert.match(captured, /apiKey:\s*<redacted>/);
  assert.match(captured, /password=<redacted>/);
});

test('high-confidence token literals in tool_call input block before helper execution', async () => {
  const capture = tempCapture();
  const script = captureAllowScript(capture);
  const fakeSecret = `sk-${'a'.repeat(24)}`;

  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([script]) }, async () => {
    const result = await internals.handleToolCall({
      toolName: 'bash',
      input: { command: `printf ${fakeSecret}` },
      cwd: process.cwd(),
    });

    assert.equal(result.block, true);
    assert.match(result.reason, /secret literal blocked in tool_call input/);
  });

  assert.equal(existsSync(capture), false);
});

test('private key literals in user_bash block before helper execution', async () => {
  const capture = tempCapture();
  const script = captureAllowScript(capture);

  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([script]) }, async () => {
    const result = await internals.handleUserBash({
      command: "printf '-----BEGIN PRIVATE KEY-----'",
      cwd: process.cwd(),
      excludeFromContext: false,
    });

    assert.equal(result.result.exitCode, 1);
    assert.match(result.result.output, /secret literal blocked in user_bash command/);
  });

  assert.equal(existsSync(capture), false);
});

test('blocking detector ignores key names but catches real secret-shaped values', () => {
  assert.equal(internals.hasBlockingSensitiveContent({ token: 'placeholder', auth: 'none' }), false);
  assert.equal(internals.hasBlockingSensitiveContent({ note: `ghp_${'b'.repeat(32)}` }), true);
  assert.equal(internals.hasBlockingSensitiveContent({ header: `Bearer ${'c'.repeat(24)}` }), true);
  assert.equal(internals.hasBlockingSensitiveContent({ pem: '-----BEGIN PRIVATE KEY-----' }), true);
});

test('redaction still protects helper stdin and logs', () => {
  const fakeSecret = `ghp_${'d'.repeat(32)}`;
  const redacted = JSON.stringify(internals.redact({
    token: 'placeholder',
    message: `Authorization: Bearer ${'e'.repeat(24)}`,
    value: fakeSecret,
  }));

  assert.match(redacted, /<redacted>/);
  assert.doesNotMatch(redacted, /placeholder/);
  assert.doesNotMatch(redacted, new RegExp(fakeSecret));
  assert.doesNotMatch(redacted, /Bearer e/);
});
