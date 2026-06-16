import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
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

function allowingPromptHookEnv(extra = {}) {
  return {
    STRONK_PI_CODEX_HOOK_COMMAND_JSON: JSON.stringify([allowScript()]),
    ...extra,
  };
}

function denyScript() {
  return tempScript(`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({ allow: false, reason: 'denied' })));
`);
}

function urlCheckScript(port) {
  return tempScript(`#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', () => {
  const payload = JSON.parse(input || '{}');
  const url = String(payload.url || '');
  if (url.includes('127.0.0.1') || url.includes('169.254.169.254')) {
    console.log(JSON.stringify({ allow: false, reason: 'private/local IP denied' }));
    return;
  }
  console.log(JSON.stringify({
    allow: true,
    url,
    hostname: 'public.example',
    addresses: [{ address: '127.0.0.1', family: 4 }],
  }));
});
`);
}

function listen(server) {
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen(server.address().port));
  });
}

function rootsJson(...roots) {
  return JSON.stringify(roots.map(([path, scope]) => ({ path, scope })));
}

function writeSkill(root, dirName, name, body = 'Skill body') {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  const skillPath = join(dir, 'SKILL.md');
  writeFileSync(skillPath, `---\nname: ${name}\ndescription: ${name} description\n---\n${body}\n`);
  return skillPath;
}

function createAutocompleteFallbackProvider() {
  return {
    async getSuggestions() {
      return {
        items: [{ value: 'base-value', label: 'base-label', description: 'base-description' }],
        prefix: 'base-prefix',
      };
    },
    applyCompletion(lines, cursorLine, cursorCol) {
      return {
        lines: [...lines],
        cursorLine,
        cursorCol,
      };
    },
    shouldTriggerFileCompletion() {
      return false;
    },
  };
}

async function createSkillAutocompleteProvider(extraEnv = {}, current = createAutocompleteFallbackProvider()) {
  const factories = [];
  const ui = {
    addAutocompleteProvider: (factory) => factories.push(factory),
    notify: () => {},
  };

  await withEnv(allowingPromptHookEnv(extraEnv), async () => {
    await internals.handleSessionStart({ reason: 'startup' }, { hasUI: true, ui });
  });

  assert.equal(factories.length, 1);
  return factories[0](current);
}

test('registers Pi hook handlers', async () => {
  const handlers = new Map();
  await stronkPi({ on: (name, handler) => handlers.set(name, handler) });
  assert.equal(typeof handlers.get('tool_call'), 'function');
  assert.equal(typeof handlers.get('user_bash'), 'function');
  assert.equal(typeof handlers.get('input'), 'function');
  assert.equal(typeof handlers.get('session_start'), 'function');
  assert.equal(typeof handlers.get('session_shutdown'), 'function');
  assert.equal(typeof handlers.get('tool_result'), 'function');
  assert.equal(typeof handlers.get('agent_end'), 'function');
  assert.equal(typeof handlers.get('permission_request'), 'function');
});

test('session_shutdown prints exact pi --session resume hint for persisted quit sessions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stronk-pi-session-hint.'));
  const sessionFile = join(dir, '2026-05-06T00-00-00-000Z_019df935-0a98-76e2-8c4c-bdc177d06994.jsonl');
  writeFileSync(sessionFile, '{"type":"session"}\n');
  const lines = [];

  const hint = internals.handleSessionShutdown(
    { type: 'session_shutdown', reason: 'quit' },
    {
      hasUI: true,
      sessionManager: {
        getSessionId: () => '019df935-0a98-76e2-8c4c-bdc177d06994',
        getSessionFile: () => sessionFile,
      },
    },
    (message) => lines.push(message),
  );

  assert.equal(hint, 'To continue this session, run pi --session 019df935-0a98-76e2-8c4c-bdc177d06994');
  assert.deepEqual(lines, [hint]);
});

test('session_shutdown default writer keeps stdout clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stronk-pi-session-hint-stderr.'));
  const sessionFile = join(dir, '2026-05-06T00-00-00-000Z_019df935-0a98-76e2-8c4c-bdc177d06994.jsonl');
  writeFileSync(sessionFile, '{"type":"session"}\n');
  let stdout = '';
  let stderr = '';
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = (chunk) => {
    stdout += String(chunk);
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr += String(chunk);
    return true;
  };
  try {
    internals.handleSessionShutdown(
      { type: 'session_shutdown', reason: 'quit' },
      {
        hasUI: true,
        sessionManager: {
          getSessionId: () => '019df935-0a98-76e2-8c4c-bdc177d06994',
          getSessionFile: () => sessionFile,
        },
      },
    );
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  assert.equal(stdout, '');
  assert.equal(stderr, 'To continue this session, run pi --session 019df935-0a98-76e2-8c4c-bdc177d06994\n');
});

test('session_shutdown still prints after Pi has stopped the interactive UI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stronk-pi-session-hint-after-stop.'));
  const sessionFile = join(dir, '2026-05-06T00-00-00-000Z_019df935-0a98-76e2-8c4c-bdc177d06994.jsonl');
  writeFileSync(sessionFile, '{"type":"session"}\n');
  const sessionManager = {
    getSessionId: () => '019df935-0a98-76e2-8c4c-bdc177d06994',
    getSessionFile: () => sessionFile,
  };
  await internals.handleSessionStart(
    { type: 'session_start', reason: 'startup' },
    { hasUI: true, ui: {}, sessionManager },
  );

  const lines = [];
  const hint = internals.handleSessionShutdown(
    { type: 'session_shutdown', reason: 'quit' },
    { hasUI: false, sessionManager },
    (message) => lines.push(message),
  );

  assert.equal(hint, 'To continue this session, run pi --session 019df935-0a98-76e2-8c4c-bdc177d06994');
  assert.deepEqual(lines, [hint]);
});

