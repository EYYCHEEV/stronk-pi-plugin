import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import stronkPi, { internals } from '../src/index.mjs';

function tempScript(source) {
  const dir = mkdtempSync(join(tmpdir(), 'stronk-pi-test.'));
  const script = join(dir, 'helper.mjs');
  writeFileSync(script, source);
  chmodSync(script, 0o700);
  return script;
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

function allowScript() {
  return tempScript(`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({ allow: true, reason: 'ok' })));
`);
}

function denyScript() {
  return tempScript(`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({ allow: false, reason: 'denied' })));
`);
}

test('registers Pi hook handlers', async () => {
  const handlers = new Map();
  await stronkPi({ on: (name, handler) => handlers.set(name, handler) });
  assert.equal(typeof handlers.get('tool_call'), 'function');
  assert.equal(typeof handlers.get('user_bash'), 'function');
});

test('JSON deny blocks tool_call', async () => {
  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([denyScript()]) }, async () => {
    const result = await internals.handleToolCall({
      toolName: 'bash',
      input: { command: 'printf ok' },
      cwd: process.cwd(),
    });
    assert.equal(result.block, true);
    assert.match(result.reason, /denied/);
  });
});

test('missing guard command blocks tool_call', async () => {
  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify(['/missing/stronk-pi-helper']) }, async () => {
    const result = await internals.handleToolCall({
      toolName: 'bash',
      input: { command: 'printf ok' },
      cwd: process.cwd(),
    });
    assert.equal(result.block, true);
  });
});

test('non-zero guard exit blocks tool_call', async () => {
  const script = tempScript(`#!/usr/bin/env node
process.exit(1);
`);
  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([script]) }, async () => {
    const result = await internals.handleToolCall({
      toolName: 'bash',
      input: { command: 'printf ok' },
      cwd: process.cwd(),
    });
    assert.equal(result.block, true);
    assert.match(result.reason, /exited 1/);
  });
});

test('malformed guard stdout blocks tool_call', async () => {
  const script = tempScript(`#!/usr/bin/env node
console.log('not json');
`);
  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([script]) }, async () => {
    const result = await internals.handleToolCall({
      toolName: 'bash',
      input: { command: 'printf ok' },
      cwd: process.cwd(),
    });
    assert.equal(result.block, true);
    assert.match(result.reason, /malformed JSON/);
  });
});

test('timeout blocks tool_call', async () => {
  const script = tempScript(`#!/usr/bin/env node
setTimeout(() => {}, 10000);
`);
  await withEnv({
    STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([script]),
    STRONK_PI_GUARD_TIMEOUT_MS: '30',
  }, async () => {
    const result = await internals.handleToolCall({
      toolName: 'bash',
      input: { command: 'printf ok' },
      cwd: process.cwd(),
    });
    assert.equal(result.block, true);
    assert.match(result.reason, /timed out/);
  });
});

test('missing response keys blocks tool_call', async () => {
  const script = tempScript(`#!/usr/bin/env node
console.log(JSON.stringify({ ok: true }));
`);
  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([script]) }, async () => {
    const result = await internals.handleToolCall({
      toolName: 'bash',
      input: { command: 'printf ok' },
      cwd: process.cwd(),
    });
    assert.equal(result.block, true);
    assert.match(result.reason, /missing keys/);
  });
});

test('mutated payload blocks tool_call', async () => {
  const script = tempScript(`#!/usr/bin/env node
process.stdin.resume();
setTimeout(() => console.log(JSON.stringify({ allow: true, reason: 'ok' })), 50);
`);
  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([script]) }, async () => {
    const event = { toolName: 'bash', input: { command: 'printf ok' }, cwd: process.cwd() };
    const pending = internals.handleToolCall(event);
    event.input.command = 'sudo whoami';
    const result = await pending;
    assert.equal(result.block, true);
    assert.match(result.reason, /mutated/);
  });
});

test('unknown mutating tool is denied before helper execution', async () => {
  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([allowScript()]) }, async () => {
    const result = await internals.handleToolCall({
      toolName: 'apply_patch',
      input: { path: 'x', content: 'y' },
      cwd: process.cwd(),
    });
    assert.equal(result.block, true);
    assert.match(result.reason, /unsupported mutating tool/);
  });
});

test('user_bash denial returns a failed synthetic result', async () => {
  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([denyScript()]) }, async () => {
    const result = await internals.handleUserBash({
      command: 'sudo whoami',
      cwd: process.cwd(),
      excludeFromContext: false,
    });
    assert.equal(result.result.exitCode, 1);
    assert.match(result.result.output, /BLOCKED/);
  });
});

test('telegram helper failure is fail-open', async () => {
  await withEnv({ STRONK_PI_TELEGRAM_COMMAND_JSON: JSON.stringify(['/missing/telegram-helper']) }, async () => {
    await assert.doesNotReject(() => internals.notify({ type: 'agent_end' }));
  });
});

test('redacts secrets before helper stdin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stronk-pi-redact.'));
  const capture = join(dir, 'capture.json');
  const fakeSecret = `sk-${'abcdefghijklmnopqrstuvwxyz'}`;
  const script = tempScript(`#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let input = '';
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(capture)}, input);
  console.log(JSON.stringify({ allow: true, reason: 'ok' }));
});
`);
  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([script]) }, async () => {
    await internals.handleToolCall({
      toolName: 'bash',
      input: { command: `printf ${fakeSecret}` },
      cwd: process.cwd(),
    });
  });
  const captured = readFileSync(capture, 'utf8');
  assert.doesNotMatch(captured, new RegExp(fakeSecret));
  assert.match(captured, /<redacted>/);
});