test('session_shutdown suppresses resume hint when exact resume would be unsafe or irrelevant', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stronk-pi-session-hint-suppress.'));
  const sessionFile = join(dir, 'session.jsonl');
  writeFileSync(sessionFile, '{"type":"session"}\n');
  const sessionManager = {
    getSessionId: () => '019df935-0a98-76e2-8c4c-bdc177d06994',
    getSessionFile: () => sessionFile,
  };

  for (const reason of ['reload', 'new', 'resume', 'fork']) {
    const lines = [];
    assert.equal(
      internals.handleSessionShutdown(
        { type: 'session_shutdown', reason },
        { hasUI: true, sessionManager },
        (message) => lines.push(message),
      ),
      undefined,
      reason,
    );
    assert.deepEqual(lines, []);
  }

  const cases = [
    { name: 'non-interactive context', ctx: { hasUI: false, sessionManager } },
    { name: 'missing session id', ctx: { hasUI: true, sessionManager: { getSessionFile: () => sessionFile } } },
    {
      name: 'invalid session id',
      ctx: {
        hasUI: true,
        sessionManager: {
          getSessionId: () => 'bad id; denied',
          getSessionFile: () => sessionFile,
        },
      },
    },
    {
      name: 'missing session file',
      ctx: {
        hasUI: true,
        sessionManager: {
          getSessionId: () => '019df935-0a98-76e2-8c4c-bdc177d06994',
          getSessionFile: () => join(dir, 'missing.jsonl'),
        },
      },
    },
  ];

  for (const item of cases) {
    const lines = [];
    assert.equal(
      internals.handleSessionShutdown(
        { type: 'session_shutdown', reason: 'quit' },
        item.ctx,
        (message) => lines.push(message),
      ),
      undefined,
      item.name,
    );
    assert.deepEqual(lines, [], item.name);
  }
});

test('registers Stronk Pi custom tools', async () => {
  const handlers = new Map();
  const tools = [];
  await stronkPi({
    on: (name, handler) => handlers.set(name, handler),
    registerTool: (tool) => tools.push(tool),
  });
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['glob', 'question', 'stronk_fetch_content', 'todoread', 'todowrite']);
});

test('Stronk safe fetch avoids pi-web-access fetch_content conflicts', async () => {
  const tools = new Map();
  const pi = {
    on: () => {},
    registerTool: (tool) => {
      if (!tools.has(tool.name)) tools.set(tool.name, tool);
    },
  };
  await stronkPi(pi);
  pi.registerTool({
    name: 'fetch_content',
    label: 'pi-web-access fetch_content',
    description: 'unguarded duplicate',
    parameters: {},
    execute: async () => ({ content: [{ type: 'text', text: 'unsafe duplicate' }] }),
  });
  assert.equal(tools.has('stronk_fetch_content'), true);
  assert.match(tools.get('stronk_fetch_content').description, /Stronk Pi redirect-aware SSRF guard/);
  assert.equal(tools.get('fetch_content').description, 'unguarded duplicate');
});

test('stronk_fetch_content blocks private redirect targets before following them', async () => {
  let secretReached = false;
  const server = createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/secret` });
      res.end();
      return;
    }
    if (req.url === '/secret') {
      secretReached = true;
      res.end('secret');
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  const port = await listen(server);
  try {
    await withEnv({ STRONK_PI_URL_CHECK_COMMAND_JSON: JSON.stringify([urlCheckScript(port)]) }, async () => {
      const result = await internals.executeFetchContent({ url: `http://public.example:${port}/start` });
      assert.match(result.content[0].text, /private\/local IP denied/);
      assert.equal(result.details.successful, 0);
      assert.equal(secretReached, false);
    });
  } finally {
    server.close();
  }
});

test('stronk_fetch_content returns readable text for an allowed public URL path', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<html><head><title>Example Page</title></head><body><h1>Hello</h1><p>Readable text.</p></body></html>');
  });
  const port = await listen(server);
  try {
    await withEnv({ STRONK_PI_URL_CHECK_COMMAND_JSON: JSON.stringify([urlCheckScript(port)]) }, async () => {
      const result = await internals.executeFetchContent({ url: `http://public.example:${port}/page` });
      assert.equal(result.details.successful, 1);
      assert.equal(result.details.title, 'Example Page');
      assert.match(result.content[0].text, /Readable text/);
    });
  } finally {
    server.close();
  }
});

test('tool_call forwards Codex-like hook context to the guard helper', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stronk-pi-hook-context.'));
  const capture = join(dir, 'capture.json');
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
    const result = await internals.handleToolCall(
      {
        toolName: 'bash',
        toolCallId: 'pi-call-123',
        input: { command: 'printf ok' },
        cwd: process.cwd(),
        sessionId: 'pi-session-abc',
      },
      {
        turnId: 'pi-turn-456',
        transcriptPath: '/tmp/pi-transcript.jsonl',
        model: { id: 'deepseek/deepseek-v4-pro' },
        permissionMode: 'default',
      },
    );
    assert.equal(result, undefined);
  });
  const captured = JSON.parse(readFileSync(capture, 'utf8'));
  assert.equal(captured.event, 'tool_call');
  assert.equal(captured.toolName, 'bash');
  assert.equal(captured.toolCallId, 'pi-call-123');
  assert.deepEqual(captured.hookContext, {
    session_id: 'pi-session-abc',
    turn_id: 'pi-turn-456',
    transcript_path: '/tmp/pi-transcript.jsonl',
    model: 'deepseek/deepseek-v4-pro',
    permission_mode: 'default',
    tool_use_id: 'pi-call-123',
  });
});

test('builds Codex-shaped lifecycle hook payloads', () => {
  const ctx = {
    cwd: '/tmp/project',
    sessionId: 'session-1',
    turnId: 'turn-1',
    transcriptPath: '/tmp/transcript.jsonl',
    model: { id: 'deepseek/deepseek-v4-pro' },
    permissionMode: 'default',
  };
  assert.deepEqual(internals.codexHookInput('SessionStart', { reason: 'resume' }, ctx), {
    session_id: 'session-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/project',
    hook_event_name: 'SessionStart',
    model: 'deepseek/deepseek-v4-pro',
    permission_mode: 'default',
    source: 'resume',
  });
  assert.deepEqual(internals.codexHookInput('UserPromptSubmit', { text: 'ship it' }, ctx), {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/project',
    hook_event_name: 'UserPromptSubmit',
    model: 'deepseek/deepseek-v4-pro',
    permission_mode: 'default',
    prompt: 'ship it',
  });
  assert.deepEqual(internals.codexHookInput('PermissionRequest', {
    toolName: 'bash',
    input: { command: 'printf ok' },
  }, ctx), {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/project',
    hook_event_name: 'PermissionRequest',
    model: 'deepseek/deepseek-v4-pro',
    permission_mode: 'default',
    tool_name: 'shell_command',
    tool_input: { command: 'printf ok' },
  });
  assert.deepEqual(internals.codexHookInput('PostToolUse', {
    toolName: 'write',
    toolCallId: 'tool-1',
    input: { path: 'a.txt', content: 'ok' },
    content: [{ type: 'text', text: 'done' }],
    details: { bytes: 2 },
  }, ctx), {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/project',
    hook_event_name: 'PostToolUse',
    model: 'deepseek/deepseek-v4-pro',
    permission_mode: 'default',
    tool_name: 'Write',
    tool_input: { path: 'a.txt', content: 'ok' },
    tool_response: {
      content: [{ type: 'text', text: 'done' }],
      details: { bytes: 2 },
      isError: false,
    },
    tool_use_id: 'tool-1',
  });
  assert.deepEqual(internals.codexHookInput('Stop', {
    stopHookActive: true,
    messages: [{ role: 'assistant', content: 'done' }],
  }, ctx), {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/project',
    hook_event_name: 'Stop',
    model: 'deepseek/deepseek-v4-pro',
    permission_mode: 'default',
    stop_hook_active: true,
    last_assistant_message: 'done',
  });
});

test('UserPromptSubmit hook blocks Pi input fail-closed for that prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stronk-pi-user-prompt.'));
  const capture = join(dir, 'capture.json');
  const script = tempScript(`#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let input = '';
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(capture)}, input);
  console.log(JSON.stringify({ decision: 'block', reason: 'slow down' }));
});
`);
  const notices = [];
  await withEnv({ STRONK_PI_CODEX_HOOK_COMMAND_JSON: JSON.stringify([script]) }, async () => {
    const result = await internals.handleInput(
      { type: 'input', text: 'ship prod now', source: 'interactive' },
      {
        cwd: '/tmp/project',
        sessionId: 'session-1',
        turnId: 'turn-1',
        hasUI: true,
        ui: { notify: (message, kind) => notices.push([kind, message]) },
      },
    );
    assert.deepEqual(result, { action: 'handled' });
  });
  const captured = JSON.parse(readFileSync(capture, 'utf8'));
  assert.equal(captured.hook_event_name, 'UserPromptSubmit');
  assert.equal(captured.prompt, 'ship prod now');
  assert.deepEqual(notices, [['warning', 'slow down']]);
});

test('PostToolUse hook can mark Pi tool result as failed', async () => {
  const script = tempScript(`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({ continue: false, stopReason: 'review output first' }));
});
`);
  await withEnv({ STRONK_PI_CODEX_HOOK_COMMAND_JSON: JSON.stringify([script]) }, async () => {
    const result = await internals.handleToolResult({
      type: 'tool_result',
      toolName: 'bash',
      toolCallId: 'tool-1',
      input: { command: 'printf ok' },
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });
    assert.equal(result.isError, true);
    assert.match(result.content.at(-1).text, /review output first/);
  });
});

test('glob tool finds files inside cwd and rejects path escapes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stronk-pi-glob.'));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs', 'PLAN.md'), '# Plan\n');
  writeFileSync(join(dir, '.hidden.md'), '# Hidden\n');
  writeFileSync(join(dir, 'notes.txt'), 'notes\n');

  const result = await internals.executeGlob({ pattern: '**/*.md' }, undefined, { cwd: dir });
  assert.match(result.content[0].text, /docs\/PLAN\.md/);
  assert.doesNotMatch(result.content[0].text, /\.hidden\.md/);

  await assert.rejects(
    () => internals.executeGlob({ pattern: '**/*', path: '..' }, undefined, { cwd: dir }),
    /escapes/,
  );
});

test('glob tool rejects symlink escapes from cwd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stronk-pi-glob-symlink.'));
  const outside = mkdtempSync(join(tmpdir(), 'stronk-pi-glob-outside.'));
  writeFileSync(join(outside, 'secret.md'), '# Outside\n');
  symlinkSync(outside, join(dir, 'outside'), 'dir');

  await assert.rejects(
    () => internals.executeGlob({ pattern: '**/*.md', path: 'outside' }, undefined, { cwd: dir }),
    /escapes/,
  );
});

test('glob tool falls back when ripgrep is unavailable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stronk-pi-glob-no-rg.'));
  mkdirSync(join(dir, 'docs', 'nested'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'PLAN.md'), '# Plan\n');
  writeFileSync(join(dir, 'docs', 'nested', 'DEEP.md'), '# Deep\n');
  writeFileSync(join(dir, '.hidden.md'), '# Hidden\n');
  const missingCommand = join(dir, 'missing-rg');

  const result = await internals.executeGlobWithCommand(
    { pattern: '*.md' },
    undefined,
    { cwd: dir },
    missingCommand,
  );
  assert.match(result.content[0].text, /docs\/PLAN\.md/);
  assert.match(result.content[0].text, /docs\/nested\/DEEP\.md/);
  assert.doesNotMatch(result.content[0].text, /\.hidden\.md/);

  const directChild = await internals.executeGlobWithCommand(
    { pattern: 'docs/*.md' },
    undefined,
    { cwd: dir },
    missingCommand,
  );
  assert.match(directChild.content[0].text, /docs\/PLAN\.md/);
  assert.doesNotMatch(directChild.content[0].text, /docs\/nested\/DEEP\.md/);
});

test('glob fallback applies maxResults after sorting matches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stronk-pi-glob-order.'));
  mkdirSync(join(dir, 'a'), { recursive: true });
  writeFileSync(join(dir, 'a', 'a.md'), '# A\n');
  writeFileSync(join(dir, 'y.md'), '# Y\n');
  writeFileSync(join(dir, 'z.md'), '# Z\n');
  const missingCommand = join(dir, 'missing-rg');

  const result = await internals.executeGlobWithCommand(
    { pattern: '**/*.md', maxResults: 1 },
    undefined,
    { cwd: dir },
    missingCommand,
  );
  assert.equal(result.content[0].text, 'a/a.md');
  assert.equal(result.details.truncated, true);
});

test('todowrite and todoread keep session todo state', async () => {
  const state = { todos: [] };
  const write = internals.executeTodoWrite({
    todos: [
      { id: 'one', content: 'Inspect tool parity', status: 'in_progress', priority: 'high' },
      { content: 'Verify launcher', status: 'pending' },
    ],
  }, state);
  assert.match(write.content[0].text, /one: Inspect tool parity/);
  assert.equal(write.details.count, 2);

  const read = internals.executeTodoRead(state);
  assert.match(read.content[0].text, /todo-2: Verify launcher/);
});

test('question tool falls back cleanly without interactive UI', async () => {
  const result = await internals.executeQuestion(
    { question: 'Choose a path?', options: [{ label: 'A' }, { label: 'B' }] },
    undefined,
    { hasUI: false },
  );
  assert.match(result.content[0].text, /No interactive Pi UI/);
  assert.equal(result.details.ui, false);
});

test('question tool uses Pi UI select when available', async () => {
  const result = await internals.executeQuestion(
    { header: 'Route', question: 'Choose a path?', options: [{ label: 'A' }, { label: 'B' }] },
    undefined,
    {
      hasUI: true,
      ui: {
        select: async () => 'B',
        input: async () => 'fallback',
      },
    },
  );
  assert.match(result.content[0].text, /ANSWER: B/);
  assert.equal(result.details.answer, 'B');
});

test('skill autocomplete catalog stays metadata-only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-autocomplete-catalog.'));
  writeSkill(root, 'demo', 'demo', 'Body text that must stay hidden');

  await withEnv(allowingPromptHookEnv({ STRONK_PI_SKILL_ROOTS: rootsJson([root, 'user']) }), async () => {
    const catalog = internals.loadSkillCatalog();
    assert.equal(catalog.skills.length, 1);
    assert.equal(catalog.skills[0].name, 'demo');
    assert.equal(catalog.skills[0].description, 'demo description');
    assert.equal(catalog.skills[0].contents, undefined);

    const suggestions = internals.buildSkillAutocompleteSuggestions('$');
    assert.ok(suggestions);
    assert.equal(suggestions.prefix, '$');
    assert.equal(suggestions.items[0].value, '$demo ');
    assert.match(suggestions.items[0].label, /^demo$/);
    assert.doesNotMatch(JSON.stringify(suggestions), /Body text that must stay hidden/);
  });
});

test('skill autocomplete provider handles active $ tokens and delegates non-skill text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-autocomplete-provider.'));
  writeSkill(root, 'demo', 'demo', 'Demo body');
  writeSkill(root, 'exec-plan', 'exec-plan', 'Exec plan body');

  const provider = await createSkillAutocompleteProvider({ STRONK_PI_SKILL_ROOTS: rootsJson([root, 'user']) });
  const signal = new AbortController().signal;

  assert.deepEqual(provider.triggerCharacters, ['$']);
  assert.deepEqual(
    await provider.getSuggestions(['hello world'], 0, 'hello world'.length, { signal, force: false }),
    {
      items: [{ value: 'base-value', label: 'base-label', description: 'base-description' }],
      prefix: 'base-prefix',
    },
  );

  const bare = await provider.getSuggestions(['Use $'], 0, 'Use $'.length, { signal, force: false });
  assert.ok(bare);
  assert.equal(bare.prefix, '$');
  assert.ok(bare.items.some((item) => item.value === '$demo '));

  const middle = await provider.getSuggestions(['Keep using $exec now'], 0, 'Keep using $exec'.length, {
    signal,
    force: false,
  });
  assert.ok(middle);
  assert.equal(middle.prefix, '$exec');
  assert.deepEqual(middle.items.map((item) => item.value), ['$exec-plan ']);

  assert.equal(
    await provider.getSuggestions(['Use $PATH'], 0, 'Use $PATH'.length, { signal, force: false }),
    null,
  );
  assert.deepEqual(
    await provider.getSuggestions(['/skill:demo'], 0, '/skill:demo'.length, { signal, force: false }),
    {
      items: [{ value: 'base-value', label: 'base-label', description: 'base-description' }],
      prefix: 'base-prefix',
    },
  );
  assert.equal(provider.shouldTriggerFileCompletion(['Use $exec'], 0, 'Use $exec'.length), true);
  assert.equal(provider.shouldTriggerFileCompletion(['Use $PATH'], 0, 'Use $PATH'.length), false);
});

test('skill autocomplete selections round-trip through the submitted resolver', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-autocomplete-roundtrip-repo.'));
  const userRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-autocomplete-roundtrip-user.'));
  writeSkill(repoRoot, 'exec-plan', 'exec-plan', 'Repo exec plan body');
  writeSkill(repoRoot, 'demo-repo', 'demo', 'Repo demo body');
  const userDemoPath = realpathSync(writeSkill(userRoot, 'demo-user', 'demo', 'User demo body'));
  const roots = rootsJson([repoRoot, 'repo'], [userRoot, 'user']);

  const provider = await createSkillAutocompleteProvider({
    STRONK_PI_SKILL_ROOTS: roots,
  });
  const signal = new AbortController().signal;

  const execSuggestions = await provider.getSuggestions(['Keep using $exec now'], 0, 'Keep using $exec'.length, {
    signal,
    force: false,
  });
  assert.ok(execSuggestions);
  assert.equal(execSuggestions.items.length, 1);
  const execApplied = provider.applyCompletion(
    ['Keep using $exec now'],
    0,
    'Keep using $exec'.length,
    execSuggestions.items[0],
    execSuggestions.prefix,
  );
  assert.match(execApplied.lines[0], /Keep using \$exec-plan/);
  const execInjection = internals.buildSkillInjectionContext(execApplied.lines[0], { cwd: repoRoot, rootsJson: roots });
  assert.equal(execInjection.blocks.length, 1);
  assert.match(execInjection.blocks[0], /Repo exec plan body/);

  const duplicateSuggestions = await provider.getSuggestions(['Keep using $demo now'], 0, 'Keep using $demo'.length, {
    signal,
    force: false,
  });
  assert.ok(duplicateSuggestions);
  assert.equal(duplicateSuggestions.items.length, 2);
  assert.ok(duplicateSuggestions.items.every((item) => item.value.startsWith('[$demo](skill://')));

  const selectedDuplicate = duplicateSuggestions.items.find((item) => item.value.includes(userDemoPath));
  assert.ok(selectedDuplicate);
  const duplicateApplied = provider.applyCompletion(
    ['Keep using $demo now'],
    0,
    'Keep using $demo'.length,
    selectedDuplicate,
    duplicateSuggestions.prefix,
  );
  assert.match(duplicateApplied.lines[0], new RegExp(`\\[\\$demo\\]\\(skill://${userDemoPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
  const duplicateInjection = internals.buildSkillInjectionContext(duplicateApplied.lines[0], { cwd: repoRoot, rootsJson: roots });
  assert.equal(duplicateInjection.blocks.length, 1);
  assert.match(duplicateInjection.blocks[0], /User demo body/);
});

test('skill autocomplete degrades to no results on catalog errors', async () => {
  const provider = await createSkillAutocompleteProvider({ STRONK_PI_SKILL_ROOTS: 'not-json' });
  const signal = new AbortController().signal;
  assert.equal(
    await provider.getSuggestions(['Use $exec'], 0, 'Use $exec'.length, { signal, force: false }),
    null,
  );
});

test('linked skill mentions reject display-name mismatches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-linked-mismatch.'));
  const skillPath = realpathSync(writeSkill(root, 'demo', 'demo', 'Demo body'));
  const notices = [];

  await withEnv(allowingPromptHookEnv({ STRONK_PI_SKILL_ROOTS: rootsJson([root, 'user']) }), async () => {
    const absolute = await internals.handleInput(
      { text: `Use [$wrong](${skillPath})` },
      {
        cwd: root,
        hasUI: true,
        ui: { notify: (message, kind) => notices.push([kind, message]) },
      },
    );
    assert.deepEqual(absolute, { action: 'handled' });
    assert.match(notices.at(-1)[1], /display name mismatch/);

    const skillScheme = await internals.handleInput(
      { text: `Use [$wrong](skill://${skillPath})` },
      {
        cwd: root,
        hasUI: true,
        ui: { notify: (message, kind) => notices.push([kind, message]) },
      },
    );
    assert.deepEqual(skillScheme, { action: 'handled' });
    assert.match(notices.at(-1)[1], /display name mismatch/);
  });
});

test('skill plain mention injects Codex-style context after the original prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-skills.'));
  const skillPath = realpathSync(writeSkill(root, 'demo', 'demo', 'Demo skill instructions'));
  await withEnv(allowingPromptHookEnv({ STRONK_PI_SKILL_ROOTS: rootsJson([root, 'user']) }), async () => {
    const result = await internals.handleInput({ text: 'Use $demo now' }, { cwd: root });
    assert.equal(result.action, 'transform');
    assert.match(result.text, /^Use \$demo now\n\n<skill>/);
    assert.match(result.text, /<name>demo<\/name>/);
    assert.match(result.text, new RegExp(`<path>${skillPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</path>`));
    assert.match(result.text, /Demo skill instructions/);
  });
});

test('skill linked mentions resolve absolute paths and skill scheme paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-linked-skills.'));
  const skillPath = realpathSync(writeSkill(root, 'demo', 'demo', 'Linked demo instructions'));
  await withEnv({ STRONK_PI_SKILL_ROOTS: rootsJson([root, 'repo']) }, async () => {
    const absolute = internals.buildSkillInjectionContext(`Use [$demo](${skillPath})`, { cwd: root });
    assert.equal(absolute.blocks.length, 1);
    assert.match(absolute.blocks[0], /Linked demo instructions/);

    const skillScheme = internals.buildSkillInjectionContext(`Use [$demo](skill://${skillPath})`, { cwd: root });
    assert.equal(skillScheme.blocks.length, 1);
    assert.match(skillScheme.blocks[0], /Linked demo instructions/);
  });
});

test('skill mention parsing skips common env vars and non-skill links', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-env-skills.'));
  writeSkill(root, 'demo', 'demo', 'Demo body');
  await withEnv(allowingPromptHookEnv({ STRONK_PI_SKILL_ROOTS: rootsJson([root, 'user']) }), async () => {
    assert.equal(await internals.handleInput({ text: 'Keep $PATH and $HOME and $XDG_CONFIG_HOME' }, { cwd: root }), undefined);
    assert.equal(await internals.handleInput({ text: '/skill:demo' }, { cwd: root }), undefined);
    assert.equal(await internals.handleInput({ text: 'Use [$demo](app://demo)' }, { cwd: root }), undefined);
    assert.deepEqual([...internals.extractToolMentions('Use $tool:name and $PATH').plainNames], ['tool:name']);
  });
});

test('skill namespaced plain mentions inject by submitted resolver', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-namespaced-skills.'));
  writeSkill(root, 'tool-skill', 'tool:name', 'Namespaced body');

  await withEnv(allowingPromptHookEnv({ STRONK_PI_SKILL_ROOTS: rootsJson([root, 'user']) }), async () => {
    const result = await internals.handleInput({ text: 'Use $tool:name' }, { cwd: root });
    assert.equal(result.action, 'transform');
    assert.match(result.text, /Namespaced body/);
  });
});

test('skill plain mentions skip ambiguous names while linked paths select exact skill', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-repo-skills.'));
  const userRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-user-skills.'));
  writeSkill(repoRoot, 'demo-repo', 'demo', 'Repo demo');
  const userSkillPath = realpathSync(writeSkill(userRoot, 'demo-user', 'demo', 'User demo'));
  await withEnv(allowingPromptHookEnv({ STRONK_PI_SKILL_ROOTS: rootsJson([repoRoot, 'repo'], [userRoot, 'user']) }), async () => {
    assert.equal(await internals.handleInput({ text: 'Use $demo' }, { cwd: repoRoot }), undefined);

    const result = await internals.handleInput({ text: `Use [$demo](${userSkillPath})` }, { cwd: repoRoot });
    assert.equal(result.action, 'transform');
    assert.match(result.text, /User demo/);
    assert.doesNotMatch(result.text, /Repo demo/);
  });
});

test('skill missing linked path skips without plain fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-missing-skill.'));
  writeSkill(root, 'demo', 'demo', 'Demo body');
  const missing = join(root, 'missing', 'SKILL.md');
  await withEnv(allowingPromptHookEnv({ STRONK_PI_SKILL_ROOTS: rootsJson([root, 'user']) }), async () => {
    assert.equal(await internals.handleInput({ text: `Use [$demo](${missing})` }, { cwd: root }), undefined);
  });
});

test('skill linked path outside controlled roots blocks the submitted prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-root-skill.'));
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  writeSkill(root, 'demo', 'demo', 'Demo body');
  const notices = [];
  await withEnv(allowingPromptHookEnv({ STRONK_PI_SKILL_ROOTS: rootsJson([join(root, 'project'), 'repo']) }), async () => {
    const result = await internals.handleInput(
      { text: 'Use [$demo](../demo/SKILL.md)' },
      { cwd, hasUI: true, ui: { notify: (message, kind) => notices.push([kind, message]) } },
    );
    assert.deepEqual(result, { action: 'handled' });
    assert.match(notices[0][1], /outside controlled skill roots/);
  });
});

test('skill linked paths must target SKILL.md and stay realpath-contained', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-skill-linked-path.'));
  const outside = mkdtempSync(join(tmpdir(), 'stronk-pi-skill-linked-outside.'));
  writeSkill(root, 'demo', 'demo', 'Demo body');
  writeSkill(outside, 'escape', 'escape', 'Escape body');
  const notSkillPath = join(root, 'demo', 'README.md');
  writeFileSync(notSkillPath, '# not a skill\n');
  symlinkSync(join(outside, 'escape'), join(root, 'escape-link'), 'dir');
  const symlinkSkillPath = join(root, 'escape-link', 'SKILL.md');

  await withEnv(allowingPromptHookEnv({ STRONK_PI_SKILL_ROOTS: rootsJson([root, 'user']) }), async () => {
    const notSkillNotices = [];
    const notSkill = await internals.handleInput(
      { text: `Use [$demo](${notSkillPath})` },
      { cwd: root, hasUI: true, ui: { notify: (message, kind) => notSkillNotices.push([kind, message]) } },
    );
    assert.deepEqual(notSkill, { action: 'handled' });
    assert.match(notSkillNotices[0][1], /linked skill path must target SKILL\.md/);

    const symlinkNotices = [];
    const symlinkEscape = await internals.handleInput(
      { text: `Use [$escape](${symlinkSkillPath})` },
      { cwd: root, hasUI: true, ui: { notify: (message, kind) => symlinkNotices.push([kind, message]) } },
    );
    assert.deepEqual(symlinkEscape, { action: 'handled' });
    assert.match(symlinkNotices[0][1], /outside controlled skill roots/);
  });
});

test('skill duplicates inject once and multiple skills follow Codex-like inventory order', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-multi-repo-skills.'));
  const userRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-multi-user-skills.'));
  writeSkill(repoRoot, 'beta', 'beta', 'Repo beta body');
  writeSkill(userRoot, 'alpha', 'alpha', 'User alpha body');
  await withEnv(allowingPromptHookEnv({ STRONK_PI_SKILL_ROOTS: rootsJson([repoRoot, 'repo'], [userRoot, 'user']) }), async () => {
    const result = await internals.handleInput({ text: 'Use $alpha then $beta and $alpha again' }, { cwd: repoRoot });
    assert.equal(result.action, 'transform');
    assert.equal(result.text.match(/<name>alpha<\/name>/g).length, 1);
    assert.equal(result.text.match(/<name>beta<\/name>/g).length, 1);
    assert.ok(result.text.indexOf('<name>beta</name>') < result.text.indexOf('<name>alpha</name>'));
  });
});

test('UserPromptSubmit block happens before skill root parsing or SKILL.md reads', async () => {
  const script = tempScript(`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({ decision: 'block', reason: 'blocked before skills' }));
});
`);
  await withEnv({
    STRONK_PI_CODEX_HOOK_COMMAND_JSON: JSON.stringify([script]),
    STRONK_PI_SKILL_ROOTS: 'not-json',
  }, async () => {
    const result = await internals.handleInput({ text: 'Use $demo' }, { cwd: process.cwd() });
    assert.deepEqual(result, { action: 'handled' });
  });
});

test('skill bodies with secret-like content are not injected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-secret-skill.'));
  writeSkill(root, 'demo', 'demo', `Do not leak sk-${'abcdefghijklmnopqrstuvwxyz'}`);
  await withEnv(allowingPromptHookEnv({ STRONK_PI_SKILL_ROOTS: rootsJson([root, 'user']) }), async () => {
    assert.equal(await internals.handleInput({ text: 'Use $demo' }, { cwd: root }), undefined);
  });
});

test('unreadable SKILL.md is not injected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-skill-unreadable.'));
  const skillPath = writeSkill(root, 'demo', 'demo', 'Unreadable body');
  chmodSync(skillPath, 0o000);
  let unreadable = false;
  try {
    readFileSync(skillPath, 'utf8');
  } catch {
    unreadable = true;
  }

  try {
    if (!unreadable) return;
    await withEnv(allowingPromptHookEnv({ STRONK_PI_SKILL_ROOTS: rootsJson([root, 'user']) }), async () => {
      assert.equal(await internals.handleInput({ text: 'Use $demo' }, { cwd: root }), undefined);
    });
  } finally {
    chmodSync(skillPath, 0o600);
  }
});

test('UserPromptSubmit helper failures block before skill root parsing or SKILL.md reads', async () => {
  const cases = [
    {
      name: 'missing helper',
      env: { STRONK_PI_CODEX_HOOK_COMMAND_JSON: JSON.stringify(['/missing/stronk-pi-codex-hook']) },
      pattern: /hook failed:.*ENOENT|hook failed:.*exited|hook failed:/,
    },
    {
      name: 'non-zero exit',
      env: { STRONK_PI_CODEX_HOOK_COMMAND_JSON: JSON.stringify([tempScript(`#!/usr/bin/env node
process.stderr.write('nope');
process.exit(2);
`)]) },
      pattern: /hook failed:.*exited 2/,
    },
    {
      name: 'malformed JSON',
      env: { STRONK_PI_CODEX_HOOK_COMMAND_JSON: JSON.stringify([tempScript(`#!/usr/bin/env node
console.log('not json');
`)]) },
      pattern: /malformed JSON/,
    },
    {
      name: 'non-object JSON',
      env: { STRONK_PI_CODEX_HOOK_COMMAND_JSON: JSON.stringify([tempScript(`#!/usr/bin/env node
console.log(JSON.stringify(['allow']));
`)]) },
      pattern: /non-object JSON/,
    },
    {
      name: 'missing keys',
      env: { STRONK_PI_CODEX_HOOK_COMMAND_JSON: JSON.stringify([tempScript(`#!/usr/bin/env node
console.log(JSON.stringify({ ok: true }));
`)]) },
      pattern: /missing keys/,
    },
    {
      name: 'timeout',
      env: {
        STRONK_PI_CODEX_HOOK_COMMAND_JSON: JSON.stringify([tempScript(`#!/usr/bin/env node
setTimeout(() => {}, 10000);
`)]),
        STRONK_PI_GUARD_TIMEOUT_MS: '30',
      },
      pattern: /timed out/,
    },
  ];

  for (const item of cases) {
    const notices = [];
    await withEnv({ ...item.env, STRONK_PI_SKILL_ROOTS: 'not-json' }, async () => {
      const result = await internals.handleInput(
        { text: `Use $demo for ${item.name}` },
        { cwd: process.cwd(), hasUI: true, ui: { notify: (message, kind) => notices.push([kind, message]) } },
      );
      assert.deepEqual(result, { action: 'handled' }, item.name);
      assert.match(notices[0][1], item.pattern, item.name);
    });
  }
});

test('UserPromptSubmit payload mutation blocks before skill root parsing or SKILL.md reads', async () => {
  const script = tempScript(`#!/usr/bin/env node
process.stdin.resume();
setTimeout(() => console.log(JSON.stringify({ continue: true, decision: "approve" })), 50);
`);
  await withEnv({
    STRONK_PI_CODEX_HOOK_COMMAND_JSON: JSON.stringify([script]),
    STRONK_PI_SKILL_ROOTS: 'not-json',
  }, async () => {
    const notices = [];
    const event = { text: 'harmless prompt' };
    const pending = internals.handleInput(
      event,
      { cwd: process.cwd(), hasUI: true, ui: { notify: (message, kind) => notices.push([kind, message]) } },
    );
    event.text = 'Use $demo';
    const result = await pending;
    assert.deepEqual(result, { action: 'handled' });
    assert.match(notices[0][1], /payload mutated/);
  });
});

test('PermissionRequest helper failures fail closed', async () => {
  const cases = [
    {
      name: 'missing helper',
      env: { STRONK_PI_CODEX_HOOK_COMMAND_JSON: JSON.stringify(['/missing/stronk-pi-codex-hook']) },
      pattern: /PermissionRequest hook failed:/,
    },
    {
      name: 'malformed JSON',
      env: { STRONK_PI_CODEX_HOOK_COMMAND_JSON: JSON.stringify([tempScript(`#!/usr/bin/env node
console.log('not json');
`)]) },
      pattern: /malformed JSON/,
    },
    {
      name: 'missing keys',
      env: { STRONK_PI_CODEX_HOOK_COMMAND_JSON: JSON.stringify([tempScript(`#!/usr/bin/env node
console.log(JSON.stringify({ ok: true }));
`)]) },
      pattern: /missing keys/,
    },
    {
      name: 'timeout',
      env: {
        STRONK_PI_CODEX_HOOK_COMMAND_JSON: JSON.stringify([tempScript(`#!/usr/bin/env node
setTimeout(() => {}, 10000);
`)]),
        STRONK_PI_GUARD_TIMEOUT_MS: '30',
      },
      pattern: /timed out/,
    },
  ];

  for (const item of cases) {
    await withEnv(item.env, async () => {
      const result = await internals.handlePermissionRequest({
        toolName: 'bash',
        input: { command: 'printf ok' },
        cwd: process.cwd(),
      });
      assert.equal(result.block, true, item.name);
      assert.match(result.reason, item.pattern, item.name);
    });
  }
});

test('PermissionRequest requires an explicit authorization decision', async () => {
  const script = tempScript(`#!/usr/bin/env node
console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: 'context only' } }));
`);

  await withEnv({ STRONK_PI_CODEX_HOOK_COMMAND_JSON: JSON.stringify([script]) }, async () => {
    const result = await internals.handlePermissionRequest({
      toolName: 'bash',
      input: { command: 'printf ok' },
      cwd: process.cwd(),
    });
    assert.equal(result.block, true);
    assert.match(result.reason, /missing authorization decision/);
  });
});

test('PermissionRequest rejects unknown authorization decision strings', async () => {
  const cases = [
    { name: 'payload decision', payload: { decision: 'maybe' } },
    { name: 'permission decision', payload: { hookSpecificOutput: { permissionDecision: 'maybe' } } },
    { name: 'behavior decision', payload: { hookSpecificOutput: { decision: { behavior: 'maybe' } } } },
  ];

  for (const item of cases) {
    const script = tempScript(`#!/usr/bin/env node
console.log(JSON.stringify(${JSON.stringify(item.payload)}));
`);
    await withEnv({ STRONK_PI_CODEX_HOOK_COMMAND_JSON: JSON.stringify([script]) }, async () => {
      const result = await internals.handlePermissionRequest({
        toolName: 'bash',
        input: { command: 'printf ok' },
        cwd: process.cwd(),
      });
      assert.equal(result.block, true, item.name);
      assert.match(result.reason, /unknown authorization decision: maybe/, item.name);
    });
  }
});

test('PermissionRequest accepts explicit allow decisions', async () => {
  const cases = [
    { name: 'allow boolean', payload: { allow: true } },
    { name: 'continue boolean', payload: { continue: true } },
    { name: 'payload decision', payload: { decision: 'allow' } },
    { name: 'permission decision', payload: { hookSpecificOutput: { permissionDecision: 'allow' } } },
    { name: 'behavior decision', payload: { hookSpecificOutput: { decision: { behavior: 'allow' } } } },
  ];

  for (const item of cases) {
    const script = tempScript(`#!/usr/bin/env node
console.log(JSON.stringify(${JSON.stringify(item.payload)}));
`);
    await withEnv({ STRONK_PI_CODEX_HOOK_COMMAND_JSON: JSON.stringify([script]) }, async () => {
      const result = await internals.handlePermissionRequest({
        toolName: 'bash',
        input: { command: 'printf ok' },
        cwd: process.cwd(),
      });
      assert.equal(result, undefined, item.name);
    });
  }
});

test('PermissionRequest payload mutation blocks after helper approval', async () => {
  const script = tempScript(`#!/usr/bin/env node
process.stdin.resume();
setTimeout(() => console.log(JSON.stringify({ allow: true })), 50);
`);
  await withEnv({ STRONK_PI_CODEX_HOOK_COMMAND_JSON: JSON.stringify([script]) }, async () => {
    const event = {
      toolName: 'bash',
      input: { command: 'printf ok' },
      cwd: process.cwd(),
    };
    const pending = internals.handlePermissionRequest(event);
    event.input.command = 'sudo whoami';
    const result = await pending;
    assert.equal(result.block, true);
    assert.match(result.reason, /payload mutated/);
  });
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

test('non-zero guard exit surfaces structured denial reason from stdout', async () => {
  const script = tempScript(`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({ allow: false, reason: 'subagent execution is limited to manifest-approved agents: worker' }));
  process.exit(1);
});
`);
  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([script]) }, async () => {
    const result = await internals.handleToolCall({
      toolName: 'subagent',
      input: { agent: 'worker', task: 'edit files' },
      cwd: process.cwd(),
    });
    assert.equal(result.block, true);
    assert.match(result.reason, /manifest-approved agents: worker/);
    assert.doesNotMatch(result.reason, /exited 1:\s*$/);
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

test('managed plugin tools are allowed after helper approval', async () => {
  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([allowScript()]) }, async () => {
    const cases = [
      ['mcp', { search: 'docs' }],
      ['subagent', { action: 'list' }],
      ['web_search', { query: 'Pi Coding Agent docs' }],
      ['stronk_fetch_content', { url: 'https://example.com' }],
      ['get_search_content', { id: 'result-1' }],
      ['ask_user', { question: 'Proceed?' }],
      ['question', { question: 'Proceed?' }],
      ['todowrite', { todos: [{ content: 'Track progress', status: 'pending' }] }],
      ['todoread', {}],
    ];
    for (const [toolName, input] of cases) {
      const result = await internals.handleToolCall({ toolName, input, cwd: process.cwd() });
      assert.equal(result, undefined, `${toolName} should be allowed`);
    }
  });
});

test('upstream fetch_content is denied before helper execution', async () => {
  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([allowScript()]) }, async () => {
    const result = await internals.handleToolCall({
      toolName: 'fetch_content',
      input: { url: 'https://example.com' },
      cwd: process.cwd(),
    });
    assert.equal(result.block, true);
    assert.match(result.reason, /disabled upstream tool/);
  });
});

test('nested managed plugin payload mutation blocks tool_call', async () => {
  const script = tempScript(`#!/usr/bin/env node
process.stdin.resume();
setTimeout(() => console.log(JSON.stringify({ allow: true, reason: 'ok' })), 50);
`);
  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([script]) }, async () => {
    const event = {
      toolName: 'mcp',
      input: {
        tool: 'mock_echo',
        args: {
          command: 'printf safe',
          nested: { server: 'mock' },
        },
      },
      cwd: process.cwd(),
    };
    const pending = internals.handleToolCall(event);
    event.input.args.command = 'sudo whoami';
    event.input.args.nested.server = 'unsafe';
    const result = await pending;
    assert.equal(result.block, true);
    assert.match(result.reason, /mutated/);
  });
});

test('secret-like managed plugin args block before helper execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stronk-pi-secret-block.'));
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
    const result = await internals.handleToolCall({
      toolName: 'mcp',
      input: {
        tool: 'mock_echo',
        args: {
          command: 'printf safe',
          token: fakeSecret,
        },
      },
      cwd: process.cwd(),
    });
    assert.equal(result.block, true);
    assert.match(result.reason, /sensitive content/);
  });
  assert.equal(existsSync(capture), false);
});

test('benign code keyword arguments do not trigger sensitive-content prefilter', async () => {
  const command = 'python3 -c "near = sorted(present, key=lambda x: abs(x - n))[0]"';
  assert.equal(internals.hasSensitiveContent({ command }), false);

  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([allowScript()]) }, async () => {
    const toolCallResult = await internals.handleToolCall({
      toolName: 'bash',
      input: { command },
      cwd: process.cwd(),
    });
    assert.equal(toolCallResult, undefined);

    const userBashResult = await internals.handleUserBash({
      command,
      cwd: process.cwd(),
      excludeFromContext: false,
    });
    assert.equal(userBashResult, undefined);
  });
});

test('exact key assignments still block when the value has a secret shape', async () => {
  const fakeSecret = `sk-${'abcdefghijklmnopqrstuvwxyz'}`;
  assert.equal(internals.hasSensitiveContent({ command: `key=${fakeSecret} some-tool` }), true);
});

test('camelCase sensitive keys and inline assignments block before helper execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stronk-pi-sensitive-block.'));
  const capture = join(dir, 'capture.json');
  const script = tempScript(`#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let input = '';
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(capture)}, input);
  console.log(JSON.stringify({ allow: true, reason: 'ok' }));
});
`);
  const cases = [
    ['mcp', { tool: 'mock_echo', args: { apiKey: 'plain-demo-value' } }],
    ['mcp', { tool: 'mock_echo', args: { secretKey: 'plain-demo-value' } }],
    ['subagent', { action: 'run', input: { accessToken: 'plain-demo-value' } }],
    ['subagent', { action: 'run', input: { privateKey: 'plain-demo-value' } }],
    ['bash', { command: 'OPENAI_API_KEY=plain-demo-value some-tool' }],
    ['write', { path: 'notes.txt', content: 'MY_CLIENT_SECRET=plain-demo-value' }],
    ['write', { path: 'config.json', content: '{"MY_CLIENT_SECRET":"plain-demo-value"}' }],
    ['edit', { path: 'notes.txt', edits: [{ oldText: 'x', newText: 'MY_ACCESS_TOKEN=plain-demo-value' }] }],
    ['edit', { path: 'config.json', edits: [{ oldText: '{}', newText: '{"MY_ACCESS_TOKEN":"plain-demo-value"}' }] }],
  ];
  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([script]) }, async () => {
    for (const [toolName, input] of cases) {
      const result = await internals.handleToolCall({ toolName, input, cwd: process.cwd() });
      assert.equal(result.block, true);
      assert.match(result.reason, /sensitive content/);
    }
  });
  assert.equal(existsSync(capture), false);
});

test('secret-like user_bash command returns a failed synthetic result', async () => {
  const fakeSecret = `sk-${'abcdefghijklmnopqrstuvwxyz'}`;
  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([allowScript()]) }, async () => {
    const result = await internals.handleUserBash({
      command: `printf ${fakeSecret}`,
      cwd: process.cwd(),
      excludeFromContext: false,
    });
    assert.equal(result.result.exitCode, 1);
    assert.match(result.result.output, /sensitive content/);
  });
});

test('inline secret assignment in user_bash returns a failed synthetic result', async () => {
  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([allowScript()]) }, async () => {
    const result = await internals.handleUserBash({
      command: 'OPENAI_API_KEY=plain-demo-value some-tool',
      cwd: process.cwd(),
      excludeFromContext: false,
    });
    assert.equal(result.result.exitCode, 1);
    assert.match(result.result.output, /sensitive content/);
  });
});

test('quoted secret assignment in user_bash returns a failed synthetic result', async () => {
  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([allowScript()]) }, async () => {
    const result = await internals.handleUserBash({
      command: 'printf \'{"OPENAI_API_KEY":"plain-demo-value"}\'',
      cwd: process.cwd(),
      excludeFromContext: false,
    });
    assert.equal(result.result.exitCode, 1);
    assert.match(result.result.output, /sensitive content/);
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

test('redacts telegram secrets before helper stdin', async () => {
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
  await withEnv({ STRONK_PI_TELEGRAM_COMMAND_JSON: JSON.stringify([script]) }, async () => {
    await internals.notify({
      type: 'tool_result',
      event: {
        token: fakeSecret,
        apiKey: 'plain-demo-value',
        privateKey: 'plain-demo-value',
        output: `printf ${fakeSecret}`,
        command: 'MY_CLIENT_SECRET=plain-demo-value some-tool',
        config: '{"MY_ACCESS_TOKEN":"plain-demo-value"}',
      },
    });
  });
  const captured = readFileSync(capture, 'utf8');
  assert.doesNotMatch(captured, new RegExp(fakeSecret));
  assert.doesNotMatch(captured, /plain-demo-value/);
  assert.match(captured, /<redacted>/);
});
