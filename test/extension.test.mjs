import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
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

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

function captureFetch(body, status = 200) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse(body, status);
  };
  fetchFn.calls = calls;
  return fetchFn;
}

function captureFetchSequence(bodies) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const index = calls.length;
    calls.push({ url: String(url), init });
    const entry = bodies[Math.min(index, bodies.length - 1)];
    const body = entry && Object.hasOwn(entry, 'body') ? entry.body : entry;
    const status = entry && Object.hasOwn(entry, 'status') ? entry.status : 200;
    return jsonResponse(body, status);
  };
  fetchFn.calls = calls;
  return fetchFn;
}

function captureFetchResponse(responseFactory) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const index = calls.length;
    calls.push({ url: String(url), init });
    return typeof responseFactory === 'function' ? responseFactory(index, url, init) : responseFactory;
  };
  fetchFn.calls = calls;
  return fetchFn;
}

function eventStreamResponse(chunks, status = 200) {
  const encoder = new TextEncoder();
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => (String(name).toLowerCase() === 'content-type' ? 'text/event-stream;charset=utf-8' : undefined),
    },
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    async text() {
      return chunks.join('');
    },
  };
}

function stalledEventStreamResponse(chunks, status = 200) {
  const encoder = new TextEncoder();
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => (String(name).toLowerCase() === 'content-type' ? 'text/event-stream;charset=utf-8' : undefined),
    },
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      },
    }),
    async text() {
      return chunks.join('');
    },
  };
}

function sseEvent(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sleep(ms, signal) {
  return new Promise((resolveSleep, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolveSleep, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function delayedFetchSequence(entries, active = { current: 0, max: 0 }) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const index = calls.length;
    calls.push({ url: String(url), init });
    const entry = entries[Math.min(index, entries.length - 1)];
    active.current += 1;
    active.max = Math.max(active.max, active.current);
    try {
      if (entry.delayMs) await sleep(entry.delayMs, init.signal);
      const body = Object.hasOwn(entry, 'body') ? entry.body : entry;
      const status = Object.hasOwn(entry, 'status') ? entry.status : 200;
      return jsonResponse(body, status);
    } finally {
      active.current -= 1;
    }
  };
  fetchFn.calls = calls;
  fetchFn.active = active;
  return fetchFn;
}

function captureUpdates() {
  const updates = [];
  const onUpdate = (update) => {
    updates.push(update);
  };
  onUpdate.updates = updates;
  return onUpdate;
}

function updateStates(onUpdate) {
  return onUpdate.updates.map((update) => update.details.state);
}

function renderComponentText(component, width = 120) {
  assert.notEqual(typeof component, 'string');
  assert.equal(typeof component?.render, 'function');
  const lines = component.render(width);
  assert.ok(Array.isArray(lines));
  return lines.join('\n');
}

function isWideTestCodePoint(codePoint) {
  return (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    )
  );
}

const TEST_GRAPHEME_SEGMENTER = typeof Intl?.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;
const TEST_ANSI_ESCAPE_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\)|_[\s\S]*?(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const TEST_FORMAT_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2060-\u206f]/g;

function testVisibleWidth(value) {
  let width = 0;
  const text = String(value ?? '').replace(TEST_ANSI_ESCAPE_PATTERN, '').replace(TEST_FORMAT_CONTROL_PATTERN, '');
  const segments = TEST_GRAPHEME_SEGMENTER
    ? Array.from(TEST_GRAPHEME_SEGMENTER.segment(text), ({ segment }) => segment)
    : Array.from(text);
  for (const segment of segments) {
    if (segment.includes('\u200d') || segment.includes('\ufe0f')) {
      width += 2;
      continue;
    }
    const char = Array.from(segment)[0];
    const codePoint = char?.codePointAt(0);
    if (!codePoint || codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) continue;
    if (
      (codePoint >= 0x0300 && codePoint <= 0x036f) ||
      (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
      (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
      (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
      (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2060 && codePoint <= 0x206f)
    ) continue;
    width += isWideTestCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function assertRenderedLinesFit(component, width) {
  const lines = component.render(width);
  const overflow = lines
    .map((line, index) => ({ index, width: testVisibleWidth(line), line }))
    .filter((line) => line.width > width);
  assert.deepEqual(overflow, []);
}

async function waitUntil(fn, timeoutMs = 1000) {
  const startedAt = Date.now();
  let lastValue;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await sleep(10);
  }
  throw new Error(`timed out waiting for condition; last value: ${JSON.stringify(lastValue)}`);
}

function curatorEndpoint(openedUrl, path) {
  const url = new URL(openedUrl);
  url.pathname = path;
  return url.toString();
}

async function curatorJson(openedUrl, path, body) {
  const init = body === undefined
    ? {}
    : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  const response = await fetch(curatorEndpoint(openedUrl, path), init);
  const payload = await response.json();
  return { response, payload };
}

function requestBody(call) {
  return JSON.parse(call.init.body);
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

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63606060000000040001f61738550000000049454e44ae426082', 'hex');
const PNG_BASE64 = PNG_BYTES.toString('base64');
const TINY_GIF_BASE64 = 'R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==';

function writePng(root, name = 'Screenshot 2026-06-23 at 10.00.00 AM.png') {
  const path = join(root, name);
  writeFileSync(path, PNG_BYTES);
  return path;
}

function makeExternalImageFixture(prefix, extraEnv = {}) {
  const externalRoot = mkdtempSync(join(process.cwd(), `tmp-${prefix}-outside.`));
  const sessionRoot = mkdtempSync(join(tmpdir(), `stronk-pi-${prefix}-session.`));
  const home = join(sessionRoot, 'home');
  const tmp = join(sessionRoot, 'tmp');
  mkdirSync(home);
  mkdirSync(tmp);
  return {
    externalRoot,
    sessionRoot,
    cwd: join(sessionRoot, 'workspace'),
    env: {
      HOME: home,
      TMPDIR: tmp,
      STRONK_PI_STATE_ROOT: join(sessionRoot, '.stronk-pi'),
      ...extraEnv,
    },
    cleanup() {
      rmSync(externalRoot, { recursive: true, force: true });
      rmSync(sessionRoot, { recursive: true, force: true });
    },
  };
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
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['code_search', 'fetch_content', 'glob', 'image_preflight_read', 'image_read', 'question', 'todoread', 'todowrite', 'web_search']);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get('image_preflight_read').label, 'Image Preflight Read');
  assert.match(byName.get('image_preflight_read').description, /prompt-time image vision preflight/);
  assert.equal(byName.get('image_preflight_read').parameters.properties.handle.type, 'string');
  const noSessionPreflightRead = await byName.get('image_preflight_read').execute({
    handle: 'image-preflight-00000000-0000-0000-0000-000000000000',
  });
  assert.equal(noSessionPreflightRead.details.found, false);
  assert.equal(byName.get('image_read').label, 'Image Read');
  assert.match(byName.get('image_read').description, /text-only models/);
  assert.match(byName.get('image_read').description, /exactly one local image/);
  assert.equal(byName.get('image_read').parameters.properties.paths.type, 'array');
  assert.equal(byName.get('image_read').parameters.properties.paths.maxItems, 1);
  assert.equal(byName.get('image_read').parameters.properties.directory.type, 'string');
  assert.equal(Object.hasOwn(byName.get('image_read').parameters.properties, 'max_images'), false);
  assert.match(byName.get('image_read').promptGuidelines.join('\n'), /once per image/);
  assert.deepEqual(byName.get('web_search').parameters.properties.workflow.enum, ['auto', 'summary-review', 'none']);
  assert.deepEqual(byName.get('code_search').parameters.properties.workflow.enum, ['auto', 'summary-review', 'none']);
  assert.deepEqual(byName.get('web_search').parameters.properties.curatorAction.enum, ['keep', 'dismiss', 'fetch', 'fetch-kept', 'follow-up', 'finish', 'status']);
  assert.equal(byName.get('web_search').parameters.properties.resultRanks.type, 'array');
  assert.equal(byName.get('web_search').parameters.properties.resultIds.type, 'array');
  assert.equal(byName.get('web_search').parameters.properties.searchResultUrls.type, 'array');
  assert.match(byName.get('web_search').parameters.properties.workflow.description, /Use summary-review for research-quality answers/);
  assert.match(byName.get('web_search').parameters.properties.queries.description, /prefer 5-10 non-overlapping queries/);
  assert.match(byName.get('web_search').promptGuidelines.join('\n'), /operator-facing research.*workflow=summary-review.*5-10 varied queries/s);
  assert.match(byName.get('web_search').promptGuidelines.join('\n'), /Use workflow=none only for quick single-query lookups/);
  assert.match(byName.get('code_search').promptGuidelines.join('\n'), /For code research.*workflow=summary-review/s);
  assert.equal(typeof byName.get('web_search').renderCall, 'function');
  assert.equal(typeof byName.get('web_search').renderResult, 'function');
  assert.equal(typeof byName.get('fetch_content').renderCall, 'function');
  assert.equal(typeof byName.get('fetch_content').renderResult, 'function');
  assert.match(renderComponentText(byName.get('web_search').renderCall({ queries: ['alpha docs', 'beta docs'], workflow: 'summary-review' })), /queries=2/);
  assert.match(renderComponentText(byName.get('web_search').renderResult({
    details: {
      provider: 'exa',
      workflow: 'summary-review',
      count: 1,
      review: { reviewId: 'search-review-1', resultCount: 1, keptCount: 0, dismissedCount: 0, availableResultCount: 1 },
      results: [{ rank: 1, title: 'Result', url: 'https://example.com/result', sourceKind: 'web', sourceReliability: 'unknown' }],
    },
  })), /search-review-1/);
  assert.doesNotMatch(renderComponentText(byName.get('web_search').renderResult({
    details: {
      provider: 'exa',
      workflow: 'summary-review',
      count: 1,
      results: [{ rank: 1, title: 'RAW_TITLE_SENTINEL', url: 'https://raw.example/result?leak=RAW_URL_SENTINEL', snippet: 'RAW_SNIPPET_SENTINEL' }],
    },
  })), /RAW_TITLE_SENTINEL|RAW_URL_SENTINEL|RAW_SNIPPET_SENTINEL/);
  assert.match(renderComponentText(byName.get('code_search').renderCall({ query: 'agent code', workflow: 'auto' })), /code_search workflow=auto/);
  assert.match(renderComponentText(byName.get('code_search').renderResult({
    details: { provider: 'exa', workflow: 'none', count: 0, results: [] },
  })), /code_search completed/);
  assert.match(renderComponentText(byName.get('fetch_content').renderCall({
    urls: ['https://example.com/one?token=FETCH_SECRET_SENTINEL', 'https://example.com/two'],
  })), /fetch_content urls=2/);
  const fetchRenderText = renderComponentText(byName.get('fetch_content').renderResult({
    content: [{ type: 'text', text: 'RAW_FETCH_BODY_SENTINEL' }],
    details: {
      urls: ['https://example.com/one?token=FETCH_SECRET_SENTINEL'],
      finalUrl: 'https://example.com/one?token=FETCH_SECRET_SENTINEL',
      title: 'Fetched Page',
      statusCode: 200,
      successful: 1,
    },
  }));
  assert.match(fetchRenderText, /fetch_content completed successful=1\/1/);
  assert.match(fetchRenderText, /Fetched Page/);
  assert.doesNotMatch(fetchRenderText, /RAW_FETCH_BODY_SENTINEL|FETCH_SECRET_SENTINEL/);
});

test('search renderers return Pi TUI components instead of plain strings', async () => {
  const tools = [];
  await stronkPi({
    on: () => {},
    registerTool: (tool) => tools.push(tool),
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  for (const toolName of ['web_search', 'code_search']) {
    const tool = byName.get(toolName);
    const callComponent = tool.renderCall(
      { queries: ['alpha docs', 'beta docs'], workflow: 'summary-review' },
      {},
      {},
    );
    const resultComponent = tool.renderResult(
      { details: { provider: 'exa', workflow: 'summary-review', count: 1, results: [{ rank: 1, title: 'Alpha', url: 'https://example.com/alpha' }] } },
      {},
      {},
      {},
    );
    const actionComponent = tool.renderResult(
      { details: { action: 'status', review: { reviewId: 'search-review-1', provider: 'exa', workflow: 'summary-review', resultCount: 7, keptCount: 1, dismissedCount: 0, availableResultCount: 6 } } },
      {},
      {},
      {},
    );
    assert.notEqual(typeof callComponent, 'string');
    assert.notEqual(typeof resultComponent, 'string');
    assert.notEqual(typeof actionComponent, 'string');
    assert.doesNotThrow(() => callComponent.render(60));
    assert.doesNotThrow(() => resultComponent.render(60));
    assert.doesNotThrow(() => actionComponent.render(60));
    assert.match(renderComponentText(callComponent), new RegExp(`${toolName} workflow=summary-review`));
    assert.match(renderComponentText(resultComponent), new RegExp(`${toolName} completed`));
    assert.doesNotMatch(renderComponentText(resultComponent), /Alpha|https:\/\/example\.com\/alpha/);
    assert.match(renderComponentText(actionComponent), new RegExp(`${toolName} completed provider=exa workflow=summary-review results=7`));
  }
});

test('search renderers keep every line inside terminal visible width', async () => {
  const tools = [];
  await stronkPi({
    on: () => {},
    registerTool: (tool) => tools.push(tool),
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const cjkTitle = '【瀚铠（VASTARMOR）R9700】瀚铠（VASTARMOR）AMD RADEON AI PRO R9700 AI工作站专业显卡 32GB AI开发 高性能工作站 支持多GPU扩展【行情 报价 价格 评测】-京东';
  const longUrl = `https://example.com/${'amd-radeon-ai-pro-r9700-'.repeat(12)}?token=${'secret-looking-value-'.repeat(8)}#${'fragment-'.repeat(8)}`;
  const cjkQuery = 'AMD Radeon AI PRO R9700 price China JD.com Taobao 2026 CNY 京东 瀚铠 讯景';
  const emojiTitle = `${'⚠️'.repeat(40)} ${'❤️'.repeat(40)} terminal width check`;
  const spoofedPreview = 'summary-review\nspoofed=true\u202E';
  const widths = [20, 40, 60, 120, 147];

  for (const toolName of ['web_search', 'code_search']) {
    const tool = byName.get(toolName);
    const components = [
      tool.renderCall({ queries: [cjkQuery, longUrl, emojiTitle], workflow: spoofedPreview }, {}, {}),
      tool.renderResult({
        details: {
          provider: 'exa',
          workflow: spoofedPreview,
          count: 2,
          queryStates: [{ id: 'q1', status: 'complete', query: `${cjkQuery} ${emojiTitle}`, resultCount: 2 }],
          results: [
            {
              rank: 1,
              title: cjkTitle,
              url: 'https://item.jd.com/100318052056.html',
              qualitySignals: ['same-host-2'],
            },
            {
              rank: 2,
              title: emojiTitle,
              url: longUrl,
              sourceKind: 'web',
              sourceReliability: 'unknown',
              qualitySignals: ['verify-quantitative-claims'],
            },
          ],
      },
    }, {}, {}, {}),
    ];
    for (const component of components) {
      for (const width of widths) assertRenderedLinesFit(component, width);
      assert.doesNotMatch(renderComponentText(component), /\u202E|\nspoofed=/);
    }
  }

  const fetchContent = byName.get('fetch_content');
  const fetchComponents = [
    fetchContent.renderCall({ urls: [longUrl, 'https://example.com/second'] }, {}, {}),
    fetchContent.renderResult({
      content: [{ type: 'text', text: `${cjkTitle}\n${longUrl}\nRAW_FETCH_BODY_SENTINEL` }],
      details: {
        urls: [longUrl],
        finalUrl: longUrl,
        title: cjkTitle,
        statusCode: 200,
        successful: 1,
      },
    }, {}, {}, {}),
    fetchContent.renderResult({
      content: [{ type: 'text', text: 'RAW_FETCH_BODY_SENTINEL' }],
      details: {
        urls: [longUrl, 'https://example.com/second'],
        successful: 1,
        total: 2,
        results: [
          { finalUrl: longUrl, title: emojiTitle, statusCode: 200 },
          { url: 'https://example.com/second', error: `${emojiTitle} ${cjkTitle}` },
        ],
      },
    }, {}, {}, {}),
  ];
  for (const component of fetchComponents) {
    for (const width of widths) assertRenderedLinesFit(component, width);
    const rendered = renderComponentText(component);
    assert.doesNotMatch(rendered, /RAW_FETCH_BODY_SENTINEL|secret-looking-value|\u202E|\nspoofed=/);
  }

  const webSearch = byName.get('web_search');
  for (const width of widths) {
    assertRenderedLinesFit(webSearch.renderCall({
      curatorAction: 'fetch',
      reviewId: 'search-review-1\nspoofed=true\u202E',
      searchResultUrl: longUrl,
    }, {}, {}), width);
    assertRenderedLinesFit(webSearch.renderResult({
      details: {
        action: 'status',
        review: {
          reviewId: 'search-review-1',
          provider: 'exa',
          workflow: 'summary-review',
          resultCount: 2,
          keptCount: 1,
          dismissedCount: 0,
          availableResultCount: 1,
          keptResults: [{ rank: 1, resultId: 'result-1', title: cjkTitle, url: longUrl }],
        },
      },
    }, {}, {}, {}), width);
  }
});

test('registered web_search stays in CLI and does not launch browser curator by default', async () => {
  const tools = [];
  await stronkPi({
    on: () => {},
    registerTool: (tool) => tools.push(tool),
  });
  const webSearch = tools.find((tool) => tool.name === 'web_search');
  const callPreview = webSearch.renderCall({
    curatorAction: 'fetch',
    reviewId: 'search-review-1',
    searchResultUrl: 'https://example.com/page?token=plain-demo-value',
  });
  const callPreviewText = renderComponentText(callPreview);
  assert.match(callPreviewText, /searchResultUrl=https:\/\/example\.com\/page\?<redacted>/);
  assert.doesNotMatch(callPreviewText, /plain-demo-value/);
  const oldFetch = globalThis.fetch;
  const onUpdate = captureUpdates();
  globalThis.fetch = captureFetch({
    results: [{ title: 'CLI Result', url: 'https://example.com/cli', highlights: ['CLI snippet.'] }],
  });
  try {
    await withEnv({ STRONK_PI_SEARCH_PROVIDER: 'exa', EXA_API_KEY: 'exa-cli-key' }, async () => {
      const result = await webSearch.execute(
        'tool-call-1',
        { query: 'agent docs', workflow: 'summary-review', count: 1 },
        undefined,
        onUpdate,
        { hasUI: true },
      );
      assert.equal(result.details.workflow, 'summary-review');
      assert.equal(result.details.reviewId, 'search-review-1');
      assert.equal(result.details.browserCurator, undefined);
      assert.match(onUpdate.updates[0].content[0].text, /provider=exa workflow=summary-review/);
      assert.match(onUpdate.updates[0].content[0].text, /query state:/);
      assert.match(result.content[0].text, /Review state:/);
      assert.match(result.content[0].text, /resultRank=<rank>/);
      assert.equal(result.details.results[0].title, 'CLI Result');
      assert.equal(result.details.results[0].url, 'https://example.com/cli');
      assert.equal(result.details.results[0].snippet, 'CLI snippet.');
      for (const update of onUpdate.updates) {
        assert.doesNotMatch(update.content[0].text, /CLI Result|https:\/\/example\.com\/cli|CLI snippet/);
      }
      assert.match(result.content[0].text, /Result records for model:/);
      assert.match(result.content[0].text, /CLI Result/);
      assert.match(result.content[0].text, /searchResultUrl: https:\/\/example\.com\/cli/);
      assert.match(result.content[0].text, /CLI snippet/);
      const rendered = renderComponentText(webSearch.renderResult(result, {}, {}, {}));
      assert.doesNotMatch(rendered, /CLI Result|https:\/\/example\.com\/cli|CLI snippet/);
    });
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('web_search routes to Exa with normalized results and no key output', async () => {
  const fetchFn = captureFetch({
    requestId: 'exa-request-1',
    results: [{
      title: 'Exa \x1b[31mResult\u202E',
      url: 'https://example.com/exa',
      summary: 'Less specific Exa summary.',
      text: 'Long Exa page text that should not win over highlights.',
      highlights: ['Relevant \x1b]8;;https://example.com\x07Exa snippet.\u202E'],
      publishedDate: '2026-06-01T00:00:00.000Z',
    }],
  });
  const env = {
    STRONK_PI_SEARCH_PROVIDER: 'exa',
    EXA_API_KEY: 'exa-test-key',
  };

  const result = await internals.executeWebSearch({ query: 'agent docs', count: 3 }, undefined, undefined, { env, fetch: fetchFn });

  assert.equal(fetchFn.calls.length, 1);
  assert.equal(fetchFn.calls[0].url, 'https://api.exa.ai/search');
  assert.equal(fetchFn.calls[0].init.headers['x-api-key'], 'exa-test-key');
  assert.deepEqual(requestBody(fetchFn.calls[0]), {
    query: 'agent docs',
    type: 'auto',
    numResults: 3,
    contents: { highlights: true },
  });
  assert.equal(result.details.provider, 'exa');
  assert.equal(result.details.requestId, 'exa-request-1');
  assert.deepEqual(result.details.queries, ['agent docs']);
  assert.equal(result.details.contentFetchTool, 'fetch_content');
  assert.deepEqual(result.details.results[0], {
    title: 'Exa Result',
    url: 'https://example.com/exa',
    snippet: 'Relevant Exa snippet.',
    provider: 'exa',
    rank: 1,
    publishedDate: '2026-06-01T00:00:00.000Z',
  });
  assert.doesNotMatch(result.content[0].text, /exa-test-key/);
  assert.doesNotMatch(JSON.stringify(result), /\x1b|\u202E/);
});

test('web_search routes to Brave with query and count parameters', async () => {
  const fetchFn = captureFetch({
    web: {
      results: [{
        title: 'Brave Result',
        url: 'https://example.com/brave',
        description: 'Brave snippet.',
        age: '2026-06-02T00:00:00.000Z',
      }],
    },
  });
  const env = {
    STRONK_PI_SEARCH_PROVIDER: 'brave',
    BRAVE_SEARCH_API_KEY: 'brave-test-key',
  };

  const result = await internals.executeWebSearch({ query: 'agent docs', count: 2 }, undefined, undefined, { env, fetch: fetchFn });
  const calledUrl = new URL(fetchFn.calls[0].url);

  assert.equal(calledUrl.origin + calledUrl.pathname, 'https://api.search.brave.com/res/v1/web/search');
  assert.equal(calledUrl.searchParams.get('q'), 'agent docs');
  assert.equal(calledUrl.searchParams.get('count'), '2');
  assert.equal(fetchFn.calls[0].init.headers['X-Subscription-Token'], 'brave-test-key');
  assert.equal(result.details.provider, 'brave');
  assert.equal(result.details.results[0].snippet, 'Brave snippet.');
});

test('web_search supports bounded multi-query searches with deduped normalized results', async () => {
  const fetchFn = captureFetchSequence([
    {
      web: {
        results: [
          { title: '<b>Shared</b>', link: 'https://example.com/shared', description: '<p>First snippet.</p>' },
          { title: 'Single Label', link: 'https://internalhost', description: 'blocked' },
        ],
      },
    },
    {
      web: {
        results: [
          { title: 'Shared Duplicate', link: 'https://example.com/shared', description: 'duplicate' },
          { title: 'Second', href: 'https://example.com/second', description: 'Second snippet.' },
        ],
      },
    },
  ]);
  const env = {
    STRONK_PI_SEARCH_PROVIDER: 'brave',
    BRAVE_SEARCH_API_KEY: 'brave-test-key',
  };

  const result = await internals.executeWebSearch({ queries: ['alpha docs', 'beta docs'], count: 99 }, undefined, undefined, { env, fetch: fetchFn });

  assert.equal(fetchFn.calls.length, 2);
  assert.equal(new URL(fetchFn.calls[0].url).searchParams.get('count'), '10');
  assert.equal(new URL(fetchFn.calls[0].url).searchParams.get('q'), 'alpha docs');
  assert.equal(new URL(fetchFn.calls[1].url).searchParams.get('q'), 'beta docs');
  assert.deepEqual(result.details.queries, ['alpha docs', 'beta docs']);
  assert.equal(result.details.count, 2);
  assert.deepEqual(result.details.results.map((item) => item.rank), [1, 2]);
  assert.equal(result.details.results[0].title, 'Shared');
  assert.equal(result.details.results[0].snippet, 'First snippet.');
  assert.equal(result.details.results[0].query, 'alpha docs');
  assert.equal(result.details.results[1].url, 'https://example.com/second');
  assert.equal(result.details.results[1].query, 'beta docs');
  assert.match(result.content[0].text, /Queries: 2/);
});

test('web_search surfaces duplicate and source-quality signals in CLI output', async () => {
  const fetchFn = captureFetch({
    web: {
      results: [
        { title: 'Playwright Test Docs', url: 'https://playwright.dev/docs/test-configuration', description: 'Official Playwright docs.' },
        { title: 'Playwright vs Cypress 2026 comparison', url: 'https://example.com/playwright-vs-cypress', description: 'Benchmark says 2x faster.' },
        { title: 'Playwright versus Cypress comparison', url: 'https://another.example/compare', description: 'Another comparison guide.' },
      ],
    },
  });

  const result = await internals.executeWebSearch(
    { query: 'Playwright vs Cypress React E2E 2026', count: 3 },
    undefined,
    undefined,
    {
      env: { STRONK_PI_SEARCH_PROVIDER: 'brave', BRAVE_SEARCH_API_KEY: 'brave-test-key' },
      fetch: fetchFn,
    },
  );

  assert.equal(result.details.results[0].sourceKind, 'official-docs');
  assert.equal(result.details.results[0].sourceReliability, 'primary');
  assert.equal(result.details.results[1].sourceReliability, 'secondary');
  assert.ok(result.details.results[1].qualitySignals.includes('verify-quantitative-claims'));
  assert.equal(result.details.results[2].duplicateOfRank, 2);
  assert.match(result.content[0].text, /Source summary: primary:1, secondary:2/);
  assert.match(result.content[0].text, /Possible duplicates: 1/);
  assert.match(result.content[0].text, /Result records for model:/);
  assert.match(result.content[0].text, /Playwright Test Docs/);
  assert.match(result.content[0].text, /searchResultUrl: https:\/\/playwright\.dev\/docs\/test-configuration/);
  assert.match(result.content[0].text, /Official Playwright docs/);
});

test('web_search marks fetch-risk sources and conservatively improves result diversity', async () => {
  const fetchFn = captureFetch({
    web: {
      results: [
        { title: 'Medium Playwright vs Cypress', url: 'https://medium.com/@author/playwright-cypress-2026', description: 'Paywalled benchmark claims 2x faster.' },
        { title: 'Cypress Migration Docs', url: 'https://docs.cypress.io/app/guides/migration/playwright-to-cypress', description: 'Official Cypress migration documentation.' },
        { title: 'QASkills React E2E guide', url: 'https://qaskills.sh/blog/playwright-cypress-react-e2e', description: 'React E2E comparison guide.' },
        { title: 'QASkills React E2E guide updated', url: 'https://qaskills.sh/blog/playwright-cypress-react-e2e-updated', description: 'React E2E comparison guide update.' },
      ],
    },
  });

  const result = await internals.executeWebSearch(
    { query: 'official Playwright vs Cypress docs 2026', count: 4 },
    undefined,
    undefined,
    {
      env: { STRONK_PI_SEARCH_PROVIDER: 'brave', BRAVE_SEARCH_API_KEY: 'brave-test-key' },
      fetch: fetchFn,
    },
  );

  assert.equal(result.details.results[0].url, 'https://docs.cypress.io/app/guides/migration/playwright-to-cypress');
  assert.equal(result.details.results[0].sourceReliability, 'primary');
  const medium = result.details.results.find((item) => item.url.includes('medium.com'));
  assert.equal(medium.sourceAccessibility, 'restricted');
  assert.ok(medium.qualitySignals.includes('fetch-risk'));
  assert.ok(medium.rank > result.details.results[0].rank);
  const qaskills = result.details.results.filter((item) => item.url.includes('qaskills.sh'));
  assert.equal(qaskills.length, 2);
  assert.ok(qaskills.every((item) => item.qualitySignals.includes('same-host-2')));
  assert.match(result.content[0].text, /sourceAccessibility: restricted/);
  assert.match(result.content[0].text, /fetch risk/);
});

test('web_search accepts up to fifteen queries and rejects larger batches', async () => {
  const queries = Array.from({ length: 15 }, (_, index) => `query ${index + 1}`);
  const fetchFn = captureFetchSequence(queries.map((query, index) => ({
    web: {
      results: [
        {
          title: `Result ${index + 1}`,
          url: `https://example.com/result-${index + 1}`,
          description: `Snippet for ${query}.`,
        },
      ],
    },
  })));
  const env = {
    STRONK_PI_SEARCH_PROVIDER: 'brave',
    BRAVE_SEARCH_API_KEY: 'brave-test-key',
  };

  const result = await internals.executeWebSearch({ queries, count: 1 }, undefined, undefined, { env, fetch: fetchFn });

  assert.equal(fetchFn.calls.length, 15);
  assert.deepEqual(result.details.queries, queries);
  assert.equal(result.details.results.length, 15);
  assert.equal(result.details.results.at(-1).query, 'query 15');
  assert.match(result.content[0].text, /Queries: 15/);

  await assert.rejects(
    () => internals.executeWebSearch(
      { queries: [...queries, 'query 16'], count: 1 },
      undefined,
      undefined,
      { env, fetch: captureFetch({}) },
    ),
    /web_search supports at most 15 queries/,
  );
});

test('web_search workflow auto falls back without UI and workflow none stays result-only', async () => {
  const env = { STRONK_PI_SEARCH_PROVIDER: 'brave', BRAVE_SEARCH_API_KEY: 'brave-test-key' };
  const fetchFn = captureFetch({
    web: { results: [{ title: 'Docs', url: 'https://example.com/docs', description: 'Snippet.' }] },
  });
  const noUiUpdate = captureUpdates();

  const autoNoUi = await internals.executeWebSearch(
    { query: 'agent docs' },
    undefined,
    noUiUpdate,
    { env, fetch: fetchFn, ctx: { hasUI: false } },
  );

  assert.equal(autoNoUi.details.requestedWorkflow, 'auto');
  assert.equal(autoNoUi.details.workflow, 'none');
  assert.equal(autoNoUi.details.workflowFallback, 'auto-without-ui');
  assert.deepEqual(noUiUpdate.updates, []);

  const noneUpdate = captureUpdates();
  const noneResult = await internals.executeWebSearch(
    { query: 'agent docs', workflow: 'none' },
    undefined,
    noneUpdate,
    { env, fetch: captureFetch({ web: { results: [] } }), ctx: { hasUI: true } },
  );
  assert.equal(noneResult.details.workflow, 'none');
  assert.equal(noneResult.details.count, 0);
  assert.deepEqual(noneUpdate.updates, []);
});

test('web_search workflow auto uses summary-review with UI and emits redacted live updates', async () => {
  const onUpdate = captureUpdates();
  const reviewState = {};
  const env = { STRONK_PI_SEARCH_PROVIDER: 'exa', EXA_API_KEY: 'exa-test-key' };
  const result = await internals.executeWebSearch(
    { query: 'agent docs', workflow: 'auto', count: 1 },
    undefined,
    onUpdate,
    {
      env,
      fetch: captureFetch({
        results: [{
          title: 'Exa Result',
          url: 'https://example.com/exa',
          highlights: [`token=sk-${'a'.repeat(24)} public snippet.`],
        }],
      }),
      ctx: { hasUI: true },
      reviewState,
    },
  );

  assert.equal(result.details.workflow, 'summary-review');
  assert.equal(result.details.uiAvailable, true);
  assert.equal(result.details.review.reviewId, 'search-review-1');
  assert.equal(result.details.reviewId, 'search-review-1');
  assert.match(result.content[0].text, /Review ID: search-review-1/);
  assert.match(result.content[0].text, /Curator actions: keep, dismiss, fetch, fetch-kept, follow-up, finish, status/);
  assert.match(result.content[0].text, /resultRank=<rank>/);
  assert.match(result.content[0].text, /selectors: resultRank 1 \/ resultId result-1/);
  assert.match(result.content[0].text, /fetch-kept: curatorAction=fetch-kept/);
  assert.match(result.content[0].text, /Result records for model:/);
  assert.match(result.content[0].text, /Exa Result/);
  assert.match(result.content[0].text, /searchResultUrl: https:\/\/example\.com\/exa/);
  assert.match(result.content[0].text, /token=<redacted> public snippet/);
  assert.deepEqual(updateStates(onUpdate), ['start', 'progress', 'result', 'progress', 'completed']);
  assert.equal(onUpdate.updates[0].details.provider, 'exa');
  assert.equal(onUpdate.updates[0].details.queryCount, 1);
  assert.equal(onUpdate.updates[0].details.concurrency, 1);
  assert.match(onUpdate.updates[0].content[0].text, /query state:/);
  assert.deepEqual(onUpdate.updates.map((update) => update.details.query?.status).filter(Boolean), ['running', 'results', 'complete']);
  assert.match(result.details.results[0].snippet, /token=<redacted>/);
  for (const update of onUpdate.updates) {
    assert.doesNotMatch(update.content[0].text, /Exa Result|https:\/\/example\.com\/exa|public snippet/);
  }
  assert.doesNotMatch(JSON.stringify(onUpdate.updates), /exa-test-key/);
  assert.doesNotMatch(JSON.stringify(onUpdate.updates), /sk-[A-Za-z0-9]/);
});

test('web_search bounded parallelism caps active provider calls and keeps deterministic final ordering', async () => {
  const queries = ['first', 'second', 'third', 'fourth', 'fifth'];
  const active = { current: 0, max: 0 };
  const fetchFn = delayedFetchSequence([
    { delayMs: 35, body: { web: { results: [{ title: 'First', url: 'https://example.com/a', description: 'first' }] } } },
    { delayMs: 5, body: { web: { results: [{ title: 'Second duplicate', url: 'https://example.com/a', description: 'duplicate' }] } } },
    { delayMs: 15, body: { web: { results: [{ title: 'Third', url: 'https://example.com/c', description: 'third' }] } } },
    { delayMs: 1, body: { web: { results: [{ title: 'Fourth', url: 'https://example.com/d', description: 'fourth' }] } } },
    { delayMs: 2, body: { web: { results: [{ title: 'Fifth', url: 'https://example.com/e', description: 'fifth' }] } } },
  ], active);
  const onUpdate = captureUpdates();

  const result = await internals.executeWebSearch(
    { queries, count: 1, workflow: 'summary-review' },
    undefined,
    onUpdate,
    {
      env: { STRONK_PI_SEARCH_PROVIDER: 'brave', BRAVE_SEARCH_API_KEY: 'brave-test-key' },
      fetch: fetchFn,
      ctx: { hasUI: true },
      reviewState: {},
    },
  );

  assert.equal(active.max, 3);
  assert.equal(result.details.concurrency, 3);
  assert.deepEqual(result.details.results.map((item) => item.url), [
    'https://example.com/a',
    'https://example.com/c',
    'https://example.com/d',
    'https://example.com/e',
  ]);
  assert.deepEqual(result.details.results.map((item) => item.rank), [1, 2, 3, 4]);
  assert.deepEqual(result.details.results.map((item) => item.query), ['first', 'third', 'fourth', 'fifth']);
  assert.equal(updateStates(onUpdate).filter((state) => state === 'result').length, 5);
});

test('web_search preserves completed results on abort, cancels queued work, and suppresses late updates', async () => {
  const controller = new AbortController();
  let updatesAtAbort = 0;
  const onUpdate = captureUpdates();
  controller.signal.addEventListener('abort', () => {
    updatesAtAbort = onUpdate.updates.length;
  }, { once: true });
  const fetchFn = delayedFetchSequence([
    { delayMs: 5, body: { web: { results: [{ title: 'Done', url: 'https://example.com/done', description: 'done' }] } } },
    { delayMs: 80, body: { web: { results: [{ title: 'Late 1', url: 'https://example.com/late-1', description: 'late' }] } } },
    { delayMs: 80, body: { web: { results: [{ title: 'Late 2', url: 'https://example.com/late-2', description: 'late' }] } } },
    { delayMs: 80, body: { web: { results: [{ title: 'Queued', url: 'https://example.com/queued', description: 'queued' }] } } },
  ]);

  const promise = internals.executeWebSearch(
    { queries: ['done', 'late one', 'late two', 'queued'], count: 1, workflow: 'summary-review' },
    controller.signal,
    onUpdate,
    {
      env: { STRONK_PI_SEARCH_PROVIDER: 'brave', BRAVE_SEARCH_API_KEY: 'brave-test-key' },
      fetch: fetchFn,
      ctx: { hasUI: true },
      reviewState: {},
    },
  );
  await sleep(20);
  controller.abort(new Error('operator cancelled'));
  const result = await promise;

  assert.equal(result.details.cancelled, true);
  assert.deepEqual(result.details.results.map((item) => item.url), ['https://example.com/done']);
  assert.ok(result.details.cancelledQueryIds.includes('q2'));
  assert.ok(result.details.cancelledQueryIds.includes('q3'));
  assert.ok(result.details.cancelledQueryIds.includes('q4'));
  assert.equal(onUpdate.updates.length, updatesAtAbort);
});

test('web_search returns timeout and partial failure details without discarding successful results', async () => {
  const fetchFn = delayedFetchSequence([
    { delayMs: 1, body: { web: { results: [{ title: 'Fast', url: 'https://example.com/fast', description: 'fast' }] } } },
    { delayMs: 30, body: { web: { results: [{ title: 'Slow', url: 'https://example.com/slow', description: 'slow' }] } } },
  ]);
  const onUpdate = captureUpdates();

  const result = await internals.executeWebSearch(
    { queries: ['fast', 'slow'], count: 1, workflow: 'summary-review' },
    undefined,
    onUpdate,
    {
      env: { STRONK_PI_SEARCH_PROVIDER: 'brave', BRAVE_SEARCH_API_KEY: 'brave-test-key' },
      fetch: fetchFn,
      ctx: { hasUI: true },
      timeoutMs: 5,
      reviewState: {},
    },
  );

  assert.deepEqual(result.details.results.map((item) => item.url), ['https://example.com/fast']);
  assert.equal(result.details.errors.length, 1);
  assert.match(result.details.errors[0].message, /timed out/);
  assert.deepEqual(result.details.queryStates.map((item) => item.status), ['complete', 'failed']);
  assert.ok(updateStates(onUpdate).includes('error'));
  const updateCount = onUpdate.updates.length;
  await sleep(40);
  assert.equal(onUpdate.updates.length, updateCount);
  assert.equal(fetchFn.active.current, 0);
  assert.doesNotMatch(JSON.stringify(result), /https:\/\/example\.com\/slow/);

  const partialFailure = await internals.executeWebSearch(
    { queries: ['broken', 'works'], count: 1 },
    undefined,
    undefined,
    {
      env: { STRONK_PI_SEARCH_PROVIDER: 'brave', BRAVE_SEARCH_API_KEY: 'brave-test-key' },
      fetch: captureFetchSequence([
        { body: 'invalid brave-test-key', status: 500 },
        { body: { web: { results: [{ title: 'Works', url: 'https://example.com/works', description: 'ok' }] } } },
      ]),
    },
  );
  assert.deepEqual(partialFailure.details.results.map((item) => item.url), ['https://example.com/works']);
  assert.match(partialFailure.details.errors[0].message, /<redacted>/);
  assert.doesNotMatch(JSON.stringify(partialFailure), /brave-test-key/);
});

test('web_search curator actions keep dismiss fetch follow-up and finish through guarded fetch_content', async () => {
  const reviewState = {};
  const initialFetch = captureFetch({
    web: {
      results: [
        { title: 'One', url: 'https://example.com/one', description: 'one' },
        { title: 'Two', url: 'https://example.com/two', description: 'two' },
      ],
    },
  });
  const env = { STRONK_PI_SEARCH_PROVIDER: 'brave', BRAVE_SEARCH_API_KEY: 'brave-test-key' };

  const initial = await internals.executeWebSearch(
    { query: 'agent docs', workflow: 'summary-review', count: 2 },
    undefined,
    captureUpdates(),
    { env, fetch: initialFetch, ctx: { hasUI: true }, reviewState },
  );
  const reviewId = initial.details.review.reviewId;
  assert.equal(initial.details.review.keptResults.length, 0);
  assert.equal(initial.details.review.availableResults.length, 2);
  assert.equal(initial.details.results[0].resultId, undefined);
  assert.match(initial.content[0].text, /selectors: resultRank 1-2 \/ resultId result-<rank>/);
  assert.match(initial.content[0].text, /Result records for model:/);
  assert.match(initial.content[0].text, /searchResultUrl: https:\/\/example\.com\/one/);
  assert.match(initial.content[0].text, /searchResultUrl: https:\/\/example\.com\/two/);

  const status = await internals.executeWebSearch(
    { curatorAction: 'status', reviewId },
    undefined,
    undefined,
    { reviewState },
  );
  assert.equal(status.details.action, 'status');
  assert.equal(status.details.review.reviewId, reviewId);
  assert.match(status.content[0].text, /Status for review search-review-1/);

  const kept = await internals.executeWebSearch(
    { curatorAction: 'keep', reviewId, resultRank: 1 },
    undefined,
    undefined,
    { reviewState },
  );
  assert.deepEqual(kept.details.review.keptUrls, ['https://example.com/one']);
  assert.match(kept.content[0].text, /Review state:/);
  assert.match(kept.content[0].text, /Kept result #1 \(result-1\)/);
  assert.match(kept.content[0].text, /#1 resultId: result-1/);
  assert.match(kept.content[0].text, /Kept result records for model:/);
  assert.match(kept.content[0].text, /searchResultUrl: https:\/\/example\.com\/one/);

  const dismissed = await internals.executeWebSearch(
    { curatorAction: 'dismiss', reviewId, resultId: 'result-2' },
    undefined,
    undefined,
    { reviewState },
  );
  assert.deepEqual(dismissed.details.review.dismissedUrls, ['https://example.com/two']);

  const fetchCalls = [];
  const fetched = await internals.executeWebSearch(
    { curatorAction: 'fetch', reviewId, resultRank: 1 },
    undefined,
    undefined,
    {
      reviewState,
      fetchContent: async (params) => {
        fetchCalls.push(params);
        return {
          content: [{ type: 'text', text: 'Fetched through guard.' }],
          details: { finalUrl: params.url, successful: 1, content: 'Hidden fetched body text.' },
        };
      },
    },
  );
  assert.deepEqual(fetchCalls, [{ url: 'https://example.com/one' }]);
  assert.equal(fetched.details.contentFetchTool, 'fetch_content');
  assert.equal(fetched.details.fetch.content, undefined);
  assert.doesNotMatch(JSON.stringify(fetched.details), /Hidden fetched body text/);
  assert.match(fetched.content[0].text, /Fetched result #1 \(https:\/\/example\.com\/one\) through fetch_content/);
  assert.match(fetched.content[0].text, /Review state:/);

  const batchCalls = [];
  const batchFetched = await internals.executeWebSearch(
    { curatorAction: 'fetch-kept', reviewId },
    undefined,
    undefined,
    {
      reviewState,
      fetchContent: async (params) => {
        batchCalls.push(params);
        return { content: [{ type: 'text', text: 'Batch fetched through guard.' }], details: { urls: params.urls, successful: params.urls.length } };
      },
    },
  );
  assert.deepEqual(batchCalls, [{ urls: ['https://example.com/one'] }]);
  assert.equal(batchFetched.details.action, 'fetch-kept');
  assert.equal(batchFetched.details.contentFetchTool, 'fetch_content');
  assert.match(batchFetched.content[0].text, /Fetched 1\/1 kept result\(s\) through fetch_content/);

  const followUpFetch = captureFetch({
    web: { results: [{ title: 'Three', url: 'https://example.com/three', description: 'three' }] },
  });
  const followUp = await internals.executeWebSearch(
    { curatorAction: 'follow-up', reviewId, followUpQuery: 'extra docs' },
    undefined,
    captureUpdates(),
    { env, fetch: followUpFetch, ctx: { hasUI: true }, reviewState },
  );
  assert.equal(new URL(followUpFetch.calls[0].url).searchParams.get('q'), 'extra docs');
  assert.equal(followUp.details.review.reviewId, reviewId);
  assert.equal(followUp.details.review.resultCount, 3);

  await assert.rejects(
    () => internals.executeWebSearch(
      { curatorAction: 'fetch', reviewId, resultId: 'result-99' },
      undefined,
      undefined,
      { reviewState, fetchContent: async () => assert.fail('fetch_content should not run') },
    ),
    /not in the review result set/,
  );

  const finished = await internals.executeWebSearch(
    { curatorAction: 'finish', reviewId },
    undefined,
    undefined,
    { reviewState },
  );
  assert.equal(finished.details.review.finished, true);
  assert.deepEqual(finished.details.keptResults.map((item) => item.url), ['https://example.com/one']);
  assert.equal(finished.details.review.keptResults[0].contentStatus, 'fetched');
  assert.equal(finished.details.review.keptResults[0].fetchRecommendedBeforeUse, false);
  assert.match(finished.content[0].text, /Citation-ready kept results:/);
  assert.match(finished.content[0].text, /URL: https:\/\/example\.com\/one/);
  assert.match(finished.content[0].text, /Content: fetched/);

  const finishedStatus = await internals.executeWebSearch(
    { curatorAction: 'status', reviewId },
    undefined,
    undefined,
    { reviewState },
  );
  assert.equal(finishedStatus.details.review.finished, true);

  await assert.rejects(
    () => internals.executeWebSearch(
      { curatorAction: 'keep', reviewId, searchResultUrl: 'https://example.com/one' },
      undefined,
      undefined,
      { reviewState },
    ),
    /review session is finished/,
  );
  await assert.rejects(
    () => internals.executeWebSearch(
      { curatorAction: 'follow-up', reviewId, followUpQuery: 'extra docs' },
      undefined,
      undefined,
      { reviewState },
    ),
    /review session is finished/,
  );
});

test('web_search supports atomic bulk keep and dismiss selectors', async () => {
  const reviewState = {};
  const env = { STRONK_PI_SEARCH_PROVIDER: 'brave', BRAVE_SEARCH_API_KEY: 'brave-test-key' };
  const initial = await internals.executeWebSearch(
    { query: 'bulk docs', workflow: 'summary-review', count: 3 },
    undefined,
    captureUpdates(),
    {
      env,
      fetch: captureFetch({
        web: {
          results: [
            { title: 'One', url: 'https://example.com/one', description: 'one' },
            { title: 'Two', url: 'https://example.com/two', description: 'two' },
            { title: 'Three', url: 'https://example.com/three', description: 'three' },
          ],
        },
      }),
      ctx: { hasUI: true },
      reviewState,
    },
  );
  const reviewId = initial.details.review.reviewId;

  const kept = await internals.executeWebSearch(
    {
      curatorAction: 'keep',
      reviewId,
      resultRanks: [1, 1],
      resultIds: ['result-2'],
      searchResultUrls: ['https://example.com/three'],
    },
    undefined,
    undefined,
    { reviewState },
  );
  assert.deepEqual(kept.details.review.keptUrls, [
    'https://example.com/one',
    'https://example.com/two',
    'https://example.com/three',
  ]);
  assert.equal(kept.details.results.length, 3);
  assert.match(kept.content[0].text, /Kept 3 results/);
  assert.match(kept.content[0].text, /content=snippet-only/);

  await assert.rejects(
    () => internals.executeWebSearch(
      { curatorAction: 'dismiss', reviewId, resultRanks: [1, 99] },
      undefined,
      undefined,
      { reviewState, fetchContent: async () => assert.fail('fetch_content should not run') },
    ),
    /not in the review result set/,
  );
  const unchanged = await internals.executeWebSearch(
    { curatorAction: 'status', reviewId },
    undefined,
    undefined,
    { reviewState },
  );
  assert.equal(unchanged.details.review.keptCount, 3);
  assert.equal(unchanged.details.review.dismissedCount, 0);

  const dismissed = await internals.executeWebSearch(
    { curatorAction: 'dismiss', reviewId, resultIds: ['result-2'], searchResultUrls: ['https://example.com/three'] },
    undefined,
    undefined,
    { reviewState },
  );
  assert.deepEqual(dismissed.details.review.keptUrls, ['https://example.com/one']);
  assert.deepEqual(dismissed.details.review.dismissedUrls, ['https://example.com/two', 'https://example.com/three']);
  assert.match(dismissed.content[0].text, /Dismissed 2 results/);

  const finished = await internals.executeWebSearch(
    { curatorAction: 'finish', reviewId },
    undefined,
    undefined,
    { reviewState },
  );
  assert.equal(finished.details.review.keptResults[0].contentStatus, 'snippet-only');
  assert.equal(finished.details.review.keptResults[0].fetchRecommendedBeforeUse, true);
  assert.match(finished.content[0].text, /Content: snippet-only; fetch_content recommended before citation/);
});

test('web_search fetch-kept caps guarded batch fetch and strips fetched bodies from details', async () => {
  const reviewState = {};
  const env = { STRONK_PI_SEARCH_PROVIDER: 'brave', BRAVE_SEARCH_API_KEY: 'brave-test-key' };
  const providerResults = Array.from({ length: 6 }, (_unused, index) => ({
    title: `Result ${index + 1}`,
    url: `https://example.com/${index + 1}`,
    description: `snippet ${index + 1}`,
  }));
  const initial = await internals.executeWebSearch(
    { query: 'batch docs', workflow: 'summary-review', count: 6 },
    undefined,
    captureUpdates(),
    {
      env,
      fetch: captureFetch({ web: { results: providerResults } }),
      ctx: { hasUI: true },
      reviewState,
    },
  );
  const reviewId = initial.details.review.reviewId;
  for (const result of providerResults) {
    await internals.executeWebSearch(
      { curatorAction: 'keep', reviewId, searchResultUrl: result.url },
      undefined,
      undefined,
      { reviewState },
    );
  }

  const batchCalls = [];
  const batchFetched = await internals.executeWebSearch(
    { curatorAction: 'fetch-kept', reviewId },
    undefined,
    undefined,
    {
      reviewState,
      fetchContent: async (params) => {
        batchCalls.push(params);
        return {
          content: [{ type: 'text', text: 'Visible fetched body text.' }],
          details: {
            urls: params.urls,
            successful: params.urls.length,
            total: params.urls.length,
            results: params.urls.map((url) => ({
              url,
              finalUrl: url,
              title: 'Fetched',
              content: 'Hidden fetched body text.',
              rawContent: 'Hidden fetched raw body text.',
            })),
          },
        };
      },
    },
  );

  assert.equal(batchCalls.length, 1);
  assert.equal(batchCalls[0].urls.length, 5);
  assert.deepEqual(batchCalls[0].urls, providerResults.slice(0, 5).map((result) => result.url));
  assert.equal(batchFetched.details.omittedCount, 1);
  assert.equal(batchFetched.details.fetch.results[0].content, undefined);
  assert.equal(batchFetched.details.fetch.results[0].rawContent, undefined);
  assert.match(batchFetched.content[0].text, /Visible fetched body text/);
  assert.doesNotMatch(JSON.stringify(batchFetched.details), /Hidden fetched body text/);
  assert.doesNotMatch(JSON.stringify(batchFetched.details), /Hidden fetched raw body text/);
});

test('web_search browser curator streams state and resolves finish before timeout', async () => {
  let openedUrl;
  const reviewState = {};
  const onUpdate = captureUpdates();
  const fetchContentCalls = [];
  const providerFetch = captureFetchSequence([
    {
      web: {
        results: [
          { title: 'One', url: 'https://example.com/one', description: 'one' },
          { title: 'Two', url: 'https://example.com/two', description: 'two' },
        ],
      },
    },
    {
      web: {
        results: [
          { title: 'Three', url: 'https://example.com/three', description: 'three' },
        ],
      },
    },
  ]);

  const searchPromise = internals.executeWebSearch(
    { query: 'agent docs', workflow: 'summary-review', count: 2 },
    undefined,
    onUpdate,
    {
      env: { STRONK_PI_SEARCH_PROVIDER: 'brave', BRAVE_SEARCH_API_KEY: 'brave-test-key' },
      fetch: providerFetch,
      fetchContent: async (params) => {
        fetchContentCalls.push(params);
        return {
          content: [{ type: 'text', text: `Fetched preview with sk-${'b'.repeat(24)}` }],
          details: { finalUrl: params.url, successful: 1 },
        };
      },
      ctx: { hasUI: true },
      reviewState,
      browserCurator: true,
      browserCuratorTestOnly: true,
      browserCuratorTimeoutMs: 1000,
      openUrl: (url) => {
        openedUrl = url;
        return true;
      },
    },
  );

  await waitUntil(() => openedUrl);
  const token = new URL(openedUrl).searchParams.get('token');
  assert.ok(token);

  const eventResponse = await fetch(curatorEndpoint(openedUrl, '/events'));
  assert.equal(eventResponse.status, 200);
  assert.match(eventResponse.headers.get('content-type'), /text\/event-stream/);
  const reader = eventResponse.body.getReader();
  const firstEvent = await reader.read();
  assert.match(Buffer.from(firstEvent.value).toString('utf8'), /event: state/);
  await reader.cancel();

  const readyState = await waitUntil(async () => {
    const { payload } = await curatorJson(openedUrl, '/state');
    return payload.state?.review?.reviewId ? payload.state : undefined;
  });
  assert.equal(readyState.review.reviewId, 'search-review-1');
  assert.equal(readyState.browser.tokenRequired, true);
  assert.equal(fetchContentCalls.length, 0);
  assert.doesNotMatch(JSON.stringify(readyState), new RegExp(token));

  const deniedUrl = new URL(openedUrl);
  deniedUrl.pathname = '/state';
  deniedUrl.searchParams.set('token', 'bad-token');
  const denied = await fetch(deniedUrl);
  assert.equal(denied.status, 403);

  const dismiss = await curatorJson(openedUrl, '/action', {
    action: 'dismiss',
    searchResultUrl: 'https://example.com/two',
  });
  assert.equal(dismiss.response.status, 200);
  assert.deepEqual(dismiss.payload.state.review.dismissedUrls, ['https://example.com/two']);

  const fetched = await curatorJson(openedUrl, '/action', {
    action: 'fetch',
    searchResultUrl: 'https://example.com/one',
  });
  assert.equal(fetched.response.status, 200);
  assert.deepEqual(fetchContentCalls, [{ url: 'https://example.com/one' }]);
  assert.equal(fetched.payload.details.contentFetchTool, 'fetch_content');
  assert.match(fetched.payload.text, /<redacted>/);
  assert.doesNotMatch(fetched.payload.text, /sk-b/);

  const followUp = await curatorJson(openedUrl, '/action', {
    action: 'follow-up',
    followUpQuery: 'extra docs',
  });
  assert.equal(followUp.response.status, 200);
  assert.equal(new URL(providerFetch.calls[1].url).searchParams.get('q'), 'extra docs');
  assert.equal(followUp.payload.state.review.resultCount, 3);

  const finished = await curatorJson(openedUrl, '/action', { action: 'finish' });
  assert.equal(finished.response.status, 200);
  assert.equal(finished.payload.details.action, 'finish');

  const result = await searchPromise;
  assert.equal(result.details.action, 'finish');
  assert.equal(result.details.browserCurator.finished, true);
  assert.deepEqual(result.details.keptResults.map((item) => item.url), [
    'https://example.com/one',
    'https://example.com/three',
  ]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(onUpdate.updates), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(onUpdate.updates), /brave-test-key/);
});

test('web_search browser curator internal opt-in stays headless without opener hook', async () => {
  const result = await internals.executeWebSearch(
    { query: 'agent docs', workflow: 'summary-review', count: 1 },
    undefined,
    captureUpdates(),
    {
      env: { STRONK_PI_SEARCH_PROVIDER: 'brave', BRAVE_SEARCH_API_KEY: 'brave-test-key' },
      fetch: captureFetch({
        web: { results: [{ title: 'One', url: 'https://example.com/one', description: 'one' }] },
      }),
      fetchContent: async () => assert.fail('browser curator must not auto-fetch page content'),
      ctx: { hasUI: true },
      reviewState: {},
      browserCurator: true,
      browserCuratorTestOnly: true,
      browserCuratorTimeoutMs: 5,
    },
  );

  assert.equal(result.details.workflow, 'summary-review');
  assert.equal(result.details.browserCurator.finished, false);
  assert.equal(result.details.browserCurator.openAttempted, false);
  assert.equal(result.details.browserCurator.opened, false);
});

test('web_search browser curator times out to deterministic search results', async () => {
  let openedUrl;
  const onUpdate = captureUpdates();
  const result = await internals.executeWebSearch(
    { query: 'agent docs', workflow: 'summary-review', count: 1 },
    undefined,
    onUpdate,
    {
      env: { STRONK_PI_SEARCH_PROVIDER: 'brave', BRAVE_SEARCH_API_KEY: 'brave-test-key' },
      fetch: captureFetch({
        web: { results: [{ title: 'One', url: 'https://example.com/one', description: 'one' }] },
      }),
      fetchContent: async () => assert.fail('browser curator must not auto-fetch page content'),
      ctx: { hasUI: true },
      reviewState: {},
      browserCurator: true,
      browserCuratorTestOnly: true,
      browserCuratorTimeoutMs: 20,
      openUrl: (url) => {
        openedUrl = url;
        return true;
      },
    },
  );

  const token = new URL(openedUrl).searchParams.get('token');
  assert.equal(result.details.workflow, 'summary-review');
  assert.equal(result.details.count, 1);
  assert.equal(result.details.browserCurator.finished, false);
  assert.equal(result.details.browserCurator.tokenRequired, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(onUpdate.updates), new RegExp(token));
});

test('web_search routes to Tavily with safe result-only request shape', async () => {
  const fetchFn = captureFetch({
    request_id: 'tavily-request-1',
    results: [{
      title: 'Tavily Result',
      url: 'https://example.com/tavily',
      content: 'Tavily snippet.',
      score: 0.91,
    }],
  });
  const env = {
    STRONK_PI_SEARCH_PROVIDER: 'tavily',
    TAVILY_API_KEY: 'tavily-test-key',
  };

  const result = await internals.executeWebSearch({ q: 'agent docs', maxResults: 4 }, undefined, undefined, { env, fetch: fetchFn });

  assert.equal(fetchFn.calls[0].url, 'https://api.tavily.com/search');
  assert.equal(fetchFn.calls[0].init.headers.Authorization, 'Bearer tavily-test-key');
  assert.deepEqual(requestBody(fetchFn.calls[0]), {
    query: 'agent docs',
    search_depth: 'basic',
    max_results: 4,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    include_favicon: true,
  });
  assert.equal(result.details.provider, 'tavily');
  assert.equal(result.details.requestId, 'tavily-request-1');
  assert.equal(result.details.results[0].score, 0.91);
});

test('web_search routes to Gemini grounding with configured model', async () => {
  const secret = `sk-${'g'.repeat(24)}`;
  const fetchFn = captureFetch({
    candidates: [{
      content: { parts: [{ text: `Grounded answer ${secret}.` }] },
      groundingMetadata: {
        webSearchQueries: ['agent docs'],
        groundingChunks: [
          { web: { title: 'Gemini Result', uri: 'https://example.com/gemini' } },
        ],
      },
    }],
  });
  const env = {
    STRONK_PI_SEARCH_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'gemini-test-key',
    STRONK_PI_GEMINI_SEARCH_MODEL: 'gemini-test-model',
  };

  const result = await internals.executeWebSearch({ search: 'agent docs', numResults: 1 }, undefined, undefined, { env, fetch: fetchFn });

  assert.equal(fetchFn.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent');
  assert.equal(fetchFn.calls[0].init.headers['x-goog-api-key'], 'gemini-test-key');
  assert.deepEqual(requestBody(fetchFn.calls[0]).tools, [{ google_search: {} }]);
  assert.match(requestBody(fetchFn.calls[0]).contents[0].parts[0].text, /agent docs/);
  assert.equal(result.details.provider, 'gemini');
  assert.equal(result.details.model, 'gemini-test-model');
  assert.deepEqual(result.details.webSearchQueries, ['agent docs']);
  assert.equal(result.details.results[0].url, 'https://example.com/gemini');
  assert.match(result.content[0].text, /Provider answer:/);
  assert.match(result.content[0].text, /Grounded answer <redacted>/);
  assert.match(result.details.answer, /Grounded answer <redacted>/);
  assert.match(result.details.results[0].snippet, /Grounded answer/);
  assert.match(result.content[0].text, /searchResultUrl: https:\/\/example\.com\/gemini/);
  assert.doesNotMatch(JSON.stringify(result), /sk-[A-Za-z0-9]/);
});

test('web_search requires explicit supported provider and provider key', async () => {
  await assert.rejects(
    () => internals.executeWebSearch({ query: 'docs' }, undefined, undefined, { env: {}, fetch: captureFetch({}) }),
    /STRONK_PI_SEARCH_PROVIDER is required/,
  );
  await assert.rejects(
    () => internals.executeWebSearch({ query: 'docs' }, undefined, undefined, { env: { STRONK_PI_SEARCH_PROVIDER: 'unsupported' }, fetch: captureFetch({}) }),
    /unsupported STRONK_PI_SEARCH_PROVIDER: unsupported/,
  );
  await assert.rejects(
    () => internals.executeWebSearch({ query: 'docs' }, undefined, undefined, { env: { STRONK_PI_SEARCH_PROVIDER: 'brave' }, fetch: captureFetch({}) }),
    /missing BRAVE_SEARCH_API_KEY/,
  );
});

test('web_search denies content expansion and unsafe provider result URLs', async () => {
  assert.deepEqual(internals.searchProviders, ['exa', 'brave', 'tavily', 'gemini']);
  await assert.rejects(
    () => internals.executeWebSearch(
      { query: 'docs', includeContent: true },
      undefined,
      undefined,
      { env: { STRONK_PI_SEARCH_PROVIDER: 'exa', EXA_API_KEY: 'exa-test-key' }, fetch: captureFetch({}) },
    ),
    /includeContent denied/,
  );

  const fetchFn = captureFetch({
    web: {
      results: [
        { title: 'Localhost', url: 'http://127.0.0.1/secret', description: 'blocked' },
        { title: 'Credentials', url: 'https://user:pass@example.com/secret', description: 'blocked' },
        { title: 'Local suffix', url: 'https://service.local/secret', description: 'blocked' },
        { title: 'IPv6 mapped', url: 'http://[::ffff:7f00:1]/secret', description: 'blocked' },
        { title: 'IPv6 mapped private', url: 'http://[::ffff:192.168.1.1]/secret', description: 'blocked' },
        { title: 'IPv6 doc range', url: 'http://[2001:db8::1]/secret', description: 'blocked' },
        { title: 'IPv6 multicast', url: 'http://[ff02::1]/secret', description: 'blocked' },
        { title: 'Secret query', url: 'https://example.com/secret?token=secret-value', description: 'blocked' },
        { title: 'Public IPv6', url: 'https://[2606:4700:4700::1111]/public-ipv6', description: 'allowed ipv6' },
        { title: 'Public', url: 'https://example.com/public', description: 'allowed' },
      ],
    },
  });
  const result = await internals.executeWebSearch(
    { query: 'docs' },
    undefined,
    undefined,
    { env: { STRONK_PI_SEARCH_PROVIDER: 'brave', BRAVE_SEARCH_API_KEY: 'brave-test-key' }, fetch: fetchFn },
  );

  assert.equal(result.details.results.length, 2);
  assert.deepEqual(result.details.results.map((item) => item.url), [
    'https://[2606:4700:4700::1111]/public-ipv6',
    'https://example.com/public',
  ]);
});

test('search tools reject unsafe inputs, closed workflow values, and redact provider keys from errors', async () => {
  const fakeSecret = `sk-${'a'.repeat(24)}`;
  await assert.rejects(
    () => internals.executeWebSearch(
      { query: 'docs', apiKey: fakeSecret },
      undefined,
      undefined,
      { env: { STRONK_PI_SEARCH_PROVIDER: 'exa', EXA_API_KEY: 'exa-test-key' }, fetch: captureFetch({}) },
    ),
    /web_search payload contains secret-like content/,
  );
  await assert.rejects(
    () => internals.executeCodeSearch(
      { query: 'docs', token: fakeSecret },
      undefined,
      undefined,
      { env: { EXA_API_KEY: 'exa-code-key' }, fetch: captureFetch({}) },
    ),
    /code_search payload contains secret-like content/,
  );
  await assert.rejects(
    () => internals.executeWebSearch(
      { query: 'read http://127.0.0.1/secret' },
      undefined,
      undefined,
      { env: { STRONK_PI_SEARCH_PROVIDER: 'exa', EXA_API_KEY: 'exa-test-key' }, fetch: captureFetch({}) },
    ),
    /web_search query must not contain local\/private URLs/,
  );
  await assert.rejects(
    () => internals.executeWebSearch(
      { queries: ['docs', 'file:///Users/example/.ssh/id_rsa'] },
      undefined,
      undefined,
      { env: { STRONK_PI_SEARCH_PROVIDER: 'exa', EXA_API_KEY: 'exa-test-key' }, fetch: captureFetch({}) },
    ),
    /web_search query must not contain local paths/,
  );
  await assert.rejects(
    () => internals.executeCodeSearch(
      { query: 'docs', path: '/Users/example/.ssh/id_rsa' },
      undefined,
      undefined,
      { env: { EXA_API_KEY: 'exa-code-key' }, fetch: captureFetch({}) },
    ),
    /code_search path must not contain local paths/,
  );
  await internals.executeWebSearch(
    { query: 'docs', workflow: 'summary-review' },
    undefined,
    undefined,
    { env: { STRONK_PI_SEARCH_PROVIDER: 'exa', EXA_API_KEY: 'exa-test-key' }, fetch: captureFetch({ results: [] }) },
  );
  await internals.executeCodeSearch(
    { query: 'docs', workflow: 'summary-review' },
    undefined,
    undefined,
    { env: { EXA_API_KEY: 'exa-code-key' }, fetch: captureFetch({ results: [] }) },
  );
  await assert.rejects(
    () => internals.executeWebSearch(
      { query: 'docs', workflow: 'interactive' },
      undefined,
      undefined,
      { env: { STRONK_PI_SEARCH_PROVIDER: 'exa', EXA_API_KEY: 'exa-test-key' }, fetch: captureFetch({}) },
    ),
    /workflow must be one of/,
  );
  await assert.rejects(
    () => internals.executeCodeSearch(
      { query: 'docs', workflow: 'interactive' },
      undefined,
      undefined,
      { env: { EXA_API_KEY: 'exa-code-key' }, fetch: captureFetch({}) },
    ),
    /workflow must be one of/,
  );

  const webError = await internals.executeWebSearch(
    { query: 'docs', workflow: 'auto' },
    undefined,
    undefined,
    { env: { STRONK_PI_SEARCH_PROVIDER: 'exa', EXA_API_KEY: 'exa-test-key' }, fetch: captureFetch('invalid key exa-test-key', 401) },
  );
  assert.match(webError.details.errors[0].message, /exa web_search HTTP 401: invalid key <redacted>/);
  assert.doesNotMatch(JSON.stringify(webError), /exa-test-key/);

  const codeError = await internals.executeCodeSearch(
    { query: 'docs', workflow: 'auto' },
    undefined,
    undefined,
    { env: { EXA_API_KEY: 'exa-code-key' }, fetch: captureFetch('invalid key exa-code-key', 401) },
  );
  assert.match(codeError.details.errors[0].message, /exa code_search HTTP 401: invalid key <redacted>/);
  assert.doesNotMatch(JSON.stringify(codeError), /exa-code-key/);
});

test('code_search uses Exa when EXA_API_KEY is available', async () => {
  const fetchFn = captureFetch({
    requestId: 'exa-code-request-1',
    results: [{
      title: 'Source File',
      url: 'https://github.com/example/repo/blob/main/src/index.ts',
      highlights: ['Example implementation snippet.'],
    }],
  });
  const env = {
    EXA_API_KEY: 'exa-code-key',
  };

  const result = await internals.executeCodeSearch({
    query: 'create subagent facade',
    language: 'TypeScript',
    repository: 'example/repo',
    path: 'src/',
    count: 3,
  }, undefined, undefined, { env, fetch: fetchFn });
  const body = requestBody(fetchFn.calls[0]);

  assert.equal(fetchFn.calls[0].url, 'https://api.exa.ai/search');
  assert.equal(fetchFn.calls[0].init.headers['x-api-key'], 'exa-code-key');
  assert.equal(body.type, 'auto');
  assert.equal(body.numResults, 3);
  assert.deepEqual(body.contents, { highlights: true });
  assert.match(body.query, /create subagent facade/);
  assert.match(body.query, /TypeScript code/);
  assert.match(body.query, /repository example\/repo/);
  assert.match(body.query, /path src\//);
  assert.equal(result.details.mode, 'exa');
  assert.equal(result.details.provider, 'exa');
  assert.equal(result.details.requestId, 'exa-code-request-1');
  assert.equal(result.details.contentFetchTool, 'fetch_content');
  assert.equal(result.details.results[0].url, 'https://github.com/example/repo/blob/main/src/index.ts');
  assert.equal(result.details.results[0].title, 'Source File');
  assert.equal(result.details.results[0].snippet, 'Example implementation snippet.');
  assert.match(result.content[0].text, /Result records for model:/);
  assert.match(result.content[0].text, /Source File/);
  assert.match(result.content[0].text, /searchResultUrl: https:\/\/github\.com\/example\/repo\/blob\/main\/src\/index\.ts/);
  assert.match(result.content[0].text, /Example implementation snippet/);
  assert.doesNotMatch(result.content[0].text, /exa-code-key/);
});

test('code_search falls back to configured Stronk web_search provider without EXA_API_KEY', async () => {
  const fetchFn = captureFetch({
    web: {
      results: [{
        title: 'Fallback Code Result',
        url: 'https://example.com/code-search',
        description: 'Fallback snippet.',
      }],
    },
  });
  const env = {
    STRONK_PI_SEARCH_PROVIDER: 'brave',
    BRAVE_SEARCH_API_KEY: 'brave-code-key',
  };

  const result = await internals.executeCodeSearch({ query: 'guard validate_web_tool', count: 2 }, undefined, undefined, { env, fetch: fetchFn });
  const calledUrl = new URL(fetchFn.calls[0].url);

  assert.equal(calledUrl.origin + calledUrl.pathname, 'https://api.search.brave.com/res/v1/web/search');
  assert.match(calledUrl.searchParams.get('q'), /guard validate_web_tool/);
  assert.match(calledUrl.searchParams.get('q'), /source code implementation/);
  assert.equal(calledUrl.searchParams.get('count'), '2');
  assert.equal(fetchFn.calls[0].init.headers['X-Subscription-Token'], 'brave-code-key');
  assert.equal(result.details.mode, 'web_search_fallback');
  assert.equal(result.details.provider, 'brave');
  assert.equal(result.details.contentFetchTool, 'fetch_content');
  assert.equal(result.details.results[0].snippet, 'Fallback snippet.');
  assert.equal(result.details.results[0].title, 'Fallback Code Result');
  assert.match(result.content[0].text, /Result records for model:/);
  assert.match(result.content[0].text, /Fallback Code Result/);
  assert.match(result.content[0].text, /searchResultUrl: https:\/\/example\.com\/code-search/);
  assert.match(result.content[0].text, /Fallback snippet/);
});

test('code_search falls back through Tavily and Gemini with safe provider request shapes', async () => {
  const tavilyFetch = captureFetch({
    results: [{
      title: 'Tavily Code',
      url: 'https://example.com/tavily-code',
      content: 'Tavily code snippet.',
    }],
  });
  const tavilyResult = await internals.executeCodeSearch(
    { query: 'safe fetch implementation', count: 4 },
    undefined,
    undefined,
    { env: { STRONK_PI_SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'tavily-code-key' }, fetch: tavilyFetch },
  );
  assert.equal(tavilyFetch.calls[0].url, 'https://api.tavily.com/search');
  assert.equal(requestBody(tavilyFetch.calls[0]).include_raw_content, false);
  assert.match(requestBody(tavilyFetch.calls[0]).query, /source code implementation/);
  assert.equal(tavilyResult.details.mode, 'web_search_fallback');
  assert.equal(tavilyResult.details.provider, 'tavily');
  assert.equal(tavilyResult.details.contentFetchTool, 'fetch_content');

  const geminiSecret = `sk-${'d'.repeat(24)}`;
  const geminiFetch = captureFetch({
    candidates: [{
      content: { parts: [{ text: `Gemini grounded code answer ${geminiSecret}.` }] },
      groundingMetadata: {
        groundingChunks: [{ web: { title: 'Gemini Code', uri: 'https://example.com/gemini-code' } }],
      },
    }],
  });
  const geminiResult = await internals.executeCodeSearch(
    { query: 'safe fetch implementation', count: 1 },
    undefined,
    undefined,
    { env: { STRONK_PI_SEARCH_PROVIDER: 'gemini', GEMINI_API_KEY: 'gemini-code-key' }, fetch: geminiFetch },
  );
  assert.deepEqual(requestBody(geminiFetch.calls[0]).tools, [{ google_search: {} }]);
  assert.match(requestBody(geminiFetch.calls[0]).contents[0].parts[0].text, /source code implementation/);
  assert.equal(geminiResult.details.mode, 'web_search_fallback');
  assert.equal(geminiResult.details.provider, 'gemini');
  assert.equal(geminiResult.details.contentFetchTool, 'fetch_content');
  assert.doesNotMatch(JSON.stringify(geminiResult), /sk-[A-Za-z0-9]/);
});

test('code_search emits redacted progress for Exa mode and web_search fallback without fetching page content', async () => {
  const exaUpdate = captureUpdates();
  const exaResult = await internals.executeCodeSearch(
    { query: 'safe fetch implementation', workflow: 'auto' },
    undefined,
    exaUpdate,
    {
      env: { EXA_API_KEY: 'exa-code-key' },
      fetch: captureFetch({
        requestId: 'exa-code-request-2',
        results: [{ title: 'Code', url: 'https://github.com/example/repo/blob/main/code.ts', highlights: [`apiKey=sk-${'b'.repeat(24)}`] }],
      }),
      ctx: { hasUI: true },
    },
  );
  assert.equal(exaResult.details.mode, 'exa');
  assert.equal(exaResult.details.workflow, 'summary-review');
  assert.deepEqual(updateStates(exaUpdate), ['start', 'result', 'completed']);
  assert.match(exaResult.details.results[0].snippet, /apiKey=<redacted>/);
  for (const update of exaUpdate.updates) {
    assert.doesNotMatch(update.content[0].text, /Code|https:\/\/github\.com\/example\/repo\/blob\/main\/code\.ts|apiKey=/);
  }
  assert.match(exaResult.content[0].text, /Code/);
  assert.match(exaResult.content[0].text, /searchResultUrl: https:\/\/github\.com\/example\/repo\/blob\/main\/code\.ts/);
  assert.match(exaResult.content[0].text, /apiKey=<redacted>/);
  assert.doesNotMatch(JSON.stringify(exaUpdate.updates), /exa-code-key/);
  assert.doesNotMatch(JSON.stringify(exaUpdate.updates), /sk-[A-Za-z0-9]/);
  assert.equal(exaResult.details.contentFetchTool, 'fetch_content');

  const fallbackUpdate = captureUpdates();
  const fallbackResult = await internals.executeCodeSearch(
    { query: 'guard validate_web_tool', workflow: 'summary-review' },
    undefined,
    fallbackUpdate,
    {
      env: { STRONK_PI_SEARCH_PROVIDER: 'brave', BRAVE_SEARCH_API_KEY: 'brave-code-key' },
      fetch: captureFetch({
        web: { results: [{ title: 'Fallback Code', url: 'https://example.com/fallback-code', description: `apiKey=sk-${'c'.repeat(24)}` }] },
      }),
      ctx: { hasUI: true },
    },
  );
  assert.equal(fallbackResult.details.mode, 'web_search_fallback');
  assert.equal(fallbackResult.details.provider, 'brave');
  assert.deepEqual(updateStates(fallbackUpdate), ['start', 'result', 'completed']);
  for (const update of fallbackUpdate.updates) {
    assert.doesNotMatch(update.content[0].text, /Fallback Code|https:\/\/example\.com\/fallback-code|apiKey=/);
  }
  assert.match(fallbackResult.content[0].text, /Fallback Code/);
  assert.match(fallbackResult.content[0].text, /searchResultUrl: https:\/\/example\.com\/fallback-code/);
  assert.match(fallbackResult.content[0].text, /apiKey=<redacted>/);
  assert.doesNotMatch(JSON.stringify(fallbackUpdate.updates), /brave-code-key/);
  assert.doesNotMatch(JSON.stringify(fallbackUpdate.updates), /sk-[A-Za-z0-9]/);
  assert.match(fallbackResult.details.results[0].snippet, /apiKey=<redacted>/);
  assert.doesNotMatch(JSON.stringify(fallbackResult), /sk-[A-Za-z0-9]/);
  assert.equal(fallbackResult.details.contentFetchTool, 'fetch_content');
});

test('code_search cancellation aborts provider work and suppresses late updates', async () => {
  const exaController = new AbortController();
  const exaUpdate = captureUpdates();
  let exaUpdatesAtAbort = 0;
  exaController.signal.addEventListener('abort', () => {
    exaUpdatesAtAbort = exaUpdate.updates.length;
  }, { once: true });
  const exaFetch = delayedFetchSequence([
    { delayMs: 80, body: { results: [{ title: 'Late Exa', url: 'https://example.com/late-exa', highlights: ['late'] }] } },
  ]);
  const exaPromise = internals.executeCodeSearch(
    { query: 'cancel exa', workflow: 'summary-review' },
    exaController.signal,
    exaUpdate,
    { env: { EXA_API_KEY: 'exa-code-key' }, fetch: exaFetch, ctx: { hasUI: true } },
  );
  await sleep(5);
  exaController.abort(new Error('operator cancelled'));
  const exaResult = await exaPromise;

  assert.equal(exaResult.details.cancelled, true);
  assert.deepEqual(exaResult.details.cancelledQueryIds, ['q1']);
  assert.deepEqual(exaResult.details.queryStates.map((item) => item.status), ['cancelled']);
  assert.deepEqual(updateStates(exaUpdate), ['start']);
  assert.equal(exaUpdate.updates.length, exaUpdatesAtAbort);
  await sleep(90);
  assert.equal(exaUpdate.updates.length, exaUpdatesAtAbort);
  assert.equal(exaFetch.active.current, 0);

  const preAborted = new AbortController();
  preAborted.abort(new Error('pre-cancelled'));
  const preUpdate = captureUpdates();
  const preFetch = captureFetch({ results: [] });
  const preResult = await internals.executeCodeSearch(
    { query: 'pre cancelled', workflow: 'summary-review' },
    preAborted.signal,
    preUpdate,
    { env: { EXA_API_KEY: 'exa-code-key' }, fetch: preFetch, ctx: { hasUI: true } },
  );
  assert.equal(preResult.details.cancelled, true);
  assert.equal(preFetch.calls.length, 0);
  assert.deepEqual(preUpdate.updates, []);

  const fallbackController = new AbortController();
  const fallbackUpdate = captureUpdates();
  let fallbackUpdatesAtAbort = 0;
  fallbackController.signal.addEventListener('abort', () => {
    fallbackUpdatesAtAbort = fallbackUpdate.updates.length;
  }, { once: true });
  const fallbackFetch = delayedFetchSequence([
    { delayMs: 80, body: { web: { results: [{ title: 'Late Fallback', url: 'https://example.com/late-fallback', description: 'late' }] } } },
  ]);
  const fallbackPromise = internals.executeCodeSearch(
    { query: 'cancel fallback', workflow: 'summary-review' },
    fallbackController.signal,
    fallbackUpdate,
    { env: { STRONK_PI_SEARCH_PROVIDER: 'brave', BRAVE_SEARCH_API_KEY: 'brave-code-key' }, fetch: fallbackFetch, ctx: { hasUI: true } },
  );
  await sleep(5);
  fallbackController.abort(new Error('operator cancelled'));
  const fallbackResult = await fallbackPromise;

  assert.equal(fallbackResult.details.cancelled, true);
  assert.equal(fallbackResult.details.mode, 'web_search_fallback');
  assert.equal(fallbackResult.details.provider, 'brave');
  assert.deepEqual(fallbackResult.details.cancelledQueryIds, ['q1']);
  assert.deepEqual(updateStates(fallbackUpdate), ['start']);
  assert.equal(fallbackUpdate.updates.length, fallbackUpdatesAtAbort);
  await sleep(90);
  assert.equal(fallbackUpdate.updates.length, fallbackUpdatesAtAbort);
  assert.equal(fallbackFetch.active.current, 0);
});

test('code_search denies content expansion and reports missing fallback configuration clearly', async () => {
  await assert.rejects(
    () => internals.executeCodeSearch({ query: 'docs', includeContent: true }, undefined, undefined, { env: {}, fetch: captureFetch({}) }),
    /code_search includeContent denied/,
  );
  await assert.rejects(
    () => internals.executeCodeSearch({ query: 'docs', fallbackToWeb: false }, undefined, undefined, { env: {}, fetch: captureFetch({}) }),
    /missing EXA_API_KEY for code_search/,
  );
  await assert.rejects(
    () => internals.executeCodeSearch({ query: 'docs' }, undefined, undefined, { env: {}, fetch: captureFetch({}) }),
    /missing EXA_API_KEY for code_search and STRONK_PI_SEARCH_PROVIDER is required/,
  );
  await assert.rejects(
    () => internals.executeCodeSearch({ query: 'docs' }, undefined, undefined, { env: { STRONK_PI_SEARCH_PROVIDER: 'brave' }, fetch: captureFetch({}) }),
    /missing EXA_API_KEY for code_search and missing BRAVE_SEARCH_API_KEY/,
  );
  await assert.rejects(
    () => internals.executeCodeSearch({ query: 'docs' }, undefined, undefined, { env: { STRONK_PI_SEARCH_PROVIDER: 'unsupported' }, fetch: captureFetch({}) }),
    /missing EXA_API_KEY for code_search and unsupported STRONK_PI_SEARCH_PROVIDER: unsupported/,
  );
  await assert.rejects(
    () => internals.executeCodeSearch({ queries: ['docs', 'api'] }, undefined, undefined, { env: { EXA_API_KEY: 'exa-code-key' }, fetch: captureFetch({}) }),
    /code_search accepts exactly one query/,
  );
});

test('registers Stronk subagent facade only when enabled by launcher env', async () => {
  const tools = [];
  await withEnv({ STRONK_PI_SUBAGENT_FACADE: 'shadow' }, async () => {
    await stronkPi({
      on: () => {},
      registerTool: (tool) => tools.push(tool),
    });
  });
  assert.ok(tools.some((tool) => tool.name === 'stronk_subagent'));
});

test('Stronk-owned fetch_content keeps the guarded registration on duplicate attempts', async () => {
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
    label: 'upstream fetch_content',
    description: 'unguarded duplicate',
    parameters: {},
    execute: async () => ({ content: [{ type: 'text', text: 'unsafe duplicate' }] }),
  });
  assert.equal(tools.has('fetch_content'), true);
  assert.match(tools.get('fetch_content').description, /Stronk Pi redirect-aware SSRF guard/);
});

test('fetch_content blocks private redirect targets before following them', async () => {
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

test('fetch_content returns readable text for an allowed public URL path', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<html><head><title>Example \x1b[31mPage\u202E</title></head><body><h1>Hello</h1><p>Readable \x1b]8;;https://example.com\x07text.\u202E</p></body></html>');
  });
  const port = await listen(server);
  try {
    await withEnv({ STRONK_PI_URL_CHECK_COMMAND_JSON: JSON.stringify([urlCheckScript(port)]) }, async () => {
      const result = await internals.executeFetchContent({ url: `http://public.example:${port}/page` });
      assert.equal(result.details.successful, 1);
      assert.equal(result.details.title, 'Example Page');
      assert.match(result.content[0].text, /Readable text/);
      assert.doesNotMatch(JSON.stringify(result), /\x1b|\u202E/);
    });
  } finally {
    server.close();
  }
});

test('fetch_content multi-url details stay metadata-only', async () => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<html><head><title>${req.url}</title></head><body><p>Hidden body text for ${req.url}</p></body></html>`);
  });
  const port = await listen(server);
  try {
    await withEnv({ STRONK_PI_URL_CHECK_COMMAND_JSON: JSON.stringify([urlCheckScript(port)]) }, async () => {
      const result = await internals.executeFetchContent({
        urls: [
          `http://public.example:${port}/one`,
          `http://public.example:${port}/two`,
        ],
      });
      assert.equal(result.details.successful, 2);
      assert.match(result.content[0].text, /Hidden body text for \/one/);
      assert.equal(result.details.results[0].content, undefined);
      assert.doesNotMatch(JSON.stringify(result.details), /Hidden body text/);
    });
  } finally {
    server.close();
  }
});

test('fetch_content rejects secret query parameters before emitting progress updates', async () => {
  const onUpdate = captureUpdates();
  await assert.rejects(
    () => internals.executeFetchContent(
      { url: 'https://example.com/page?token=plain-demo-value' },
      undefined,
      onUpdate,
    ),
    /secret query parameters/,
  );
  assert.deepEqual(onUpdate.updates, []);
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

test('image preflight config reads the portable Stronk Pi config contract', () => {
  const home = mkdtempSync(join(tmpdir(), 'stronk-pi-image-config-home.'));
  const root = join(home, '.stronk-pi');
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'defaults.toml'), [
    'schema_version = 1',
    '[models]',
    'vision = "defaults/vision-model:xhigh"',
    '[image_preflight]',
    'enabled = true',
    'max_images = 2',
    'max_bytes = 4096',
    'timeout_ms = 3000',
    'stream_idle_timeout_ms = 2000',
    'max_output_tokens = 7000',
    'failure_mode = "block"',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'config', 'roles.toml'), '[pi]\nvision_model = "roles/vision-model:xhigh"\n');
  writeFileSync(join(root, 'config', 'roles.local.toml'), '[pi]\nvision_model = "local/vision-model:high"\n');

  const config = internals.resolveVisionPreflightConfig({ env: { HOME: home } });

  assert.equal(config.enabled, true);
  assert.equal(config.model, 'local/vision-model:high');
  assert.equal(config.maxImages, 2);
  assert.equal(config.maxBytes, 4096);
  assert.equal(config.timeoutMs, 3000);
  assert.equal(config.streamIdleTimeoutMs, 2000);
  assert.equal(config.maxOutputTokens, 7000);
  assert.equal(config.failureMode, 'block');
});

test('image preflight image count defaults and clamps at twelve', () => {
  assert.equal(
    internals.resolveVisionPreflightConfig({ defaultsToml: '[image_preflight]\n' }).maxImages,
    12,
  );
  assert.equal(
    internals.resolveVisionPreflightConfig({
      defaultsToml: '[image_preflight]\nmax_images = 12\n',
    }).maxImages,
    12,
  );
  assert.equal(
    internals.resolveVisionPreflightConfig({
      defaultsToml: '[image_preflight]\nmax_images = 99\n',
    }).maxImages,
    12,
  );
  assert.equal(
    internals.resolveVisionPreflightConfig({
      defaultsToml: '[image_preflight]\nmax_images = 0\n',
    }).maxImages,
    1,
  );
  assert.equal(
    internals.resolveVisionPreflightConfig({
      defaultsToml: '[image_preflight]\nmax_images = 4\n',
      env: { STRONK_PI_IMAGE_PREFLIGHT_MAX_IMAGES: '99' },
    }).maxImages,
    12,
  );
});

test('image preflight timeout defaults and clamps at six minutes', () => {
  assert.equal(
    internals.resolveVisionPreflightConfig({ defaultsToml: '[image_preflight]\n' }).timeoutMs,
    360000,
  );
  assert.equal(
    internals.resolveVisionPreflightConfig({
      defaultsToml: '[image_preflight]\ntimeout_ms = 120000\n',
    }).timeoutMs,
    120000,
  );
  assert.equal(
    internals.resolveVisionPreflightConfig({
      defaultsToml: '[image_preflight]\ntimeout_ms = 999999\n',
    }).timeoutMs,
    360000,
  );
  assert.equal(
    internals.resolveVisionPreflightConfig({ defaultsToml: '[image_preflight]\n' }).streamIdleTimeoutMs,
    60000,
  );
  assert.equal(
    internals.resolveVisionPreflightConfig({
      defaultsToml: '[image_preflight]\nstream_idle_timeout_ms = 1000\n',
    }).streamIdleTimeoutMs,
    1000,
  );
  assert.equal(
    internals.resolveVisionPreflightConfig({
      defaultsToml: '[image_preflight]\nstream_idle_timeout_ms = 999999\n',
    }).streamIdleTimeoutMs,
    360000,
  );
});

test('image preflight output token budget defaults and clamps safely', () => {
  assert.equal(
    internals.resolveVisionPreflightConfig({ defaultsToml: '[image_preflight]\n' }).maxOutputTokens,
    4096,
  );
  assert.equal(
    internals.resolveVisionPreflightConfig({
      defaultsToml: '[image_preflight]\nmax_output_tokens = 128\n',
    }).maxOutputTokens,
    1024,
  );
  assert.equal(
    internals.resolveVisionPreflightConfig({
      defaultsToml: '[image_preflight]\nmax_output_tokens = 12000\n',
    }).maxOutputTokens,
    8192,
  );
  assert.equal(
    internals.resolveVisionPreflightConfig({
      defaultsToml: '[image_preflight]\nmax_output_tokens = 4096\n',
      env: { STRONK_PI_IMAGE_PREFLIGHT_MAX_OUTPUT_TOKENS: '8192' },
    }).maxOutputTokens,
    8192,
  );
  assert.equal(internals.imageVisionOutputTokens({ maxOutputTokens: 8192 }, 12), 4096 * 12);
});

test('image preflight model capability routing uses Pi model input metadata', () => {
  const modelsJson = JSON.stringify({
    providers: {
      'alibaba-coding': {
        models: [
          { id: 'qwen3-coder-plus', input: ['text'] },
          { id: 'qwen3.6-plus', input: ['text', 'image'] },
        ],
      },
    },
  });

  assert.equal(
    internals.modelSupportsImageInput({ model: 'alibaba-coding/qwen3.6-plus' }, {}, { modelsJson }),
    true,
  );
  assert.equal(
    internals.modelSupportsImageInput({ model: 'alibaba-coding/qwen3-coder-plus' }, {}, { modelsJson }),
    false,
  );
  assert.equal(
    internals.modelSupportsImageInput({}, { model: { id: 'custom-native', input: ['text', 'image'] } }, { modelsJson: '{}' }),
    true,
  );
});

test('image preflight active model routing ignores stale multimodal context metadata', () => {
  const modelsJson = JSON.stringify({
    providers: {
      'alibaba-coding': {
        models: [
          { id: 'qwen3-coder-plus', input: ['text'] },
          { id: 'qwen3.6-plus', input: ['text', 'image'] },
        ],
      },
    },
  });

  assert.equal(
    internals.modelSupportsImageInput(
      { model: 'alibaba-coding/qwen3-coder-plus' },
      { model: { provider: 'alibaba-coding', id: 'qwen3.6-plus', input: ['text', 'image'] } },
      { modelsJson },
    ),
    false,
  );
  assert.equal(
    internals.modelSupportsImageInput(
      { model: 'alibaba-coding/qwen3.6-plus' },
      { model: { provider: 'alibaba-coding', id: 'qwen3.6-plus', input: ['text', 'image'] } },
      { modelsJson },
    ),
    true,
  );
  assert.equal(
    internals.modelSupportsImageInput(
      { model: 'alibaba-coding/qwen3-coder-plus' },
      { model: { input: ['text', 'image'] } },
      { modelsJson },
    ),
    false,
  );
});

test('image preflight discovers pasted screenshot paths with spaces safely', () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-paths.'));
  const imagePath = realpathSync(writePng(root));
  const config = { maxImages: 4, maxBytes: 1024 * 1024 };
  const text = `Please inspect "${imagePath}" before answering.`;

  assert.deepEqual(internals.extractImagePathCandidates(text), [imagePath]);

  const collected = internals.collectImageInputs(
    { text },
    { cwd: root },
    config,
    { env: { HOME: root, TMPDIR: tmpdir() } },
  );

  assert.equal(collected.images.length, 1);
  assert.equal(collected.images[0].mediaType, 'image/png');
  assert.equal(collected.images[0].path, imagePath);
  assert.equal(collected.skipped.length, 0);
});

test('image preflight does not expand folders into image inputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-folder.'));
  const folder = join(root, 'folder-with-images');
  mkdirSync(folder);
  writePng(folder, 'child.png');
  let called = false;

  const noImagePath = await withEnv(allowingPromptHookEnv(), async () => internals.handleInput(
    {
      text: `Go into ${folder} and read the images inside.`,
      model: 'alibaba-coding/qwen3-coder-plus',
    },
    {
      cwd: root,
      visionPreflight: async () => {
        called = true;
      },
    },
  ));

  assert.equal(noImagePath, undefined);
  assert.equal(called, false);

  const imageLikeFolder = join(root, 'gallery.png');
  mkdirSync(imageLikeFolder);
  writePng(imageLikeFolder, 'nested-child.png');
  const skippedDirectory = await withEnv(allowingPromptHookEnv(), async () => internals.handleInput(
    {
      text: `Analyze ${imageLikeFolder}`,
      model: 'alibaba-coding/qwen3-coder-plus',
    },
    {
      cwd: root,
      visionPreflight: async () => {
        called = true;
      },
    },
  ));

  assert.equal(called, false);
  assert.equal(skippedDirectory.action, 'transform');
  assert.match(skippedDirectory.text, /image path is not a file/);
  assert.doesNotMatch(skippedDirectory.text, /nested-child\.png/);
});

test('image_read analyzes explicit local image paths through the configured vision route', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-read-path.'));
  const imagePath = realpathSync(writePng(root, 'tool-screenshot.png'));
  const calls = [];
  const tools = [];
  await stronkPi({
    on: () => {},
    registerTool: (tool) => tools.push(tool),
  });
  const imageRead = tools.find((tool) => tool.name === 'image_read');

  const result = await withEnv({ STRONK_PI_STATE_ROOT: join(root, '.stronk-pi') }, async () => imageRead.execute(
    'tool-call-image-read',
    {
      paths: [imagePath],
      question: `What changed in ${imagePath}?`,
    },
    undefined,
    undefined,
    {
      cwd: root,
      visionPreflight: async (request) => {
        calls.push(request);
        return {
          images: [{
            label: 'image-1',
            observed_facts: ['E1: A green status indicator is visible.'],
            inferences: ['I1: The status likely indicates success based on E1.'],
          }],
        };
      },
    },
  ));

  const text = result.content[0].text;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'kimi-coding/kimi-for-coding:xhigh');
  assert.equal(calls[0].messages[0].content.filter((part) => part.type === 'image').length, 1);
  assert.match(calls[0].messages[0].content[0].text, /\[image-1; tool-screenshot\.png]/);
  assert.equal(calls[0].messages[0].content[0].text.includes(imagePath), false);
  assert.equal(JSON.stringify(calls[0].images).includes(imagePath), false);
  assert.equal(JSON.stringify(calls[0].images).includes(PNG_BASE64.slice(0, 24)), false);
  assert.match(text, /^Image Read complete: analyzed 1 image\./);
  assert.match(text, /<stronk-pi-image-read>/);
  assert.match(text, /<\/stronk-pi-image-read>/);
  assert.match(text, /Stronk Pi Image Read/);
  assert.doesNotMatch(text, /<stronk-pi-image-vision-preflight>/);
  assert.doesNotMatch(text, /<\/stronk-pi-image-vision-preflight>/);
  assert.match(text, /Image Evidence Index:/);
  assert.match(text, /image-1\.E1: A green status indicator is visible/);
  assert.match(text, /image-1\.I1: The status likely indicates success based on image-1\.E1/);
  assert.equal(text.includes(imagePath), false);
  assert.equal(JSON.stringify(result.details).includes(imagePath), false);
  assert.equal(JSON.stringify(result.details).includes(PNG_BASE64.slice(0, 24)), false);
  assert.equal(result.details.tool, 'image_read');
  assert.equal(result.details.imageCount, 1);
});

test('image_read scans one directory when it resolves exactly one image and does not recurse by default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-read-dir.'));
  const gallery = join(root, 'screens');
  mkdirSync(gallery);
  mkdirSync(join(gallery, 'nested'));
  writePng(gallery, 'a-first.png');
  writePng(gallery, '.hidden.png');
  writePng(join(gallery, 'nested'), 'c-nested.png');
  writeFileSync(join(gallery, 'not-image.png'), 'not a real png');
  writeFileSync(join(gallery, 'notes.txt'), 'not a screenshot');
  const calls = [];

  const result = await internals.executeImageRead(
    { directory: gallery },
    undefined,
    {
      cwd: root,
      visionPreflight: async (request) => {
        calls.push(request);
        return {
          images: request.images.map((image) => ({
            label: image.label,
            observed_facts: [`E1: ${image.displayName} was analyzed.`],
            inferences: [`I1: ${image.displayName} is part of the requested folder.`],
          })),
        };
      },
    },
    { env: { STRONK_PI_STATE_ROOT: join(root, '.stronk-pi') } },
  );

  const text = result.content[0].text;
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].images.map((image) => image.displayName), ['a-first.png']);
  assert.match(calls[0].messages[0].content[0].text, /- image-1: a-first\.png; mime=image\/png/);
  assert.equal(calls[0].messages[0].content.filter((part) => part.type === 'image').length, 1);
  assert.match(text, /^Image Read complete: analyzed 1 image; skipped 2 images\./);
  assert.match(text, /Skipped Images:/);
  assert.match(text, /\.hidden\.png: hidden path skipped/);
  assert.match(text, /not-image\.png: unsupported MIME type image\/png/);
  assert.doesNotMatch(text, /notes\.txt/);
  assert.doesNotMatch(text, /c-nested\.png/);
  assert.equal(text.includes(gallery), false);
  assert.equal(JSON.stringify(result.details).includes(gallery), false);
  assert.equal(JSON.stringify(calls[0].images).includes(gallery), false);
});

test('image_read rejects directory scans that resolve multiple image candidates before vision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-read-dir-multi.'));
  const gallery = join(root, 'screens');
  mkdirSync(gallery);
  const first = writePng(gallery, 'a-first.png');
  const second = writePng(gallery, 'b-second.png');
  const calls = [];

  const result = await internals.executeImageRead(
    { directory: gallery },
    undefined,
    {
      cwd: root,
      visionPreflight: async (request) => {
        calls.push(request);
        return { images: [] };
      },
    },
    { env: { STRONK_PI_STATE_ROOT: join(root, '.stronk-pi') } },
  );

  const text = result.content[0].text;
  assert.equal(calls.length, 0);
  assert.equal(result.isError, true);
  assert.match(text, /^Image Read rejected: directory scan resolved 2 image candidates\./);
  assert.match(text, /one exact path or a narrower directory\/input/);
  assert.equal(result.details.failure, 'directory scan resolved multiple images');
  assert.equal(result.details.rejection.candidateCount, 2);
  assert.deepEqual(result.details.rejection.candidateNames, ['a-first.png', 'b-second.png']);
  assert.equal(text.includes(gallery), false);
  assert.equal(JSON.stringify(result.details).includes(first), false);
  assert.equal(JSON.stringify(result.details).includes(second), false);
});

test('image_read directory scan reports the entry cap for large folders', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-read-large-dir.'));
  const gallery = join(root, 'screens');
  mkdirSync(gallery);
  for (let index = 0; index < 520; index += 1) {
    writeFileSync(join(gallery, `${String(index).padStart(3, '0')}.txt`), 'not an image');
  }
  const calls = [];

  const result = await internals.executeImageRead(
    { directory: gallery },
    undefined,
    {
      cwd: root,
      visionPreflight: async (request) => {
        calls.push(request);
        return { images: [] };
      },
    },
    { env: { STRONK_PI_STATE_ROOT: join(root, '.stronk-pi') } },
  );

  const text = result.content[0].text;
  assert.equal(calls.length, 0);
  assert.match(text, /directory scan entry limit reached \(512\)/);
  assert.equal(text.includes(gallery), false);
  assert.equal(JSON.stringify(result.details).includes(gallery), false);
});

test('image_read rejects hidden and symlink directory roots before scanning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-read-root-guard.'));
  const hiddenGallery = join(root, '.screens');
  const realGallery = join(root, 'screens');
  const linkedGallery = join(root, 'linked-screens');
  mkdirSync(hiddenGallery);
  mkdirSync(realGallery);
  writePng(hiddenGallery, 'hidden-child.png');
  writePng(realGallery, 'linked-child.png');
  symlinkSync(realGallery, linkedGallery, 'dir');
  const calls = [];
  const ctx = {
    cwd: root,
    visionPreflight: async (request) => {
      calls.push(request);
      return { images: [] };
    },
  };
  const options = { env: { STRONK_PI_STATE_ROOT: join(root, '.stronk-pi') } };

  const hiddenResult = await internals.executeImageRead({ directory: hiddenGallery }, undefined, ctx, options);
  const symlinkResult = await internals.executeImageRead({ directory: linkedGallery }, undefined, ctx, options);

  assert.equal(calls.length, 0);
  assert.match(hiddenResult.content[0].text, /hidden directory root skipped/);
  assert.doesNotMatch(hiddenResult.content[0].text, /hidden-child\.png/);
  assert.match(symlinkResult.content[0].text, /symlink directory root skipped/);
  assert.doesNotMatch(symlinkResult.content[0].text, /linked-child\.png/);
});

test('image_read keeps default modes bounded by allowed image roots', async () => {
  const fixture = makeExternalImageFixture('image-read-default');
  try {
    const externalImage = writePng(fixture.externalRoot, 'outside-explicit.png');
    const externalGallery = join(fixture.externalRoot, 'gallery');
    mkdirSync(externalGallery);
    writePng(externalGallery, 'outside-folder.png');
    const calls = [];

    const explicitResult = await internals.executeImageRead(
      { paths: [externalImage] },
      undefined,
      {
        cwd: fixture.cwd,
        permissionMode: 'default',
        visionPreflight: async (request) => {
          calls.push(request);
          return { images: [] };
        },
      },
      { env: fixture.env },
    );
    const directoryResult = await internals.executeImageRead(
      { directory: externalGallery },
      undefined,
      {
        cwd: fixture.cwd,
        permissionMode: 'default',
        visionPreflight: async (request) => {
          calls.push(request);
          return { images: [] };
        },
      },
      { env: fixture.env },
    );

    const text = `${explicitResult.content[0].text}\n${directoryResult.content[0].text}`;
    assert.equal(calls.length, 0);
    assert.match(explicitResult.content[0].text, /Image Read complete: analyzed 0 images; skipped 1 image/);
    assert.match(directoryResult.content[0].text, /Image Read complete: analyzed 0 images; skipped 1 image/);
    assert.match(text, /outside-explicit\.png: path outside allowed image roots/);
    assert.match(text, /gallery: path outside allowed image roots/);
    assert.equal(text.includes(fixture.externalRoot), false);
    assert.equal(JSON.stringify(explicitResult.details).includes(fixture.externalRoot), false);
    assert.equal(JSON.stringify(directoryResult.details).includes(fixture.externalRoot), false);
  } finally {
    fixture.cleanup();
  }
});

test('image_read registered tool allows explicit paths when Pi omits permission metadata', async () => {
  const fixture = makeExternalImageFixture('image-read-registered-no-mode');
  try {
    const externalImage = writePng(fixture.externalRoot, 'outside-registered.png');
    const tools = [];
    const calls = [];
    await stronkPi({
      on: () => {},
      registerTool: (tool) => tools.push(tool),
    });
    const imageRead = tools.find((tool) => tool.name === 'image_read');

    const result = await withEnv(fixture.env, async () => imageRead.execute(
      'live-tool-call-without-mode',
      { paths: [externalImage], question: 'Describe this image.' },
      undefined,
      undefined,
      {
        cwd: fixture.cwd,
        visionPreflight: async (request) => {
          calls.push(request);
          return {
            images: request.images.map((image) => ({
              label: image.label,
              observed_facts: [`E1: ${image.displayName} was analyzed.`],
              inferences: [],
            })),
          };
        },
      },
    ));

    const text = result.content[0].text;
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].images.map((image) => image.displayName), ['outside-registered.png']);
    assert.match(text, /Image Read complete: analyzed 1 image/);
    assert.doesNotMatch(text, /path outside allowed image roots/);
    assert.equal(text.includes(fixture.externalRoot), false);
    assert.equal(JSON.stringify(result.details).includes(fixture.externalRoot), false);
    assert.equal(JSON.stringify(calls[0].images).includes(fixture.externalRoot), false);
  } finally {
    fixture.cleanup();
  }
});

test('image_read auto mode does not infer the restricted allowed-root policy', async () => {
  const fixture = makeExternalImageFixture('image-read-auto-mode');
  try {
    const externalImage = writePng(fixture.externalRoot, 'outside-auto.png');
    const calls = [];

    const result = await internals.executeImageRead(
      { paths: [externalImage] },
      undefined,
      {
        cwd: fixture.cwd,
        permissionMode: 'auto',
        visionPreflight: async (request) => {
          calls.push(request);
          return {
            images: request.images.map((image) => ({
              label: image.label,
              observed_facts: [`E1: ${image.displayName} was analyzed.`],
              inferences: [],
            })),
          };
        },
      },
      { env: fixture.env },
    );

    const text = result.content[0].text;
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].images.map((image) => image.displayName), ['outside-auto.png']);
    assert.match(text, /Image Read complete: analyzed 1 image/);
    assert.doesNotMatch(text, /path outside allowed image roots/);
    assert.equal(text.includes(fixture.externalRoot), false);
    assert.equal(JSON.stringify(result.details).includes(fixture.externalRoot), false);
  } finally {
    fixture.cleanup();
  }
});

test('image_read full-yolo mode accepts explicit paths and directory roots outside session roots', async () => {
  const fixture = makeExternalImageFixture('image-read-full-yolo');
  try {
    const explicitImage = writePng(fixture.externalRoot, 'outside-explicit.png');
    const externalGallery = join(fixture.externalRoot, 'gallery');
    mkdirSync(externalGallery);
    writePng(externalGallery, 'outside-folder.png');
    const calls = [];
    const ctx = {
      cwd: fixture.cwd,
      permissionMode: 'full-yolo',
      visionPreflight: async (request) => {
        calls.push(request);
        return {
          images: request.images.map((image) => ({
            label: image.label,
            observed_facts: [`E1: ${image.displayName} was analyzed.`],
            inferences: [],
          })),
        };
      },
    };

    const explicitResult = await internals.executeImageRead(
      { paths: [explicitImage] },
      undefined,
      ctx,
      { env: fixture.env },
    );
    const directoryResult = await internals.executeImageRead(
      { directory: externalGallery },
      undefined,
      ctx,
      { env: fixture.env },
    );

    const text = `${explicitResult.content[0].text}\n${directoryResult.content[0].text}`;
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.images.map((image) => image.displayName)), [['outside-explicit.png'], ['outside-folder.png']]);
    assert.equal(calls.every((call) => call.messages[0].content.filter((part) => part.type === 'image').length === 1), true);
    assert.match(explicitResult.content[0].text, /Image Read complete: analyzed 1 image/);
    assert.match(directoryResult.content[0].text, /Image Read complete: analyzed 1 image/);
    assert.doesNotMatch(text, /path outside allowed image roots/);
    assert.match(text, /image-1\.E1: outside-explicit\.png was analyzed/);
    assert.match(text, /image-1\.E1: outside-folder\.png was analyzed/);
    assert.equal(text.includes(fixture.externalRoot), false);
    assert.equal(JSON.stringify(explicitResult.details).includes(fixture.externalRoot), false);
    assert.equal(JSON.stringify(directoryResult.details).includes(fixture.externalRoot), false);
    assert.equal(JSON.stringify(calls).includes(fixture.externalRoot), false);
  } finally {
    fixture.cleanup();
  }
});

test('image_read full-disk sandbox env is not masked by default permission mode', async () => {
  const fixture = makeExternalImageFixture('image-read-full-env', { CODEX_SANDBOX_MODE: 'disabled' });
  try {
    const explicitImage = writePng(fixture.externalRoot, 'outside-env.png');
    const calls = [];

    const result = await internals.executeImageRead(
      { paths: [explicitImage] },
      undefined,
      {
        cwd: fixture.cwd,
        permissionMode: 'default',
        visionPreflight: async (request) => {
          calls.push(request);
          return {
            images: request.images.map((image) => ({
              label: image.label,
              observed_facts: [`E1: ${image.displayName} was analyzed.`],
              inferences: [],
            })),
          };
        },
      },
      { env: fixture.env },
    );

    const text = result.content[0].text;
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].images.map((image) => image.displayName), ['outside-env.png']);
    assert.match(text, /Image Read complete: analyzed 1 image/);
    assert.doesNotMatch(text, /path outside allowed image roots/);
    assert.equal(text.includes(fixture.externalRoot), false);
    assert.equal(JSON.stringify(result.details).includes(fixture.externalRoot), false);
  } finally {
    fixture.cleanup();
  }
});

test('prompt-time image preflight auto mode reads explicit image paths outside cwd', async () => {
  const fixture = makeExternalImageFixture('image-preflight-auto-root');
  try {
    const externalImage = writePng(fixture.externalRoot, 'outside-prompt-auto.png');
    const calls = [];
    const notices = [];

    const result = await withEnv(allowingPromptHookEnv(fixture.env), async () => internals.handleInput(
      {
        text: `Read ${externalImage}`,
        model: 'alibaba-coding/qwen3-coder-plus',
        cwd: fixture.cwd,
        permissionMode: 'auto',
      },
      {
        cwd: fixture.cwd,
        permissionMode: 'auto',
        hasUI: true,
        ui: { notify: (message, kind) => notices.push([kind, message]) },
        visionPreflight: async (request) => {
          calls.push(request);
          return {
            images: request.images.map((image) => ({
              label: image.label,
              observed_facts: [`E1: ${image.displayName} was analyzed.`],
              inferences: [],
            })),
          };
        },
      },
    ));

    assert.equal(result.action, 'transform');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].messages[0].content.filter((part) => part.type === 'image').length, 1);
    assert.deepEqual(calls[0].images.map((image) => image.displayName), ['outside-prompt-auto.png']);
    assert.match(result.text, /<stronk-pi-image-vision-preflight>/);
    assert.match(result.text, /Images analyzed: 1/);
    assert.match(result.text, /\[image-1; outside-prompt-auto\.png]/);
    assert.doesNotMatch(result.text, /path outside allowed image roots/);
    assert.equal(result.text.includes(fixture.externalRoot), false);
    assert.equal(JSON.stringify(calls[0].images).includes(fixture.externalRoot), false);
    assert.deepEqual(notices, [
      ['info', 'Stronk Pi detected 1 image for a text-only model; analyzing with vision preflight.'],
      ['info', 'Image vision preflight complete: analyzed 1 image.'],
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('prompt-time image preflight treats missing permission mode as auto for explicit image paths', async () => {
  const fixture = makeExternalImageFixture('image-preflight-unspecified-root');
  try {
    const externalImage = writePng(fixture.externalRoot, 'outside-prompt-unspecified.png');
    const calls = [];

    const result = await withEnv(allowingPromptHookEnv(fixture.env), async () => internals.handleInput(
      {
        text: `Read ${externalImage}`,
        model: 'alibaba-coding/qwen3-coder-plus',
        cwd: fixture.cwd,
      },
      {
        cwd: fixture.cwd,
        visionPreflight: async (request) => {
          calls.push(request);
          return {
            images: request.images.map((image) => ({
              label: image.label,
              observed_facts: [`E1: ${image.displayName} was analyzed.`],
              inferences: [],
            })),
          };
        },
      },
    ));

    assert.equal(result.action, 'transform');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].messages[0].content.filter((part) => part.type === 'image').length, 1);
    assert.deepEqual(calls[0].images.map((image) => image.displayName), ['outside-prompt-unspecified.png']);
    assert.match(result.text, /Images analyzed: 1/);
    assert.doesNotMatch(result.text, /path outside allowed image roots/);
    assert.equal(result.text.includes(fixture.externalRoot), false);
  } finally {
    fixture.cleanup();
  }
});

test('prompt-time image preflight keeps path-root checks in default mode', () => {
  const fixture = makeExternalImageFixture('image-preflight-default-root');
  try {
    const externalImage = writePng(fixture.externalRoot, 'outside-prompt.png');

    const collected = internals.collectImageInputs(
      { text: externalImage, cwd: fixture.cwd, permissionMode: 'default' },
      { cwd: fixture.cwd, permissionMode: 'default' },
      { maxImages: 12, maxBytes: 5 * 1024 * 1024 },
      { env: fixture.env },
    );

    assert.equal(collected.images.length, 0);
    assert.equal(collected.skipped.length, 1);
    assert.equal(collected.skipped[0].origin, 'event.text[0]');
    assert.equal(collected.skipped[0].reason, 'path outside allowed image roots');
  } finally {
    fixture.cleanup();
  }
});

test('image_read allows visible relative paths from a hidden cwd ancestor', async () => {
  const root = mkdtempSync(join(tmpdir(), '.stronk-pi-image-read-hidden-cwd.'));
  writePng(root, 'visible.png');
  const screens = join(root, 'screens');
  mkdirSync(screens);
  writePng(screens, 'screen.png');
  const calls = [];

  const ctx = {
    cwd: root,
    visionPreflight: async (request) => {
      calls.push(request);
      return {
        images: request.images.map((image) => ({
          label: image.label,
          observed_facts: [`E1: ${image.displayName} was analyzed.`],
          inferences: [],
        })),
      };
    },
  };
  const options = { env: { STRONK_PI_STATE_ROOT: join(root, '.stronk-pi') } };

  const explicitResult = await internals.executeImageRead({ paths: ['visible.png'] }, undefined, ctx, options);
  const directoryResult = await internals.executeImageRead({ directory: 'screens' }, undefined, ctx, options);

  const text = `${explicitResult.content[0].text}\n${directoryResult.content[0].text}`;
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.images.map((image) => image.displayName)), [['visible.png'], ['screen.png']]);
  assert.equal(calls.every((call) => call.messages[0].content.filter((part) => part.type === 'image').length === 1), true);
  assert.match(explicitResult.content[0].text, /Image Read complete: analyzed 1 image/);
  assert.match(directoryResult.content[0].text, /Image Read complete: analyzed 1 image/);
  assert.doesNotMatch(text, /hidden path skipped|hidden directory root skipped/);
  assert.equal(text.includes(root), false);
  assert.equal(JSON.stringify(explicitResult.details).includes(root), false);
  assert.equal(JSON.stringify(directoryResult.details).includes(root), false);
});

test('image_read rejects directory roots whose realpath enters a hidden ancestor before enumeration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-read-hidden-realpath.'));
  const hiddenRoot = join(root, '.hidden-source');
  const hiddenImages = join(hiddenRoot, 'images');
  mkdirSync(hiddenImages, { recursive: true });
  writePng(hiddenImages, 'hidden-secret.png');
  const publicLink = join(root, 'public-link');
  symlinkSync(hiddenRoot, publicLink, 'dir');
  const calls = [];

  const result = await internals.executeImageRead(
    { directory: join(publicLink, 'images') },
    undefined,
    {
      cwd: root,
      visionPreflight: async (request) => {
        calls.push(request);
        return { images: [] };
      },
    },
    { env: { STRONK_PI_STATE_ROOT: join(root, '.stronk-pi') } },
  );

  const text = result.content[0].text;
  assert.equal(calls.length, 0);
  assert.match(text, /hidden directory root skipped/);
  assert.doesNotMatch(text, /hidden-secret\.png/);
  assert.equal(text.includes(hiddenRoot), false);
});

test('image_read rejects explicit hidden protected and symlink paths before vision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-read-path-guard.'));
  const realImage = writePng(root, 'real.png');
  const hiddenFile = writePng(root, '.hidden.png');
  const hiddenDir = join(root, '.screens');
  mkdirSync(hiddenDir);
  const hiddenChild = writePng(hiddenDir, 'hidden-child.png');
  const protectedDir = join(root, '.ssh');
  mkdirSync(protectedDir);
  const protectedImage = writePng(protectedDir, 'secret.png');
  const symlinkImage = join(root, 'linked.png');
  symlinkSync(realImage, symlinkImage);
  const calls = [];

  const ctx = {
    cwd: root,
    visionPreflight: async (request) => {
      calls.push(request);
      return { images: [] };
    },
  };
  const options = { env: { STRONK_PI_STATE_ROOT: join(root, '.stronk-pi') } };
  const results = [];
  for (const path of [hiddenFile, hiddenChild, protectedImage, symlinkImage]) {
    results.push(await internals.executeImageRead({ paths: [path] }, undefined, ctx, options));
  }

  const text = results.map((result) => result.content[0].text).join('\n');
  assert.equal(calls.length, 0);
  assert.match(text, /\.hidden\.png: hidden path skipped/);
  assert.match(text, /hidden-child\.png: hidden path skipped/);
  assert.match(text, /secret\.png: protected local path denied/);
  assert.match(text, /linked\.png: symlink path skipped/);
  for (const path of [hiddenFile, hiddenChild, protectedImage, symlinkImage]) {
    assert.equal(text.includes(path), false);
    assert.equal(JSON.stringify(results.map((result) => result.details)).includes(path), false);
  }
});

test('image_read can call configured OpenAI-compatible vision provider without path leaks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-read-provider.'));
  const stateRoot = join(root, '.stronk-pi');
  mkdirSync(join(stateRoot, 'agent'), { recursive: true });
  mkdirSync(join(stateRoot, 'config'), { recursive: true });
  writeFileSync(join(stateRoot, 'agent', 'models.json'), JSON.stringify({
    providers: {
      'vision-provider': {
        api: 'openai-completions',
        apiKey: '$VISION_API_KEY',
        baseUrl: 'https://vision.example/v1',
        models: [
          { id: 'vision-large', input: ['text', 'image'] },
        ],
      },
    },
  }));
  writeFileSync(join(stateRoot, 'config', 'defaults.toml'), [
    '[image_preflight]',
    'enabled = true',
    'model = "vision-provider/vision-large"',
    '',
  ].join('\n'));
  const imagePath = writePng(root, 'provider.png');
  const unrelatedPath = join(root, 'notes', 'secret.txt');
  const linuxEtcPath = '/etc/passwd';
  const linuxRootPath = '/root/.ssh/id_ed25519';
  const optPath = '/opt/private/foo.png';
  const srvPath = '/srv/data/x.png';
  const mntPath = '/mnt/share/x.png';
  const applicationsPath = '/Applications/Secret.app/screen.png';
  const appSupportPath = '/Users/alice/Library/Application Support/App/secret.png';
  const mobileDocumentsPath = '/Users/alice/Library/Mobile Documents/com~apple~CloudDocs/secret.png';
  const fileUrlWithSpaces = 'file:///Users/alice/My Docs/x.png';
  const publicUrl = 'https://example.com/docs/image.png';
  const mimeToken = 'image/png';
  const modelToken = 'kimi-coding/kimi-for-coding';
  const ratioToken = '16/9';
  const rawGifDataUrl = `data:image/gif;base64,${TINY_GIF_BASE64}`;
  const fetchFn = captureFetch({
    choices: [{
      message: {
        content: JSON.stringify({
          images: [{
            label: 'image-1',
            observed_facts: [`E1: The provider image was analyzed while echoing ${unrelatedPath}, ${linuxEtcPath}, ${linuxRootPath}, ${optPath}, ${srvPath}, ${mntPath}, ${applicationsPath}, ${appSupportPath}, ${mobileDocumentsPath}, ${fileUrlWithSpaces}, ${publicUrl}, ${mimeToken}, ${modelToken}, ${ratioToken}, and ${rawGifDataUrl}.`],
            inferences: ['I1: The provider fallback is wired based on E1.'],
          }],
        }),
      },
    }],
  });

  const result = await internals.executeImageRead(
    { paths: [imagePath], question: `Inspect ${imagePath}; compare with ${unrelatedPath}; ${linuxEtcPath}; ${linuxRootPath}; ${optPath}; ${srvPath}; ${mntPath}; ${applicationsPath}; "${appSupportPath}"; '${mobileDocumentsPath}'; ${fileUrlWithSpaces}; keep ${publicUrl}; ${mimeToken}; ${modelToken}; ${ratioToken}; ignore ${rawGifDataUrl}; directory ${root}` },
    undefined,
    { cwd: root, fetch: fetchFn },
    {
      env: {
        STRONK_PI_STATE_ROOT: stateRoot,
        VISION_API_KEY: 'vision-test-key',
      },
      fetch: fetchFn,
    },
  );

  assert.equal(fetchFn.calls.length, 1);
  assert.equal(fetchFn.calls[0].url, 'https://vision.example/v1/chat/completions');
  const payload = requestBody(fetchFn.calls[0]);
  assert.equal(payload.model, 'vision-large');
  assert.equal(payload.max_tokens, 4096);
  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages[1].content[1].type, 'image_url');
  assert.match(payload.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(payload.messages[1].content[0].text.includes(imagePath), false);
  assert.equal(payload.messages[1].content[0].text.includes(unrelatedPath), false);
  assert.equal(payload.messages[1].content[0].text.includes(root), false);
  assert.equal(payload.messages[1].content[0].text.includes(linuxEtcPath), false);
  assert.equal(payload.messages[1].content[0].text.includes(linuxRootPath), false);
  assert.equal(payload.messages[1].content[0].text.includes(optPath), false);
  assert.equal(payload.messages[1].content[0].text.includes(srvPath), false);
  assert.equal(payload.messages[1].content[0].text.includes(mntPath), false);
  assert.equal(payload.messages[1].content[0].text.includes(applicationsPath), false);
  assert.equal(payload.messages[1].content[0].text.includes(appSupportPath), false);
  assert.equal(payload.messages[1].content[0].text.includes(mobileDocumentsPath), false);
  assert.equal(payload.messages[1].content[0].text.includes(fileUrlWithSpaces), false);
  assert.equal(payload.messages[1].content[0].text.includes('Application Support'), false);
  assert.equal(payload.messages[1].content[0].text.includes('Mobile Documents'), false);
  assert.equal(payload.messages[1].content[0].text.includes('My Docs'), false);
  assert.equal(payload.messages[1].content[0].text.includes(publicUrl), true);
  assert.equal(payload.messages[1].content[0].text.includes(mimeToken), true);
  assert.equal(payload.messages[1].content[0].text.includes(modelToken), true);
  assert.equal(payload.messages[1].content[0].text.includes(ratioToken), true);
  assert.equal(payload.messages[1].content[0].text.includes('.ssh'), false);
  assert.doesNotMatch(payload.messages[1].content[0].text, /data:image\/gif;base64/);
  assert.doesNotMatch(payload.messages[1].content[0].text, new RegExp(TINY_GIF_BASE64.slice(0, 16)));
  assert.match(result.content[0].text, /image-1\.E1: The provider image was analyzed/);
  assert.equal(result.content[0].text.includes(imagePath), false);
  assert.equal(result.content[0].text.includes(unrelatedPath), false);
  assert.equal(result.content[0].text.includes(root), false);
  assert.equal(result.content[0].text.includes(linuxEtcPath), false);
  assert.equal(result.content[0].text.includes(linuxRootPath), false);
  assert.equal(result.content[0].text.includes(optPath), false);
  assert.equal(result.content[0].text.includes(srvPath), false);
  assert.equal(result.content[0].text.includes(mntPath), false);
  assert.equal(result.content[0].text.includes(applicationsPath), false);
  assert.equal(result.content[0].text.includes(appSupportPath), false);
  assert.equal(result.content[0].text.includes(mobileDocumentsPath), false);
  assert.equal(result.content[0].text.includes(fileUrlWithSpaces), false);
  assert.equal(result.content[0].text.includes('Application Support'), false);
  assert.equal(result.content[0].text.includes('Mobile Documents'), false);
  assert.equal(result.content[0].text.includes('My Docs'), false);
  assert.equal(result.content[0].text.includes(publicUrl), true);
  assert.equal(result.content[0].text.includes(mimeToken), true);
  assert.equal(result.content[0].text.includes(modelToken), true);
  assert.equal(result.content[0].text.includes(ratioToken), true);
  assert.equal(result.content[0].text.includes('.ssh'), false);
  assert.doesNotMatch(result.content[0].text, /data:image\/gif;base64/);
  assert.doesNotMatch(result.content[0].text, new RegExp(TINY_GIF_BASE64.slice(0, 16)));
});

test('image_read recursive directory scan reads one nested image when exactly one candidate exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-read-recursive.'));
  const gallery = join(root, 'screens');
  mkdirSync(join(gallery, 'nested'), { recursive: true });
  const second = writePng(join(gallery, 'nested'), 'b-nested.png');
  writeFileSync(join(gallery, 'notes.txt'), 'not an image');
  const calls = [];

  const result = await internals.executeImageRead(
    { directory: gallery, recursive: true },
    undefined,
    {
      cwd: root,
      visionPreflight: async (request) => {
        calls.push(request);
        return {
          images: request.images.map((image) => ({
            label: image.label,
            observed_facts: [`E1: ${image.displayName} was analyzed.`],
            inferences: [],
          })),
        };
      },
    },
    { env: { STRONK_PI_STATE_ROOT: join(root, '.stronk-pi') } },
  );

  const text = result.content[0].text;
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].images.map((image) => image.displayName), ['b-nested.png']);
  assert.equal(calls[0].messages[0].content.filter((part) => part.type === 'image').length, 1);
  assert.match(text, /Image Read complete: analyzed 1 image/);
  assert.equal(text.includes(second), false);
});

test('image_read rejects multiple explicit image paths before vision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-read-multi-paths.'));
  const first = writePng(root, 'first.png');
  const second = writePng(root, 'second.png');
  const calls = [];

  const result = await internals.executeImageRead(
    { paths: [first, second] },
    undefined,
    {
      cwd: root,
      visionPreflight: async (request) => {
        calls.push(request);
        return {
          images: request.images.map((image) => ({
            label: image.label,
            observed_facts: [`E1: ${image.displayName} was analyzed.`],
            inferences: [],
          })),
        };
      },
    },
    { env: { STRONK_PI_STATE_ROOT: join(root, '.stronk-pi') } },
  );

  const text = result.content[0].text;
  assert.equal(calls.length, 0);
  assert.equal(result.isError, true);
  assert.match(text, /^Image Read rejected: image_read reads exactly one image per call/);
  assert.match(text, /received 2 explicit paths/);
  assert.match(text, /Call image_read once per image with one exact path/);
  assert.equal(result.details.failure, 'invalid image_read input');
  assert.equal(text.includes(first), false);
  assert.equal(text.includes(second), false);
  assert.equal(JSON.stringify(result.details).includes(first), false);
  assert.equal(JSON.stringify(result.details).includes(second), false);
});

test('image_read ignores provider summaries for unrequested extra images', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-read-extra-summary.'));
  const first = writePng(root, 'first.png');
  const calls = [];

  const result = await internals.executeImageRead(
    { paths: [first] },
    undefined,
    {
      cwd: root,
      visionPreflight: async (request) => {
        calls.push(request);
        return {
          images: [{
            label: 'image-1',
            observed_facts: ['E1: First image has a dark header.'],
            inferences: ['I1: First image is the baseline based on E1.'],
          }, {
            label: 'image-2',
            observed_facts: ['E1: An unrequested second image was summarized.'],
            inferences: ['I1: This should not be rendered.'],
          }],
        };
      },
    },
    { env: { STRONK_PI_STATE_ROOT: join(root, '.stronk-pi') } },
  );

  const text = result.content[0].text;
  const observedSection = text.split('Observed Facts:')[1].split('Uncertainties And Limits:')[0];
  assert.equal(calls.length, 1);
  assert.equal(calls[0].messages[0].content.filter((part) => part.type === 'image').length, 1);
  assert.match(text, /Vision summaries returned: 2/);
  assert.match(observedSection, /image-1 \(first\.png; image\/png; \d+ bytes\)\n- image-1\.E1: First image has a dark header/);
  assert.doesNotMatch(observedSection, /image-2/);
  assert.doesNotMatch(text, /An unrequested second image was summarized/);
});

test('image_read redacts provider-echoed paths and image data from successful summaries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-read-success-redaction.'));
  const imagePath = writePng(root, 'echoed.png');
  const wrappedGifDataUrl = `data:image/gif;base64,${TINY_GIF_BASE64.slice(0, 16)}\n${TINY_GIF_BASE64.slice(16)}`;

  const result = await internals.executeImageRead(
    { paths: [imagePath] },
    undefined,
    {
      cwd: root,
      visionPreflight: async () => ({
        images: [{
          label: 'image-1',
          observed_facts: [
            `E1: Provider echoed ${imagePath} and data:image/png;base64,${PNG_BASE64}.`,
            `E2: Provider echoed tiny image data ${TINY_GIF_BASE64} and ${wrappedGifDataUrl}.`,
          ],
          visible_text: [{
            id: 'T1',
            text: `Nested echo ${imagePath}`,
            note: `Raw payload ${PNG_BASE64} and tiny ${TINY_GIF_BASE64}`,
            [imagePath]: 'path-shaped provider key',
            [`data:image/png;base64,${PNG_BASE64}`]: 'payload-shaped provider key',
          }, {
            [imagePath]: 'rendered path key',
            [`data:image/png;base64,${PNG_BASE64}`]: 'first colliding rendered payload key',
            [`data:image/png;base64,${PNG_BASE64}AA`]: 'second colliding rendered payload key',
          }, {
            [wrappedGifDataUrl]: 'wrapped tiny rendered payload key',
            [TINY_GIF_BASE64]: 'tiny raw rendered payload key',
          }],
          inferences: [`I1: The echoed path does not belong in model-facing output based on E1.`],
        }],
      }),
    },
    { env: { STRONK_PI_STATE_ROOT: join(root, '.stronk-pi') } },
  );

  const text = result.content[0].text;
  assert.match(text, /image-1\.E1: Provider echoed \[image-1; echoed\.png] and <redacted image data>/);
  assert.match(text, /image-1\.E2: Provider echoed tiny image data <redacted image data> and <redacted image data>/);
  assert.match(text, /Nested echo \[image-1; echoed\.png]/);
  assert.match(text, /Raw payload <redacted image data> and tiny <redacted image data>/);
  assert.match(text, /\[image-1; echoed\.png]=rendered path key/);
  assert.match(text, /<redacted image data>=first colliding rendered payload key/);
  assert.match(text, /<redacted image data>_2=second colliding rendered payload key/);
  assert.match(text, /<redacted image data>=wrapped tiny rendered payload key/);
  assert.match(text, /<redacted image data>_2=tiny raw rendered payload key/);
  assert.equal(text.includes(imagePath), false);
  assert.doesNotMatch(text, /data:image\/png;base64/);
  assert.doesNotMatch(text, new RegExp(PNG_BASE64.slice(0, 24)));
  assert.doesNotMatch(text, /data:image\/gif;base64/);
  assert.doesNotMatch(text, new RegExp(TINY_GIF_BASE64.slice(0, 16)));
});

test('image_read returns bounded failure context without raw provider payloads or paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-read-failure.'));
  const imagePath = writePng(root, 'failure.png');

  const result = await internals.executeImageRead(
    { paths: [imagePath] },
    undefined,
    {
      cwd: root,
      visionPreflight: async () => {
        throw new Error(`provider echoed ${imagePath} and data:image/png;base64,${PNG_BASE64}`);
      },
    },
    { env: { STRONK_PI_STATE_ROOT: join(root, '.stronk-pi') } },
  );

  const text = result.content[0].text;
  assert.match(text, /^Image Read failed with bounded reason: vision provider request failed\./);
  assert.match(text, /Image read status: failed \(vision provider request failed\)/);
  assert.match(text, /<stronk-pi-image-read>/);
  assert.match(text, /<\/stronk-pi-image-read>/);
  assert.doesNotMatch(text, /<stronk-pi-image-vision-preflight>/);
  assert.doesNotMatch(text, /<\/stronk-pi-image-vision-preflight>/);
  assert.doesNotMatch(text, /data:image\/png;base64/);
  assert.doesNotMatch(text, new RegExp(PNG_BASE64.slice(0, 24)));
  assert.equal(text.includes(imagePath), false);
  assert.equal(JSON.stringify(result.details).includes(imagePath), false);
  assert.equal(result.details.failure, 'vision provider request failed');
});

test('text-only image preflight injects structured context and strips raw images', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-preflight.'));
  const imagePath = writePng(root);
  const calls = [];
  const notices = [];

  const result = await withEnv(allowingPromptHookEnv({ STRONK_PI_STATE_ROOT: join(root, '.stronk-pi') }), async () => (
    internals.handleInput(
      {
        text: `What changed in ${imagePath}?`,
        model: 'alibaba-coding/qwen3-coder-plus',
        images: [{ source: { type: 'base64', mediaType: 'image/png', data: PNG_BASE64 } }],
      },
      {
        cwd: root,
        hasUI: true,
        ui: { notify: (message, kind) => notices.push([kind, message]) },
        visionPreflight: async (request) => {
          calls.push(request);
          return {
            images: [
              {
                label: 'image-1',
                observed_facts: ['The screenshot shows a green status indicator.'],
                inferences: ['The workflow likely completed successfully.'],
              },
              {
                label: 'image-2',
                observed_facts: ['A single-pixel PNG was attached.'],
                inferences: ['The attachment is probably a test fixture.'],
              },
            ],
          };
        },
      },
    )
  ));

  assert.equal(result.action, 'transform');
  assert.deepEqual(result.images, []);
  assert.match(result.text, /^What changed in \[image-2; /);
  assert.doesNotMatch(result.text, /analyzed by Stronk Pi image vision preflight/);
  assert.equal(result.text.split('<stronk-pi-image-vision-preflight>')[0].includes(imagePath), false);
  assert.match(result.text, /<stronk-pi-image-vision-preflight>/);
  assert.match(result.text, /Do not call file or image read tools/);
  assert.doesNotMatch(result.text, /summary index/);
  assert.match(result.text, /Observed Facts:/);
  assert.match(result.text, /The screenshot shows a green status indicator/);
  assert.match(result.text, /Inferences And Context:/);
  assert.match(result.text, /workflow likely completed successfully/);
  assert.doesNotMatch(result.text, new RegExp(PNG_BASE64.slice(0, 24)));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'kimi-coding/kimi-for-coding:xhigh');
  assert.equal(calls[0].messages[0].content.filter((part) => part.type === 'image').length, 2);
  assert.deepEqual(notices, [
    ['info', 'Stronk Pi detected 2 images for a text-only model; analyzing with vision preflight.'],
    ['info', 'Image vision preflight complete: analyzed 2 images.'],
  ]);
  const noticeText = notices.map(([_kind, message]) => message).join('\n');
  assert.equal(noticeText.includes(imagePath), false);
  assert.equal(noticeText.includes(PNG_BASE64.slice(0, 24)), false);
});

test('text-only image preflight saves extended session artifact readable by handle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-preflight-artifact.'));
  const stateRoot = join(root, '.stronk-pi');
  const sessionRoot = join(stateRoot, 'agent', 'sessions');
  mkdirSync(sessionRoot, { recursive: true });
  const sessionFile = join(sessionRoot, 'session.jsonl');
  writeFileSync(sessionFile, '{"type":"session"}\n');
  const imagePath = writePng(root, 'artifact-source.png');
  const visibleText = Array.from({ length: 20 }, (_value, index) => (
    index === 19
      ? `E${index + 1}: line ${index + 1} echoes ${imagePath} and data:image/png;base64,${PNG_BASE64}`
      : `E${index + 1}: line ${index + 1} is visible in the document`
  ));

  const result = await withEnv(allowingPromptHookEnv({ STRONK_PI_STATE_ROOT: stateRoot }), async () => (
    internals.handleInput(
      {
        text: `Read ${imagePath}`,
        model: 'neuralwatt/glm-5.2:xhigh',
        sessionId: 'session-artifact-test',
        turnId: 'turn-1',
        transcriptPath: sessionFile,
      },
      {
        cwd: root,
        sessionId: 'session-artifact-test',
        turnId: 'turn-1',
        transcriptPath: sessionFile,
        visionPreflight: async () => ({
          images: [
            {
              label: 'image-1',
              visible_text: visibleText,
              observed_facts: ['E30: The document contains many visible text lines.'],
              inferences: ['I1: The hidden tail matters based on E20 and E30.'],
            },
          ],
        }),
      },
    )
  ));

  assert.equal(result.action, 'transform');
  assert.match(result.text, /<stronk-pi-image-vision-preflight>\nStronk Pi Image Vision Preflight \| model=.* \| analyzed=1\n\nArtifact index only/);
  assert.match(result.text, /Artifact index only/);
  assert.match(result.text, /Do not make visual claims from this block alone/);
  assert.match(result.text, /call image_preflight_read with the handle for the relevant image group/);
  assert.match(result.text, /Artifact Groups: image-1: handle=image-preflight-/);
  assert.match(result.text, /Image Evidence Index: image-1=artifact-source\.png\/png\/[^@\n;]+@image-1/);
  const handle = result.text.match(/handle=(image-preflight-[A-Fa-f0-9-]{36})/)?.[1];
  assert.ok(handle);
  assert.doesNotMatch(result.text, /Summaries:/);
  assert.doesNotMatch(result.text, /omitted=\d+ more in artifact/);
  assert.doesNotMatch(result.text, /The document contains many visible text lines/);
  assert.doesNotMatch(result.text, /image-1\.E\d+/);
  assert.doesNotMatch(result.text, /line 20 echoes/);
  assert.doesNotMatch(result.text, /^\s*-/m);
  assert.doesNotMatch(result.text, /source=/);
  assert.doesNotMatch(result.text, /citation_prefix=/);
  assert.doesNotMatch(result.text, /analyzed by Stronk Pi image vision preflight/);
  assert.equal(result.text.includes(imagePath), false);

  const artifactFile = join(sessionRoot, 'image-preflight', 'session-artifact-test', `${handle}.txt`);
  assert.equal(existsSync(artifactFile), true);
  const readResult = internals.executeImagePreflightRead(
    { handle, max_chars: 60000 },
    undefined,
    { sessionId: 'session-artifact-test', transcriptPath: sessionFile },
    { env: { STRONK_PI_STATE_ROOT: stateRoot } },
  );
  const artifactText = readResult.content[0].text;
  assert.equal(readResult.details.truncated, false);
  assert.equal(readResult.details.groupIndex, 1);
  assert.equal(readResult.details.groupCount, 1);
  assert.equal(readResult.details.imageRange, 'image-1');
  assert.deepEqual(readResult.details.imageLabels, ['image-1']);
  assert.match(artifactText, /Artifact capped: no/);
  assert.match(artifactText, /Image Preflight Artifact Group 1 of 1/);
  assert.match(artifactText, /Images in this handle: image-1/);
  assert.match(artifactText, /line 20 echoes/);
  assert.match(artifactText, /\[image-1; artifact-source\.png]/);
  assert.match(artifactText, /<redacted image data>/);
  assert.doesNotMatch(artifactText, /\+8 additional items omitted by Stronk Pi/);
  assert.equal(artifactText.includes(imagePath), false);
  assert.equal(artifactText.includes(PNG_BASE64.slice(0, 24)), false);
  assert.equal(JSON.stringify(readResult.details).includes(artifactFile), false);

  const denied = internals.executeImagePreflightRead(
    { handle, max_chars: 60000 },
    undefined,
    { sessionId: 'other-session', transcriptPath: sessionFile },
    { env: { STRONK_PI_STATE_ROOT: stateRoot } },
  );
  assert.equal(denied.details.found, false);
  assert.match(denied.content[0].text, /not found for this session/);

  const noSession = internals.executeImagePreflightRead(
    { handle, max_chars: 60000 },
    undefined,
    {},
    { env: { STRONK_PI_STATE_ROOT: stateRoot } },
  );
  assert.equal(noSession.details.found, false);
  assert.match(noSession.content[0].text, /not found for this session/);
});

test('text-only image preflight artifact readback preserves long evidence without truncating saved text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-preflight-artifact-long.'));
  const stateRoot = join(root, '.stronk-pi');
  const sessionRoot = join(stateRoot, 'agent', 'sessions');
  mkdirSync(sessionRoot, { recursive: true });
  const sessionFile = join(sessionRoot, 'session.jsonl');
  writeFileSync(sessionFile, '{"type":"session"}\n');
  const imagePath = writePng(root, 'long-artifact-source.png');
  const longEvidence = `E1: ${'long visible detail '.repeat(700)}complete-tail-marker`;

  const result = await withEnv(allowingPromptHookEnv({ STRONK_PI_STATE_ROOT: stateRoot }), async () => (
    internals.handleInput(
      {
        text: `Read ${imagePath}`,
        model: 'neuralwatt/glm-5.2:xhigh',
        sessionId: 'session-artifact-long-test',
        turnId: 'turn-long',
        transcriptPath: sessionFile,
      },
      {
        cwd: root,
        sessionId: 'session-artifact-long-test',
        turnId: 'turn-long',
        transcriptPath: sessionFile,
        visionPreflight: async () => ({
          images: [
            {
              label: 'image-1',
              inferences: [longEvidence],
            },
          ],
        }),
      },
    )
  ));

  const handle = result.text.match(/handle=(image-preflight-[A-Fa-f0-9-]{36})/)?.[1];
  assert.ok(handle);
  const readResult = internals.executeImagePreflightRead(
    { handle, max_chars: 60000 },
    undefined,
    { sessionId: 'session-artifact-long-test', transcriptPath: sessionFile },
    { env: { STRONK_PI_STATE_ROOT: stateRoot } },
  );
  const artifactText = readResult.content[0].text;
  assert.equal(readResult.details.truncated, false);
  assert.match(artifactText, /Artifact capped: no/);
  assert.match(artifactText, /complete-tail-marker/);
  assert.doesNotMatch(artifactText, /\[truncated by Stronk Pi]/);
});

test('text-only image preflight stores prompt artifacts in three-image handle groups', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-preflight-artifact-groups.'));
  const stateRoot = join(root, '.stronk-pi');
  const sessionRoot = join(stateRoot, 'agent', 'sessions');
  mkdirSync(sessionRoot, { recursive: true });
  const sessionFile = join(sessionRoot, 'session.jsonl');
  writeFileSync(sessionFile, '{"type":"session"}\n');
  const imagePaths = Array.from({ length: 7 }, (_value, index) => writePng(root, `group-${index + 1}.png`));
  const calls = [];

  const result = await withEnv(allowingPromptHookEnv({ STRONK_PI_STATE_ROOT: stateRoot }), async () => (
    internals.handleInput(
      {
        text: `Inspect these screenshots:\n${imagePaths.join('\n')}`,
        model: 'neuralwatt/glm-5.2:xhigh',
        sessionId: 'session-artifact-groups',
        turnId: 'turn-2',
        transcriptPath: sessionFile,
      },
      {
        cwd: root,
        sessionId: 'session-artifact-groups',
        turnId: 'turn-2',
        transcriptPath: sessionFile,
        visionPreflight: async (request) => {
          calls.push(request);
          return {
            images: imagePaths.map((_path, index) => ({
              label: `image-${index + 1}`,
              observed_facts: [`E1: Grouped artifact fact for image ${index + 1}.`],
              inferences: [`I1: Grouped artifact inference for image ${index + 1}.`],
            })),
          };
        },
      },
    )
  ));

  assert.equal(result.action, 'transform');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].messages[0].content.filter((part) => part.type === 'image').length, 7);
  assert.match(result.text, /\| analyzed=7/);
  assert.match(result.text, /Artifact Groups: image-1\.\.image-3: handle=image-preflight-/);
  assert.match(result.text, /image-4\.\.image-6: handle=image-preflight-/);
  assert.match(result.text, /image-7: handle=image-preflight-/);
  assert.match(result.text, /For cross-image claims, read every relevant group/);
  assert.match(result.text, /Image Evidence Index: .*image-1=group-1\.png\/png\/[^;]+@image-1\.\.image-3/);
  assert.match(result.text, /image-7=group-7\.png\/png\/[^;\n]+@image-7/);
  assert.doesNotMatch(result.text, /Grouped artifact fact for image/);
  assert.doesNotMatch(result.text, /image-1\.E1/);
  for (const imagePath of imagePaths) assert.equal(result.text.includes(imagePath), false);

  const handles = [...result.text.matchAll(/handle=(image-preflight-[A-Fa-f0-9-]{36})/g)].map((match) => match[1]);
  assert.equal(handles.length, 3);
  assert.equal(new Set(handles).size, 3);
  for (const handle of handles) {
    assert.equal(existsSync(join(sessionRoot, 'image-preflight', 'session-artifact-groups', `${handle}.txt`)), true);
  }

  const firstRead = internals.executeImagePreflightRead(
    { handle: handles[0], max_chars: 60000 },
    undefined,
    { sessionId: 'session-artifact-groups', transcriptPath: sessionFile },
    { env: { STRONK_PI_STATE_ROOT: stateRoot } },
  );
  assert.equal(firstRead.details.groupIndex, 1);
  assert.equal(firstRead.details.groupCount, 3);
  assert.equal(firstRead.details.imageRange, 'image-1..image-3');
  assert.deepEqual(firstRead.details.imageLabels, ['image-1', 'image-2', 'image-3']);
  assert.match(firstRead.content[0].text, /Image Preflight Artifact Group 1 of 3/);
  assert.match(firstRead.content[0].text, /Images in this handle: image-1, image-2, image-3/);
  assert.match(firstRead.content[0].text, /Sibling groups: image-4\.\.image-6 handle=image-preflight-/);
  assert.match(firstRead.content[0].text, /image-1\.E1/);
  assert.match(firstRead.content[0].text, /Grouped artifact fact for image 3/);
  assert.doesNotMatch(firstRead.content[0].text, /image-4\.E1/);
  assert.doesNotMatch(firstRead.content[0].text, /Grouped artifact fact for image 4/);

  const secondRead = internals.executeImagePreflightRead(
    { handle: handles[1], max_chars: 60000 },
    undefined,
    { sessionId: 'session-artifact-groups', transcriptPath: sessionFile },
    { env: { STRONK_PI_STATE_ROOT: stateRoot } },
  );
  assert.equal(secondRead.details.groupIndex, 2);
  assert.equal(secondRead.details.imageRange, 'image-4..image-6');
  assert.deepEqual(secondRead.details.imageLabels, ['image-4', 'image-5', 'image-6']);
  assert.match(secondRead.content[0].text, /Image Preflight Artifact Group 2 of 3/);
  assert.match(secondRead.content[0].text, /image-4\.E1/);
  assert.match(secondRead.content[0].text, /Grouped artifact fact for image 6/);
  assert.doesNotMatch(secondRead.content[0].text, /^- image-1\.E1:/m);
  assert.equal(JSON.stringify(secondRead.details).includes(sessionRoot), false);
});

test('text-only image preflight retries timed-out multi-image requests as smaller batches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-preflight-timeout-batches.'));
  const stateRoot = join(root, '.stronk-pi');
  const sessionRoot = join(stateRoot, 'agent', 'sessions');
  mkdirSync(sessionRoot, { recursive: true });
  const sessionFile = join(sessionRoot, 'session.jsonl');
  writeFileSync(sessionFile, '{"type":"session"}\n');
  const imagePaths = [
    writePng(root, 'timeout-one.png'),
    writePng(root, 'timeout-two.png'),
    writePng(root, 'timeout-three.png'),
  ];
  const calls = [];

  const result = await withEnv(allowingPromptHookEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_IMAGE_PREFLIGHT_TIMEOUT_MS: '1000',
  }), async () => (
    internals.handleInput(
      {
        text: `What do you see?\n${imagePaths.join('\n')}`,
        model: 'neuralwatt/glm-5.2:xhigh',
        sessionId: 'session-timeout-batches',
        turnId: 'turn-timeout',
        transcriptPath: sessionFile,
      },
      {
        cwd: root,
        sessionId: 'session-timeout-batches',
        turnId: 'turn-timeout',
        transcriptPath: sessionFile,
        visionPreflight: async (request) => {
          const labels = request.images.map((image) => image.label);
          calls.push(labels);
          if (labels.length > 1) {
            return new Promise((_resolve, reject) => {
              request.signal?.addEventListener?.('abort', () => {
                reject(request.signal.reason instanceof Error ? request.signal.reason : new Error('vision preflight aborted'));
              }, { once: true });
            });
          }
          return {
            images: [{
              label: 'image-1',
              observed_facts: [`image-1.E1: Recovered timeout fallback for ${labels[0]}.`],
              inferences: [`image-1.I1: ${labels[0]} recovered after the batch timeout based on image-1.E1.`],
            }],
          };
        },
      },
    )
  ));

  assert.equal(result.action, 'transform');
  assert.deepEqual(calls, [['image-1', 'image-2', 'image-3'], ['image-1'], ['image-2'], ['image-3']]);
  assert.doesNotMatch(result.text, /Preflight status: failed/);
  assert.match(result.text, /Stronk Pi Image Vision Preflight \| model=.* \| analyzed=3/);
  assert.match(result.text, /Artifact Groups: image-1\.\.image-3: handle=image-preflight-/);
  for (const imagePath of imagePaths) assert.equal(result.text.includes(imagePath), false);

  const handle = result.text.match(/handle=(image-preflight-[A-Fa-f0-9-]{36})/)?.[1];
  assert.ok(handle);
  assert.equal(existsSync(join(sessionRoot, 'image-preflight', 'session-timeout-batches', `${handle}.txt`)), true);
  const read = internals.executeImagePreflightRead(
    { handle, max_chars: 60000 },
    undefined,
    { sessionId: 'session-timeout-batches', transcriptPath: sessionFile },
    { env: { STRONK_PI_STATE_ROOT: stateRoot } },
  );
  assert.match(read.content[0].text, /image-1\.E1: Recovered timeout fallback for image-1/);
  assert.match(read.content[0].text, /image-2\.E1: Recovered timeout fallback for image-2/);
  assert.match(read.content[0].text, /image-3\.E1: Recovered timeout fallback for image-3/);
});

test('image preflight artifact session segments reject path metasegments', () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-preflight-session-segment.'));
  const stateRoot = join(root, '.stronk-pi');
  const transcriptOnlyContext = internals.imagePreflightSessionContext(
    { transcriptPath: join(stateRoot, 'agent', 'sessions', 'session.with.dots.jsonl') },
    {},
    { env: { STRONK_PI_STATE_ROOT: stateRoot } },
  );
  assert.equal(transcriptOnlyContext.hasSessionBinding, true);
  assert.equal(transcriptOnlyContext.sessionId, 'session.with.dots');
  assert.equal(transcriptOnlyContext.sessionSegment, 'session_with_dots');

  for (const sessionId of ['.', '..', '../outside', 'session:with.dots']) {
    const context = internals.imagePreflightSessionContext(
      { sessionId },
      {},
      { env: { STRONK_PI_STATE_ROOT: stateRoot } },
    );
    assert.notEqual(context.sessionSegment, '.');
    assert.notEqual(context.sessionSegment, '..');
    assert.doesNotMatch(context.sessionSegment, /[.:/\\]/);
  }
});

test('text-only image preflight accepts twelve images in one request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-preflight-twelve.'));
  const imagePaths = Array.from({ length: 12 }, (_value, index) => writePng(root, `image-${String(index + 1).padStart(2, '0')}.png`));
  const calls = [];
  const notices = [];

  const result = await withEnv(allowingPromptHookEnv({ STRONK_PI_STATE_ROOT: join(root, '.stronk-pi') }), async () => (
    internals.handleInput(
      {
        text: `Compare these images:\n${imagePaths.join('\n')}`,
        model: 'alibaba-coding/qwen3-coder-plus',
      },
      {
        cwd: root,
        hasUI: true,
        ui: { notify: (message, kind) => notices.push([kind, message]) },
        visionPreflight: async (request) => {
          calls.push(request);
          return {
            images: imagePaths.map((_path, index) => ({
              label: `image-${index + 1}`,
              observed_facts: [`Image ${index + 1} was analyzed.`],
              inferences: [`Image ${index + 1} has a bounded summary.`],
            })),
          };
        },
      },
    )
  ));

  assert.equal(result.action, 'transform');
  assert.equal(result.images, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxOutputTokens, 4096 * 12);
  assert.equal(calls[0].messages[0].content.filter((part) => part.type === 'image').length, 12);
  assert.deepEqual(calls[0].images.map((image) => image.label), imagePaths.map((_path, index) => `image-${index + 1}`));
  assert.match(result.text, /Images analyzed: 12/);
  assert.match(result.text, /Image 12 was analyzed/);
  assert.doesNotMatch(result.text, /Skipped Images:/);
  for (const imagePath of imagePaths) assert.equal(result.text.includes(imagePath), false);
  assert.deepEqual(notices, [
    ['info', 'Stronk Pi detected 12 images for a text-only model; analyzing with vision preflight.'],
    ['info', 'Image vision preflight complete: analyzed 12 images.'],
  ]);
});

test('image preflight prompt asks for universal evidence-rich structured context', () => {
  const request = internals.buildVisionRequest(
    [
      {
        label: 'image-1',
        displayName: 'dashboard.png',
        origin: 'event.text[0]',
        mediaType: 'image/png',
        byteLength: 1234,
        contentPart: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } },
      },
    ],
    { model: 'vision-provider/vision-large', maxOutputTokens: 4096 },
    { text: 'Review this dashboard screenshot.' },
  );

  assert.equal(request.model, 'vision-provider/vision-large');
  assert.match(request.systemPrompt, /evidence-rich context/);
  assert.match(request.systemPrompt, /Turn any supplied image/);
  assert.match(request.systemPrompt, /image_type/);
  assert.match(request.systemPrompt, /image-1\.E1/);
  assert.match(request.systemPrompt, /<label>\.E#/);
  assert.match(request.systemPrompt, /scene_and_composition/);
  assert.match(request.systemPrompt, /subjects_and_entities/);
  assert.match(request.systemPrompt, /structured_content/);
  assert.match(request.systemPrompt, /domain_specific_details/);
  assert.match(request.systemPrompt, /Do not force every image into a UI or screenshot schema/);
  assert.match(request.systemPrompt, /visible_text/);
  assert.match(request.systemPrompt, /negative_evidence/);
  assert.match(request.systemPrompt, /For photos, preserve subjects, setting, composition/);
  assert.match(request.systemPrompt, /For documents, screenshots, charts, diagrams, maps, code, or terminal images/);
  assert.match(request.systemPrompt, /Never say something is absent or missing/);
  assert.match(request.messages[0].content[0].text, /downstream text-only model can answer/);
  assert.match(request.messages[0].content[0].text, /Use the labels from the image inventory exactly/);
});

test('image preflight renders rich evidence schema and overclaim guardrails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-rich-schema.'));
  const imagePath = writePng(root);

  const result = await withEnv(allowingPromptHookEnv({ STRONK_PI_STATE_ROOT: join(root, '.stronk-pi') }), async () => (
    internals.handleInput(
      {
        text: `Critique this UI screenshot ${imagePath}`,
        model: 'neuralwatt/glm-5.2:xhigh',
      },
      {
        cwd: root,
        visionPreflight: async () => ({
          images: [
            {
              label: 'image-1',
              overview: 'A Chinese-language issue tracker screen is visible.',
              quality_flags: ['E1: Text is mostly legible; screenshot is a cropped desktop viewport.'],
              layout: [
                { id: 'E2', observation: 'A left navigation rail and a central issue-list area are visible.', location: 'full viewport', confidence: 'high' },
              ],
              visible_text: [
                { id: 'E3', text: '问题, 搜索, 通知, 新问题, 打开 19, 已关闭 3', location: 'navigation and list header', confidence: 'high' },
              ],
              ui_elements: [
                { id: 'E4', role: 'button', label: '+ 新问题', location: 'top right', state: 'enabled', confidence: 'high' },
              ],
              data_entities: ['E5: Visible issue ids include ISS-00022 through ISS-00008.'],
              counts_and_density: [
                { id: 'E6', observation: 'About 15 issue rows are visible in the central list area.', confidence: 'medium' },
              ],
              observed_facts: [
                'E7: Colored issue tags are visible, including 异常 and 高优先级.',
              ],
              uncertainties: [
                'U1: It is unclear whether the list uses cards or strict table rows because column boundaries are not explicit.',
              ],
              negative_evidence: [
                { id: 'N1', claim: 'priority column', scope: 'visible list header only', status: 'not visible', note: 'Do not claim the product lacks priority data.' },
              ],
              inferences: [
                'I1: This is likely an issue-management UI based on E2, E3, and E5.',
              ],
              guardrails: [
                'Do not call the UI low-density without citing E6 or comparable spacing evidence.',
              ],
            },
          ],
        }),
      },
    )
  ));

  assert.equal(result.action, 'transform');
  assert.match(result.text, /Evidence rule: omitted, unknown, unreadable, cropped, or not-visible details are unavailable, not absent/);
  assert.match(result.text, /Overview:/);
  assert.match(result.text, /A Chinese-language issue tracker screen is visible/);
  assert.match(result.text, /Image Type, Quality, And Scope:/);
  assert.match(result.text, /Scene And Composition:/);
  assert.match(result.text, /Visible Text And Symbols:/);
  assert.match(result.text, /问题, 搜索, 通知, 新问题/);
  assert.match(result.text, /Domain-Specific Details:/);
  assert.match(result.text, /image-1\.E4: \+ 新问题 \(role=button; location=top right; state=enabled; confidence=high\)/);
  assert.match(result.text, /Attributes, Counts, And State:/);
  assert.match(result.text, /About 15 issue rows are visible/);
  assert.match(result.text, /Uncertainties And Limits:/);
  assert.match(result.text, /Scoped Negative Evidence:/);
  assert.match(result.text, /image-1\.N1: priority column \(scope=visible list header only; status=not visible; note=Do not claim the product lacks priority data\.\)/);
  assert.match(result.text, /Guardrails For Text-Only Model:/);
  assert.doesNotMatch(result.text, /\[object Object]/);
  assert.equal(result.images?.length ?? 0, 0);
});

test('image preflight renders universal photo and structured document evidence', () => {
  const context = internals.renderVisionContext({
    config: { model: 'vision-provider/vision-large' },
    images: [
      {
        label: 'image-1',
        displayName: 'street-food-photo.png',
        origin: 'event.images[0]',
        mediaType: 'image/png',
        byteLength: 1234,
      },
      {
        label: 'image-2',
        displayName: 'quarterly-chart.png',
        origin: 'event.images[1]',
        mediaType: 'image/png',
        byteLength: 2345,
      },
    ],
    summaryImages: [
      {
        label: 'image-1',
        image_type: 'photo',
        overview: 'A close photo shows a plated meal on a table with utensils nearby.',
        scene_and_composition: [
          'E1: The plate is centered in the frame with a tabletop filling the background.',
        ],
        subjects_and_entities: [
          { id: 'E2', observation: 'A round plate holds several browned bread pieces.', location: 'center', confidence: 'high' },
        ],
        attributes_and_state: [
          'E3: The food appears golden-brown with darker toasted spots.',
        ],
        spatial_relationships: [
          'E4: A fork sits to the left of the plate and a glass is behind it.',
        ],
        observed_facts: [
          'E5: No visible packaging or recipe text is present in the frame.',
        ],
        uncertainties: [
          'U1: The exact filling or ingredients are not visible from the outside.',
        ],
        inferences: [
          'I1: The meal may be baked or toasted based on E3.',
        ],
      },
      {
        label: 'image-2',
        image_type: 'chart/document',
        overview: 'A report page contains a quarterly revenue bar chart and a short note.',
        visible_text: [
          'E10: Visible title text reads "Q2 Revenue by Region".',
        ],
        structured_content: [
          { id: 'E11', observation: 'A vertical bar chart compares APAC, EMEA, and Americas.', confidence: 'high' },
          { id: 'E12', observation: 'The tallest visible bar is labeled APAC.', evidence: 'E10,E11' },
        ],
        domain_specific_details: [
          'E13: The chart has a y-axis with currency-like tick labels, but exact values are small.',
        ],
        uncertainties: [
          'U2: The smallest y-axis tick labels are not readable.',
        ],
        negative_evidence: [
          { id: 'N1', claim: 'line chart', scope: 'visible chart area', status: 'not visible', note: 'Only bars are visible.' },
        ],
        inferences: [
          'I2: The page likely summarizes regional sales performance based on E10 and E11.',
        ],
      },
    ],
  });

  assert.match(context, /Image Type, Quality, And Scope:/);
  assert.match(context, /photo/);
  assert.match(context, /chart\/document/);
  assert.match(context, /Scene And Composition:/);
  assert.match(context, /The plate is centered/);
  assert.match(context, /Subjects, Objects, And Entities:/);
  assert.match(context, /image-1\.E2: A round plate holds several browned bread pieces/);
  assert.match(context, /Attributes, Counts, And State:/);
  assert.match(context, /golden-brown/);
  assert.match(context, /Relationships And Activity:/);
  assert.match(context, /A fork sits to the left/);
  assert.match(context, /Visible Text And Symbols:/);
  assert.match(context, /Q2 Revenue by Region/);
  assert.match(context, /Structured Content And Data:/);
  assert.match(context, /vertical bar chart compares APAC/);
  assert.match(context, /Domain-Specific Details:/);
  assert.match(context, /currency-like tick labels/);
  assert.match(context, /Scoped Negative Evidence:/);
  assert.match(context, /image-2\.N1: line chart \(scope=visible chart area; status=not visible; note=Only bars are visible\.\)/);
  assert.match(context, /Inferences And Context:/);
  assert.match(context, /image-1\.I1: The meal may be baked or toasted based on image-1\.E3/);
  assert.match(context, /image-2\.E12: The tallest visible bar is labeled APAC\. \(evidence=image-2\.E10,image-2\.E11\)/);
  assert.doesNotMatch(context, /UI Elements And Data:/);
  assert.doesNotMatch(context, /\[object Object]/);
});

test('image preflight renders duplicate evidence ids as image-scoped citations', () => {
  const context = internals.renderVisionContext({
    config: { model: 'vision-provider/vision-large' },
    images: [
      {
        label: 'image-1',
        displayName: 'before.png',
        origin: 'event.images[0]',
        mediaType: 'image/png',
        byteLength: 111,
      },
      {
        label: 'image-2',
        displayName: 'after.png',
        origin: 'event.images[1]',
        mediaType: 'image/png',
        byteLength: 222,
      },
    ],
    summaryImages: [
      {
        label: 'image-1',
        observed_facts: [
          'E1: A dark dashboard header is visible.',
          { id: 'E2', observation: 'A blue action button appears on the right.' },
        ],
        uncertainties: ['U1: The small status text is not readable.'],
        inferences: ['I1: The screen is likely a dashboard based on E1 and E2.'],
      },
      {
        label: 'image-2',
        observed_facts: [
          'E1: A light dashboard header is visible.',
          { id: 'E2', observation: 'A green confirmation banner appears below the header.' },
        ],
        negative_evidence: [{ id: 'N1', claim: 'error banner', scope: 'visible viewport', status: 'not visible' }],
        inferences: ['I1: The workflow may have succeeded based on E2 and N1.'],
      },
    ],
  });

  assert.match(context, /Evidence IDs are image-scoped/);
  assert.match(context, /Image Evidence Index:/);
  assert.match(context, /image-1: before\.png; source=event\.images\[0]; mime=image\/png; bytes=111; citation_prefix=image-1\./);
  assert.match(context, /image-2: after\.png; source=event\.images\[1]; mime=image\/png; bytes=222; citation_prefix=image-2\./);
  assert.match(context, /image-1\.E1: A dark dashboard header is visible/);
  assert.match(context, /image-1\.E2: A blue action button appears on the right/);
  assert.match(context, /image-1\.U1: The small status text is not readable/);
  assert.match(context, /image-1\.I1: The screen is likely a dashboard based on image-1\.E1 and image-1\.E2/);
  assert.match(context, /image-2\.E1: A light dashboard header is visible/);
  assert.match(context, /image-2\.E2: A green confirmation banner appears below the header/);
  assert.match(context, /image-2\.N1: error banner \(scope=visible viewport; status=not visible\)/);
  assert.match(context, /image-2\.I1: The workflow may have succeeded based on image-2\.E2 and image-2\.N1/);
  assert.doesNotMatch(context, /- E1: A dark dashboard/);
  assert.doesNotMatch(context, /based on E1 and E2/);
});

test('image preflight preserves already scoped cross-image evidence references', () => {
  const context = internals.renderVisionContext({
    config: { model: 'vision-provider/vision-large' },
    images: [
      {
        label: 'image-1',
        displayName: 'baseline.png',
        origin: 'event.text[0]',
        mediaType: 'image/png',
        byteLength: 333,
      },
      {
        label: 'image-2',
        displayName: 'candidate.png',
        origin: 'event.text[1]',
        mediaType: 'image/png',
        byteLength: 444,
      },
    ],
    summaryImages: [
      {
        label: 'image-1',
        observed_facts: ['image-1.E1: The baseline chart has a blue line.'],
        inferences: ['image-1.I1: The candidate may differ because image-2.E1 shows a green line.'],
      },
      {
        label: 'image-2',
        observed_facts: ['image-2.E1: The candidate chart has a green line.'],
        inferences: ['image-2.I1: This should be compared against image-1.E1.'],
      },
    ],
  });

  assert.match(context, /image-1\.E1: The baseline chart has a blue line/);
  assert.match(context, /image-1\.I1: The candidate may differ because image-2\.E1 shows a green line/);
  assert.match(context, /image-2\.E1: The candidate chart has a green line/);
  assert.match(context, /image-2\.I1: This should be compared against image-1\.E1/);
  assert.doesNotMatch(context, /image-1\.image-1\.E1/);
  assert.doesNotMatch(context, /image-1\.image-2\.E1/);
  assert.doesNotMatch(context, /image-2\.image-1\.E1/);
  assert.doesNotMatch(context, /image-2\.image-2\.E1/);
});

test('image preflight retargets provider evidence ids to the current image section', () => {
  const context = internals.renderVisionContext({
    config: { model: 'vision-provider/vision-large' },
    images: [
      {
        label: 'image-1',
        displayName: 'first.png',
        origin: 'event.text[0]',
        mediaType: 'image/png',
        byteLength: 111,
      },
      {
        label: 'image-2',
        displayName: 'second.png',
        origin: 'event.text[1]',
        mediaType: 'image/png',
        byteLength: 222,
      },
    ],
    summaryImages: [
      {
        label: 'image-1',
        observed_facts: ['image-1.E1: The first screenshot shows a setup command.'],
      },
      {
        label: 'image-2',
        structured_content: [
          'image-1.E1: The second screenshot shows a music search page.',
          { id: 'image-1.E2', observation: 'The second screenshot contains a road at sunset.', evidence: 'image-1.E1' },
        ],
        inferences: [
          'image-1.I1: The second screenshot is likely a music video page based on image-1.E1 and image-1.E2.',
          'image-2.I2: This should still compare against image-1.E1 when the leading id is correct.',
        ],
      },
    ],
  });

  const image2Structured = context.split('Structured Content And Data:')[1].split('Domain-Specific Details:')[0];
  const image2Inference = context.split('Inferences And Context:')[1].split('Guardrails For Text-Only Model:')[0];
  assert.match(image2Structured, /image-2\.E1: The second screenshot shows a music search page/);
  assert.match(image2Structured, /image-2\.E2: The second screenshot contains a road at sunset\. \(evidence=image-2\.E1\)/);
  assert.match(image2Inference, /image-2\.I1: The second screenshot is likely a music video page based on image-2\.E1 and image-2\.E2/);
  assert.match(image2Inference, /image-2\.I2: This should still compare against image-1\.E1 when the leading id is correct/);
  assert.doesNotMatch(image2Structured, /image-1\.E1: The second screenshot/);
});

test('image preflight preserves literal OCR evidence-like text while scoping citations', () => {
  const context = internals.renderVisionContext({
    config: { model: 'vision-provider/vision-large' },
    images: [
      {
        label: 'image-1',
        displayName: 'label.png',
        origin: 'event.images[0]',
        mediaType: 'image/png',
        byteLength: 555,
      },
    ],
    summaryImages: [
      {
        label: 'image-1',
        visible_text: ['E1: Visible label literally reads "E2" and the status text says N1.'],
        structured_content: [
          { id: 'E2', observation: 'A table cell literally contains key E3.', evidence: 'E1,N1' },
        ],
        inferences: ['I1: The literal label is relevant based on E1 and E2.'],
      },
    ],
  });

  const visibleTextSection = context.split('Visible Text And Symbols:')[1].split('Structured Content And Data:')[0];
  const structuredSection = context.split('Structured Content And Data:')[1].split('Domain-Specific Details:')[0];
  const inferenceSection = context.split('Inferences And Context:')[1].split('Guardrails For Text-Only Model:')[0];
  assert.match(visibleTextSection, /image-1\.E1: Visible label literally reads "E2" and the status text says N1\./);
  assert.doesNotMatch(visibleTextSection, /image-1\.E2/);
  assert.doesNotMatch(visibleTextSection, /image-1\.N1/);
  assert.match(structuredSection, /image-1\.E2: A table cell literally contains key E3\. \(evidence=image-1\.E1,image-1\.N1\)/);
  assert.doesNotMatch(structuredSection, /image-1\.E3/);
  assert.match(inferenceSection, /image-1\.I1: The literal label is relevant based on image-1\.E1 and image-1\.E2/);
});

test('image preflight keeps partial summaries traceable and does not reuse mismatched labels', () => {
  const context = internals.renderVisionContext({
    config: { model: 'vision-provider/vision-large' },
    images: [
      {
        label: 'image-1',
        displayName: 'first.png',
        origin: 'event.images[0]',
        mediaType: 'image/png',
        byteLength: 111,
      },
      {
        label: 'image-2',
        displayName: 'second.png',
        origin: 'event.images[1]',
        mediaType: 'image/png',
        byteLength: 222,
      },
    ],
    summaryImages: [
      {
        label: 'image-1',
        observed_facts: ['E1: First image has a dark header.'],
        inferences: ['I1: First image is the baseline based on E1.'],
      },
    ],
  });

  const observedSection = context.split('Observed Facts:')[1].split('Uncertainties And Limits:')[0];
  assert.match(context, /Images analyzed: 2/);
  assert.match(context, /Vision summaries returned: 1/);
  assert.match(observedSection, /image-1 \(first\.png; image\/png; 111 bytes\)\n- image-1\.E1: First image has a dark header/);
  assert.match(observedSection, /image-2 \(second\.png; image\/png; 222 bytes\)\n- No structured observed facts were returned\./);
  assert.doesNotMatch(observedSection, /image-2\.E1: First image has a dark header/);
});

test('image preflight redacts skipped pasted image paths in transformed text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-skipped-redact.'));
  const notImagePath = join(root, 'not-image.png');
  writeFileSync(notImagePath, 'not actually an image');
  let called = false;

  const result = await withEnv(allowingPromptHookEnv({ STRONK_PI_STATE_ROOT: join(root, '.stronk-pi') }), async () => internals.handleInput(
    {
      text: `Please inspect ${notImagePath}`,
      model: 'neuralwatt/glm-5.2:xhigh',
    },
    {
      cwd: root,
      visionPreflight: async () => {
        called = true;
      },
    },
  ));

  assert.equal(called, false);
  assert.equal(result.action, 'transform');
  assert.equal(result.text.includes(notImagePath), false);
  assert.match(result.text, /\[event\.text\[0]; not-image\.png; skipped]/);
  assert.match(result.text, /Skipped Images:\n- not-image\.png: unsupported MIME type image\/png/);
});

test('image preflight sanitizes path attachments before vision and downstream prompts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-path-attachment.'));
  const imagePath = writePng(root, 'attached.png');
  const calls = [];

  const result = await withEnv(allowingPromptHookEnv({ STRONK_PI_STATE_ROOT: join(root, '.stronk-pi') }), async () => internals.handleInput(
    {
      text: `Describe ${imagePath}`,
      model: 'neuralwatt/glm-5.2:xhigh',
      images: [{ path: imagePath }],
    },
    {
      cwd: root,
      visionPreflight: async (request) => {
        calls.push(request);
        return {
          images: [{
            label: 'image-1',
            observed_facts: ['E1: The path attachment was analyzed.'],
            inferences: ['I1: The image was routed through vision preflight based on E1.'],
          }],
        };
      },
    },
  ));

  assert.equal(result.action, 'transform');
  assert.deepEqual(result.images, []);
  assert.equal(result.text.includes(imagePath), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].messages[0].content[0].text.includes(imagePath), false);
  assert.equal(JSON.stringify(calls[0].images).includes(imagePath), false);
  assert.equal(JSON.stringify(calls[0].images).includes('pathAliases'), false);
  assert.match(calls[0].messages[0].content[0].text, /\[image-1; attached\.png]/);
  assert.match(result.text, /image-1\.E1: The path attachment was analyzed/);
  assert.match(result.text, /image-1\.I1: The image was routed through vision preflight based on image-1\.E1/);
});

test('image preflight status messages are bounded and classify safe failure reasons', () => {
  assert.equal(
    internals.formatImagePreflightStatus({ phase: 'failed', reason: 'vision provider kimi-coding returned HTTP 401: Invalid Authentication', failureMode: 'soft' }),
    'Image vision preflight failed: missing vision model credentials; using a failure note instead of raw images.',
  );
  assert.equal(
    internals.formatImagePreflightStatus({ phase: 'complete', imageCount: 1, skippedCount: 2 }),
    'Image vision preflight complete: analyzed 1 image; skipped 2 images.',
  );
  assert.equal(
    internals.safeImagePreflightFailureReason('super secret provider body with /private/tmp/image.png'),
    'vision provider request failed',
  );
});

test('image preflight animated widget advances frames and disposes its timer', async () => {
  let renders = 0;
  const widgetFactory = internals.createImagePreflightWidget({ imageCount: 3 });
  const widget = widgetFactory(
    { requestRender: () => { renders += 1; } },
    { fg: (_key, text) => text },
  );

  assert.match(widget.render(80).join('\n'), /^\| Analyzing 3 images with vision preflight$/);
  await sleep(150);
  assert.ok(renders > 0);
  assert.match(widget.render(80).join('\n'), /Analyzing 3 images with vision preflight/);

  widget.dispose();
  const afterDispose = renders;
  await sleep(150);
  assert.equal(renders, afterDispose);
});

test('image preflight uses TUI status and animated widget during analysis and restores them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-preflight-ui.'));
  const imagePath = writePng(root);
  const events = [];
  let widget;

  const ui = {
    notify: (message, kind) => events.push(['notify', kind, message]),
    setStatus: (key, text) => events.push(['status', key, text]),
    setWidget: (key, content, options) => {
      events.push(['widget', key, typeof content, options]);
      if (typeof content === 'function') {
        widget = content(
          { requestRender: () => events.push(['widgetRender']) },
          { fg: (_key, text) => text },
        );
      } else if (widget?.dispose) {
        widget.dispose();
        widget = undefined;
      }
    },
  };

  const result = await withEnv(allowingPromptHookEnv({ STRONK_PI_STATE_ROOT: join(root, '.stronk-pi') }), async () => (
    internals.handleInput(
      {
        text: `What changed in ${imagePath}?`,
        model: 'alibaba-coding/qwen3-coder-plus',
      },
      {
        cwd: root,
        mode: 'tui',
        hasUI: true,
        ui,
        visionPreflight: async () => {
          assert.match(widget.render(80).join('\n'), /Analyzing 1 image with vision preflight/);
          return {
            images: [{
              label: 'image-1',
              observed_facts: ['The UI loading indicator test image was analyzed.'],
              inferences: ['The TUI feedback path is active.'],
            }],
          };
        },
      },
    )
  ));

  assert.equal(result.action, 'transform');
  assert.match(result.text, /The UI loading indicator test image was analyzed/);
  assert.deepEqual(events.filter((event) => event[0] === 'notify'), [
    ['notify', 'info', 'Stronk Pi detected 1 image for a text-only model; analyzing with vision preflight.'],
    ['notify', 'info', 'Image vision preflight complete: analyzed 1 image.'],
  ]);
  assert.deepEqual(events.filter((event) => event[0] === 'status'), [
    ['status', 'stronk-pi-image-vision-preflight', 'image vision: Analyzing 1 image with vision preflight'],
    ['status', 'stronk-pi-image-vision-preflight', undefined],
  ]);
  assert.equal(events.some((event) => event[0] === 'widget' && event[2] === 'function'), true);
  assert.equal(events.some((event) => event[0] === 'widget' && event[2] === 'undefined'), true);
  assert.equal(widget, undefined);
});

test('image preflight does not mutate shared TUI working loader customization', () => {
  const events = [];
  const ui = {
    notify: (message, kind) => events.push(['notify', kind, message]),
    setStatus: (key, text) => events.push(['status', key, text]),
    setWorkingMessage: (message) => events.push(['workingMessage', message]),
    setWorkingIndicator: (options) => events.push(['workingIndicator', options]),
    setWidget: (key, content, options) => events.push(['widget', key, typeof content, options]),
  };

  internals.notifyImagePreflightStatus(
    { hasUI: true, mode: 'tui', ui },
    { phase: 'analyzing', imageCount: 1 },
  );
  internals.notifyImagePreflightStatus(
    { hasUI: true, mode: 'tui', ui },
    { phase: 'failed', imageCount: 1, reason: 'mock vision outage', failureMode: 'soft' },
  );

  assert.deepEqual(events.filter((event) => event[0] === 'workingMessage'), []);
  assert.deepEqual(events.filter((event) => event[0] === 'workingIndicator'), []);
  assert.deepEqual(events.filter((event) => event[0] === 'status'), [
    ['status', 'stronk-pi-image-vision-preflight', 'image vision: Analyzing 1 image with vision preflight'],
    ['status', 'stronk-pi-image-vision-preflight', undefined],
  ]);
  assert.equal(events.some((event) => event[0] === 'widget' && event[2] === 'function'), true);
  assert.equal(events.some((event) => event[0] === 'widget' && event[2] === 'undefined'), true);
});

test('image preflight avoids TUI-only widget factories in RPC mode', () => {
  const events = [];
  const ui = {
    notify: (message, kind) => events.push(['notify', kind, message]),
    setStatus: (key, text) => events.push(['status', key, text]),
    setWorkingMessage: (message) => events.push(['workingMessage', message]),
    setWorkingIndicator: (options) => events.push(['workingIndicator', options]),
    setWidget: (key, content, options) => events.push(['widget', key, typeof content, options]),
  };

  internals.notifyImagePreflightStatus(
    { hasUI: true, mode: 'rpc', ui },
    { phase: 'analyzing', imageCount: 1 },
  );
  internals.notifyImagePreflightStatus(
    { hasUI: true, mode: 'rpc', ui },
    { phase: 'complete', imageCount: 1 },
  );

  assert.deepEqual(events, [
    ['status', 'stronk-pi-image-vision-preflight', 'image vision: Analyzing 1 image with vision preflight'],
    ['notify', 'info', 'Stronk Pi detected 1 image for a text-only model; analyzing with vision preflight.'],
    ['status', 'stronk-pi-image-vision-preflight', undefined],
    ['notify', 'info', 'Image vision preflight complete: analyzed 1 image.'],
  ]);
});

test('image preflight rewrites duplicate path aliases for one analyzed image', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-aliases.'));
  const imagePath = realpathSync(writePng(root));
  const aliasPath = join(root, 'alias.png');
  symlinkSync(imagePath, aliasPath);
  const calls = [];

  const result = await withEnv(allowingPromptHookEnv({ STRONK_PI_STATE_ROOT: join(root, '.stronk-pi') }), async () => (
    internals.handleInput(
      {
        text: `Compare ${imagePath} with ${aliasPath}.`,
        model: 'neuralwatt/glm-5.2:xhigh',
      },
      {
        cwd: root,
        visionPreflight: async (request) => {
          calls.push(request);
          return {
            images: [{
              label: 'image-1',
              observed_facts: ['The aliased image is a test PNG.'],
              inferences: ['Both paths refer to the same analyzed image.'],
            }],
          };
        },
      },
    )
  ));

  assert.equal(result.action, 'transform');
  const prefix = result.text.split('<stronk-pi-image-vision-preflight>')[0];
  assert.equal(prefix.includes(imagePath), false);
  assert.equal(prefix.includes(aliasPath), false);
  assert.match(prefix, /\[image-1; .*]/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].messages[0].content.filter((part) => part.type === 'image').length, 1);
});

test('image preflight normalizes fenced JSON vision responses', () => {
  const summary = internals.normalizeVisionSummary({
    content: [
      {
        type: 'text',
        text: [
          '```json',
          '{"images":[{"label":"image-1","observed_facts":["A terminal screenshot is visible."],"inferences":["The screenshot likely shows a validation run."]}]}',
          '```',
        ].join('\n'),
      },
    ],
  });

  assert.equal(summary.length, 1);
  assert.deepEqual(summary[0].observed_facts, ['A terminal screenshot is visible.']);
  assert.deepEqual(summary[0].inferences, ['The screenshot likely shows a validation run.']);
});

test('image preflight keeps singular uncertainty separate from inference', () => {
  const parsed = internals.normalizeVisionSummary({
    content: [
      {
        type: 'text',
        text: [
          'Observed Facts:',
          '- E1: A cropped product photo is visible.',
          'Uncertainty:',
          '- U1: The product label is unreadable.',
          'Inference:',
          '- I1: The product may be a packaged snack based on E1.',
        ].join('\n'),
      },
    ],
  });

  assert.deepEqual(parsed[0].observed_facts, ['E1: A cropped product photo is visible.']);
  assert.deepEqual(parsed[0].uncertainties, ['U1: The product label is unreadable.']);
  assert.deepEqual(parsed[0].inferences, ['I1: The product may be a packaged snack based on E1.']);

  const context = internals.renderVisionContext({
    config: { model: 'vision-provider/vision-large' },
    images: [
      {
        label: 'image-1',
        displayName: 'product.png',
        origin: 'event.images[0]',
        mediaType: 'image/png',
        byteLength: 4567,
      },
    ],
    summaryImages: [
      {
        label: 'image-1',
        uncertainty: 'U2: The small print on the package is too blurry to read.',
        inference: 'I2: The package appears unopened based on visible seams.',
      },
    ],
  });
  const uncertaintySection = context.split('Uncertainties And Limits:')[1].split('Inferences And Context:')[0];
  const inferenceSection = context.split('Inferences And Context:')[1].split('Guardrails For Text-Only Model:')[0];
  assert.match(uncertaintySection, /U2: The small print on the package is too blurry to read/);
  assert.doesNotMatch(inferenceSection, /U2:/);
  assert.match(inferenceSection, /I2: The package appears unopened/);
});

test('image preflight can use a host-injected completion adapter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-complete-adapter.'));
  const calls = [];
  const registry = {
    find(provider, modelId) {
      calls.push({ provider, modelId });
      if (provider === 'kimi-coding' && modelId === 'kimi-for-coding') {
        return { provider, id: modelId, name: `${provider}/${modelId}` };
      }
      return undefined;
    },
    async getApiKeyAndHeaders(model) {
      return { headers: { 'x-test-model': model.name } };
    },
  };

  const result = await withEnv(allowingPromptHookEnv({ STRONK_PI_STATE_ROOT: join(root, '.stronk-pi') }), async () => (
    internals.handleInput(
      {
        text: 'Explain the attached image',
        model: 'alibaba-coding/qwen3-coder-plus',
        images: [{ source: { type: 'base64', mediaType: 'image/png', data: PNG_BASE64 } }],
      },
      {
        cwd: root,
        modelRegistry: registry,
        complete: async (model, payload, options) => {
          calls.push({ model, payload, options });
          return {
            text: JSON.stringify({
              images: [
                {
                  label: 'image-1',
                  observed_facts: ['The adapter received one image content part.'],
                  inferences: ['The host completion path is wired.'],
                },
              ],
            }),
          };
        },
      },
    )
  ));

  const completeCall = calls.find((call) => call.payload);
  assert.equal(result.action, 'transform');
  assert.deepEqual(result.images, []);
  assert.equal(calls[0].provider, 'kimi-coding');
  assert.equal(calls[0].modelId, 'kimi-for-coding');
  assert.equal(completeCall.model.name, 'kimi-coding/kimi-for-coding');
  assert.equal(completeCall.payload.messages[0].content.filter((part) => part.type === 'image').length, 1);
  assert.equal(completeCall.options.headers['x-test-model'], 'kimi-coding/kimi-for-coding');
  assert.match(result.text, /The adapter received one image content part/);
});

test('image preflight can call configured OpenAI-compatible vision provider without host adapter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-provider-fallback.'));
  const stateRoot = join(root, '.stronk-pi');
  mkdirSync(join(stateRoot, 'agent'), { recursive: true });
  mkdirSync(join(stateRoot, 'config'), { recursive: true });
  writeFileSync(join(stateRoot, 'agent', 'models.json'), JSON.stringify({
    providers: {
      'kimi-coding': {
        name: 'Kimi Coding',
        api: 'openai-completions',
        apiKey: '$KIMI_API_KEY',
        baseUrl: 'https://vision.example/v1',
        compat: {
          maxTokensField: 'max_tokens',
          supportsDeveloperRole: false,
          supportsStore: false,
        },
        models: [
          { id: 'kimi-for-coding', input: ['text', 'image'], maxTokens: 65536 },
        ],
      },
      'alibaba-coding': {
        models: [{ id: 'qwen3-coder-plus', input: ['text'] }],
      },
    },
  }));
  writeFileSync(join(stateRoot, 'config', 'defaults.toml'), [
    '[image_preflight]',
    'enabled = true',
    'model = "kimi-coding/kimi-for-coding:xhigh"',
    '',
  ].join('\n'));
  const linuxEtcPath = '/etc/passwd';
  const linuxRootPath = '/root/.ssh/id_ed25519';
  const rawGifDataUrl = `data:image/gif;base64,${TINY_GIF_BASE64}`;
  const fetchFn = captureFetch({
    choices: [
      {
        message: {
          content: JSON.stringify({
            images: [
              {
                label: 'image-1',
                observed_facts: ['The configured provider received the image.'],
                inferences: ['The direct provider fallback is wired.'],
              },
            ],
          }),
        },
      },
    ],
  });

  const result = await withEnv(allowingPromptHookEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    KIMI_API_KEY: 'test-kimi-generic-key',
    KIMI_CODE_API_KEY: 'fallback-kimi-code-key',
	  }), async () => internals.handleInput(
	    {
	      text: `What is in this image? Compare with ${linuxEtcPath}, ${linuxRootPath}, and ${rawGifDataUrl}.`,
	      model: 'alibaba-coding/qwen3-coder-plus',
	      images: [{ source: { type: 'base64', mediaType: 'image/png', data: PNG_BASE64 } }],
    },
    {
      cwd: root,
      fetch: fetchFn,
    },
  ));

  assert.equal(result.action, 'transform');
  assert.deepEqual(result.images, []);
  assert.match(result.text, /The configured provider received the image/);
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(fetchFn.calls[0].url, 'https://vision.example/v1/chat/completions');
  assert.equal(fetchFn.calls[0].init.method, 'POST');
  assert.equal(fetchFn.calls[0].init.headers.authorization, 'Bearer test-kimi-generic-key');
  const payload = requestBody(fetchFn.calls[0]);
  assert.equal(payload.model, 'kimi-for-coding');
  assert.equal(payload.max_tokens, 4096);
  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages[1].role, 'user');
  assert.equal(payload.messages[1].content[0].type, 'text');
  assert.equal(payload.messages[1].content[1].type, 'image_url');
  assert.match(payload.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(payload.messages[1].content[0].text.includes(linuxEtcPath), false);
  assert.equal(payload.messages[1].content[0].text.includes(linuxRootPath), false);
  assert.equal(payload.messages[1].content[0].text.includes('.ssh'), false);
  assert.doesNotMatch(payload.messages[1].content[0].text, /data:image\/gif;base64/);
  assert.doesNotMatch(payload.messages[1].content[0].text, new RegExp(TINY_GIF_BASE64.slice(0, 16)));
});

test('image preflight max_output_tokens config reaches provider payload and clamps high values', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-output-tokens.'));
  const stateRoot = join(root, '.stronk-pi');
  mkdirSync(join(stateRoot, 'agent'), { recursive: true });
  mkdirSync(join(stateRoot, 'config'), { recursive: true });
  writeFileSync(join(stateRoot, 'agent', 'models.json'), JSON.stringify({
    providers: {
      'vision-provider': {
        api: 'openai-completions',
        apiKey: '$VISION_API_KEY',
        baseUrl: 'https://vision.example/v1',
        models: [
          { id: 'vision-large', input: ['text', 'image'] },
        ],
      },
    },
  }));
  writeFileSync(join(stateRoot, 'config', 'defaults.toml'), [
    '[image_preflight]',
    'enabled = true',
    'model = "vision-provider/vision-large"',
    'max_output_tokens = 12000',
    '',
  ].join('\n'));
  const fetchFn = captureFetch({
    choices: [{ message: { content: '{"images":[]}' } }],
  });

  await internals.buildImageVisionPreflight(
    {
      text: 'Describe the attached image',
      model: 'neuralwatt/glm-5.2:xhigh',
      images: [{ source: { type: 'base64', mediaType: 'image/png', data: PNG_BASE64 } }],
    },
    { cwd: root, fetch: fetchFn },
    {
      env: {
        STRONK_PI_STATE_ROOT: stateRoot,
        VISION_API_KEY: 'vision-test-key',
      },
      fetch: fetchFn,
    },
  );

  assert.equal(fetchFn.calls.length, 1);
  const payload = requestBody(fetchFn.calls[0]);
  assert.equal(payload.model, 'vision-large');
  assert.equal(payload.max_tokens, 8192);
});

test('image preflight provider payload scales output tokens by prompt image count', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-output-tokens-scaled.'));
  const stateRoot = join(root, '.stronk-pi');
  mkdirSync(join(stateRoot, 'agent'), { recursive: true });
  mkdirSync(join(stateRoot, 'config'), { recursive: true });
  const imagePaths = [writePng(root, 'one.png'), writePng(root, 'two.png'), writePng(root, 'three.png')];
  writeFileSync(join(stateRoot, 'agent', 'models.json'), JSON.stringify({
    providers: {
      'vision-provider': {
        api: 'openai-completions',
        apiKey: '$VISION_API_KEY',
        baseUrl: 'https://vision.example/v1',
        models: [
          { id: 'vision-large', input: ['text', 'image'] },
        ],
      },
    },
  }));
  writeFileSync(join(stateRoot, 'config', 'defaults.toml'), [
    '[image_preflight]',
    'enabled = true',
    'model = "vision-provider/vision-large"',
    'max_output_tokens = 4096',
    '',
  ].join('\n'));
  const fetchFn = captureFetch({
    choices: [{ message: { content: '{"images":[]}' } }],
  });

  await internals.buildImageVisionPreflight(
    {
      text: `Describe these images:\n${imagePaths.join('\n')}`,
      model: 'neuralwatt/glm-5.2:xhigh',
    },
    { cwd: root, fetch: fetchFn },
    {
      env: {
        STRONK_PI_STATE_ROOT: stateRoot,
        VISION_API_KEY: 'vision-test-key',
      },
      fetch: fetchFn,
    },
  );

  assert.equal(fetchFn.calls.length, 1);
  const payload = requestBody(fetchFn.calls[0]);
  assert.equal(payload.max_tokens, 4096 * 3);
  assert.equal(payload.messages[1].content.filter((part) => part.type === 'image_url').length, 3);
});

test('image preflight max_output_tokens config reaches Anthropic payload and clamps low values', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-anthropic-output-tokens.'));
  const stateRoot = join(root, '.stronk-pi');
  mkdirSync(join(stateRoot, 'agent'), { recursive: true });
  mkdirSync(join(stateRoot, 'config'), { recursive: true });
  writeFileSync(join(stateRoot, 'agent', 'models.json'), JSON.stringify({
    providers: {
      'anthropic-vision': {
        api: 'anthropic-messages',
        apiKey: '$ANTHROPIC_VISION_API_KEY',
        baseUrl: 'https://anthropic.example/v1',
        models: [
          { id: 'vision-sonnet', input: ['text', 'image'] },
        ],
      },
    },
  }));
  writeFileSync(join(stateRoot, 'config', 'defaults.toml'), [
    '[image_preflight]',
    'enabled = true',
    'model = "anthropic-vision/vision-sonnet"',
    'max_output_tokens = 128',
    '',
  ].join('\n'));
  const fetchFn = captureFetch({
    content: [{ type: 'text', text: '{"images":[]}' }],
  });

  await internals.buildImageVisionPreflight(
    {
      text: 'Describe the attached image',
      model: 'neuralwatt/glm-5.2:xhigh',
      images: [{ source: { type: 'base64', mediaType: 'image/png', data: PNG_BASE64 } }],
    },
    { cwd: root, fetch: fetchFn },
    {
      env: {
        STRONK_PI_STATE_ROOT: stateRoot,
        ANTHROPIC_VISION_API_KEY: 'anthropic-test-key',
      },
      fetch: fetchFn,
    },
  );

  assert.equal(fetchFn.calls.length, 1);
  assert.equal(fetchFn.calls[0].url, 'https://anthropic.example/v1/messages');
  const payload = requestBody(fetchFn.calls[0]);
  assert.equal(payload.model, 'vision-sonnet');
  assert.equal(payload.max_tokens, 1024);
});

test('image preflight uses built-in Kimi coding fallback when provider is not in models.json', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-builtin-kimi-fallback.'));
  const stateRoot = join(root, '.stronk-pi');
  mkdirSync(join(stateRoot, 'agent'), { recursive: true });
  mkdirSync(join(stateRoot, 'config'), { recursive: true });
  writeFileSync(join(stateRoot, 'agent', 'models.json'), JSON.stringify({
    providers: {
      'alibaba-coding': {
        models: [{ id: 'qwen3-coder-plus', input: ['text'] }],
      },
    },
  }));
  writeFileSync(join(stateRoot, 'config', 'defaults.toml'), [
    '[image_preflight]',
    'enabled = true',
    'model = "kimi-coding/kimi-for-coding:xhigh"',
    '',
  ].join('\n'));
  const fetchFn = captureFetch({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          images: [
            {
              label: 'image-1',
              observed_facts: ['The built-in Kimi fallback received the image.'],
              inferences: ['The built-in provider contract is wired.'],
            },
          ],
        }),
      },
    ],
  });

  const result = await withEnv(allowingPromptHookEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    KIMI_API_KEY: 'test-kimi-generic-key',
    KIMI_CODE_API_KEY: 'fallback-kimi-code-key',
  }), async () => internals.handleInput(
    {
      text: 'What is in this image?',
      model: 'alibaba-coding/qwen3-coder-plus',
      images: [{ source: { type: 'base64', mediaType: 'image/png', data: PNG_BASE64 } }],
    },
    {
      cwd: root,
      fetch: fetchFn,
    },
  ));

  assert.equal(result.action, 'transform');
  assert.deepEqual(result.images, []);
  assert.match(result.text, /The built-in Kimi fallback received the image/);
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(fetchFn.calls[0].url, 'https://api.kimi.com/coding/v1/messages');
  assert.equal(fetchFn.calls[0].init.headers['x-api-key'], 'test-kimi-generic-key');
  assert.equal(fetchFn.calls[0].init.headers['User-Agent'], 'KimiCLI/1.5');
  assert.match(fetchFn.calls[0].init.headers.accept, /text\/event-stream/);
  const payload = requestBody(fetchFn.calls[0]);
  assert.equal(payload.model, 'kimi-for-coding');
  assert.equal(payload.max_tokens, 4096);
  assert.equal(payload.stream, true);
  assert.equal(payload.messages[0].content[1].type, 'image');
  assert.equal(payload.messages[0].content[1].source.media_type, 'image/png');
});

test('image preflight parses streamed built-in Kimi vision responses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-builtin-kimi-stream.'));
  const stateRoot = join(root, '.stronk-pi');
  mkdirSync(join(stateRoot, 'agent'), { recursive: true });
  mkdirSync(join(stateRoot, 'config'), { recursive: true });
  writeFileSync(join(stateRoot, 'agent', 'models.json'), JSON.stringify({
    providers: {
      'alibaba-coding': {
        models: [{ id: 'qwen3-coder-plus', input: ['text'] }],
      },
    },
  }));
  writeFileSync(join(stateRoot, 'config', 'defaults.toml'), [
    '[image_preflight]',
    'enabled = true',
    'model = "kimi-coding/kimi-for-coding:xhigh"',
    '',
  ].join('\n'));
  const streamedText = JSON.stringify({
    images: [
      {
        label: 'image-1',
        observed_facts: ['E1: The streamed Kimi response reached image preflight.'],
        inferences: ['I1: Streaming transport is wired based on image-1.E1.'],
      },
    ],
  });
  const midpoint = Math.ceil(streamedText.length / 2);
  const fetchFn = captureFetchResponse(() => eventStreamResponse([
    sseEvent('message_start', { type: 'message_start' }),
    sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: streamedText.slice(0, midpoint) } }),
    sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: streamedText.slice(midpoint) } }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ]));

  const result = await withEnv(allowingPromptHookEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    KIMI_API_KEY: 'test-kimi-generic-key',
  }), async () => internals.handleInput(
    {
      text: 'What is in this image?',
      model: 'alibaba-coding/qwen3-coder-plus',
      images: [{ source: { type: 'base64', mediaType: 'image/png', data: PNG_BASE64 } }],
    },
    {
      cwd: root,
      fetch: fetchFn,
    },
  ));

  assert.equal(result.action, 'transform');
  assert.match(result.text, /The streamed Kimi response reached image preflight/);
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(fetchFn.calls[0].url, 'https://api.kimi.com/coding/v1/messages');
  assert.match(fetchFn.calls[0].init.headers.accept, /text\/event-stream/);
  const payload = requestBody(fetchFn.calls[0]);
  assert.equal(payload.model, 'kimi-for-coding');
  assert.equal(payload.stream, true);
});

test('image preflight idle-times out stalled Kimi streams without token progress', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-builtin-kimi-stream-idle.'));
  const stateRoot = join(root, '.stronk-pi');
  mkdirSync(join(stateRoot, 'agent'), { recursive: true });
  mkdirSync(join(stateRoot, 'config'), { recursive: true });
  writeFileSync(join(stateRoot, 'agent', 'models.json'), JSON.stringify({
    providers: {
      'alibaba-coding': {
        models: [{ id: 'qwen3-coder-plus', input: ['text'] }],
      },
    },
  }));
  writeFileSync(join(stateRoot, 'config', 'defaults.toml'), [
    '[image_preflight]',
    'enabled = true',
    'model = "kimi-coding/kimi-for-coding:xhigh"',
    '',
  ].join('\n'));
  const fetchFn = captureFetchResponse(() => stalledEventStreamResponse([
    sseEvent('message_start', { type: 'message_start' }),
    sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ]));

  const result = await withEnv(allowingPromptHookEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_IMAGE_PREFLIGHT_STREAM_IDLE_TIMEOUT_MS: '1000',
    KIMI_API_KEY: 'test-kimi-generic-key',
  }), async () => internals.handleInput(
    {
      text: 'What is in this image?',
      model: 'alibaba-coding/qwen3-coder-plus',
      images: [{ source: { type: 'base64', mediaType: 'image/png', data: PNG_BASE64 } }],
    },
    {
      cwd: root,
      fetch: fetchFn,
    },
  ));

  assert.equal(result.action, 'transform');
  assert.match(result.text, /Preflight status: failed \(timed out\)/);
  assert.equal(fetchFn.calls.length, 1);
  const payload = requestBody(fetchFn.calls[0]);
  assert.equal(payload.stream, true);
});

test('image preflight reports missing Kimi credentials before provider request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-missing-kimi-key.'));
  const stateRoot = join(root, '.stronk-pi');
  mkdirSync(join(stateRoot, 'agent'), { recursive: true });
  mkdirSync(join(stateRoot, 'config'), { recursive: true });
  writeFileSync(join(stateRoot, 'agent', 'models.json'), JSON.stringify({
    providers: {
      'kimi-coding': {
        name: 'Kimi Coding',
        api: 'openai-completions',
        baseUrl: 'https://vision.example/v1',
        models: [
          { id: 'kimi-for-coding', input: ['text', 'image'], maxTokens: 65536 },
        ],
      },
      'alibaba-coding': {
        models: [{ id: 'qwen3-coder-plus', input: ['text'] }],
      },
    },
  }));
  writeFileSync(join(stateRoot, 'config', 'defaults.toml'), [
    '[image_preflight]',
    'enabled = true',
    'model = "kimi-coding/kimi-for-coding:xhigh"',
    '',
  ].join('\n'));
  const fetchFn = captureFetch({});

  const result = await withEnv(allowingPromptHookEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    KIMI_API_KEY: '',
    KIMI_CODE_API_KEY: '',
  }), async () => internals.handleInput(
    {
      text: 'What is in this image?',
      model: 'alibaba-coding/qwen3-coder-plus',
      images: [{ source: { type: 'base64', mediaType: 'image/png', data: PNG_BASE64 } }],
    },
    {
      cwd: root,
      fetch: fetchFn,
    },
  ));

  assert.equal(result.action, 'transform');
  assert.match(result.text, /Preflight status: failed \(missing vision model credentials\)/);
  assert.doesNotMatch(result.text, /KIMI_API_KEY|KIMI_CODE_API_KEY/);
  assert.equal(fetchFn.calls.length, 0);
});

test('native multimodal models keep raw image handling and bypass preflight', async () => {
  let called = false;
  const notices = [];
  const result = await withEnv(allowingPromptHookEnv(), async () => internals.handleInput(
    {
      text: 'Describe the attached image',
      model: 'alibaba-coding/qwen3.6-plus',
      images: [{ source: { type: 'base64', mediaType: 'image/png', data: PNG_BASE64 } }],
    },
    {
      model: { id: 'qwen3.6-plus', provider: 'alibaba-coding', input: ['text', 'image'] },
      hasUI: true,
      ui: { notify: (message, kind) => notices.push([kind, message]) },
      visionPreflight: async () => {
        called = true;
      },
    },
  ));

  assert.equal(result, undefined);
  assert.equal(called, false);
  assert.deepEqual(notices, []);
});

test('built-in Kimi multimodal model keeps native raw image handling without provider config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-builtin-kimi-native.'));
  const stateRoot = join(root, '.stronk-pi');
  mkdirSync(join(stateRoot, 'agent'), { recursive: true });
  mkdirSync(join(stateRoot, 'config'), { recursive: true });
  writeFileSync(join(stateRoot, 'agent', 'models.json'), JSON.stringify({
    providers: {},
  }));
  writeFileSync(join(stateRoot, 'config', 'defaults.toml'), [
    '[image_preflight]',
    'enabled = true',
    'model = "kimi-coding/kimi-for-coding:xhigh"',
    '',
  ].join('\n'));
  let called = false;
  const result = await withEnv(allowingPromptHookEnv({ STRONK_PI_STATE_ROOT: stateRoot }), async () => internals.handleInput(
    {
      text: 'Describe the attached image',
      model: 'kimi-coding/kimi-for-coding:xhigh',
      images: [{ source: { type: 'base64', mediaType: 'image/png', data: PNG_BASE64 } }],
    },
    {
      cwd: root,
      visionPreflight: async () => {
        called = true;
      },
    },
  ));

  assert.equal(result, undefined);
  assert.equal(called, false);
});

test('extension-originated image prompts are guarded against recursive preflight', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-recursion.'));
  const imagePath = writePng(root);
  let called = false;

  const result = await withEnv(allowingPromptHookEnv(), async () => internals.handleInput(
    {
      text: `Analyze ${imagePath}`,
      source: 'extension',
      model: 'alibaba-coding/qwen3-coder-plus',
    },
    {
      cwd: root,
      visionPreflight: async () => {
        called = true;
      },
    },
  ));

  assert.equal(result, undefined);
  assert.equal(called, false);
});

test('image preflight enforces limits and reports skipped images', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-limits.'));
  const first = writePng(root, 'first.png');
  const second = writePng(root, 'second.png');
  const notices = [];

  const result = await withEnv(allowingPromptHookEnv({
    STRONK_PI_IMAGE_PREFLIGHT_MAX_IMAGES: '1',
    STRONK_PI_STATE_ROOT: join(root, '.stronk-pi'),
  }), async () => internals.handleInput(
    {
      text: `Compare ${first} and ${second}`,
      model: 'alibaba-coding/qwen3-coder-plus',
    },
    {
      cwd: root,
      hasUI: true,
      ui: { notify: (message, kind) => notices.push([kind, message]) },
      visionPreflight: async () => ({
        images: [{ label: 'image-1', observed_facts: ['First image was analyzed.'], inferences: [] }],
      }),
    },
  ));

  assert.equal(result.action, 'transform');
  assert.match(result.text, /Images analyzed: 1/);
  assert.match(result.text, /Skipped Images:/);
  assert.match(result.text, /max_images limit reached/);
  assert.deepEqual(notices, [
    ['info', 'Stronk Pi detected 1 image for a text-only model; analyzing with vision preflight.'],
    ['info', 'Image vision preflight complete: analyzed 1 image; skipped 1 image.'],
  ]);
});

test('image preflight skips the thirteenth supported image by default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-thirteen.'));
  const imagePaths = Array.from({ length: 13 }, (_value, index) => writePng(root, `candidate-${String(index + 1).padStart(2, '0')}.png`));
  const calls = [];
  const notices = [];

  const result = await withEnv(allowingPromptHookEnv({
    STRONK_PI_STATE_ROOT: join(root, '.stronk-pi'),
  }), async () => internals.handleInput(
    {
      text: `Compare ${imagePaths.join(' ')}`,
      model: 'alibaba-coding/qwen3-coder-plus',
    },
    {
      cwd: root,
      hasUI: true,
      ui: { notify: (message, kind) => notices.push([kind, message]) },
      visionPreflight: async (request) => {
        calls.push(request);
        return {
          images: Array.from({ length: 12 }, (_value, index) => ({
            label: `image-${index + 1}`,
            observed_facts: [`Image ${index + 1} was analyzed.`],
            inferences: [],
          })),
        };
      },
    },
  ));

  assert.equal(result.action, 'transform');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].messages[0].content.filter((part) => part.type === 'image').length, 12);
  assert.match(result.text, /Images analyzed: 12/);
  assert.match(result.text, /Skipped Images:/);
  assert.match(result.text, /max_images limit reached \(12\)/);
  assert.doesNotMatch(result.text, /image attachment scan limit reached/);
  assert.deepEqual(notices, [
    ['info', 'Stronk Pi detected 12 images for a text-only model; analyzing with vision preflight.'],
    ['info', 'Image vision preflight complete: analyzed 12 images; skipped 1 image.'],
  ]);
});

test('image preflight enforces byte-size and MIME limits before vision calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-limit-details.'));
  const textPath = join(root, 'not-image.png');
  writeFileSync(textPath, 'this is not a png');
  let called = false;
  const notices = [];

  const byteLimit = await withEnv(allowingPromptHookEnv({
    STRONK_PI_IMAGE_PREFLIGHT_MAX_BYTES: '1024',
    STRONK_PI_STATE_ROOT: join(root, '.stronk-pi'),
  }), async () => internals.handleInput(
    {
      text: 'Analyze attached image',
      model: 'alibaba-coding/qwen3-coder-plus',
      images: [{ source: { type: 'base64', mediaType: 'image/png', data: Buffer.alloc(2048).toString('base64') } }],
    },
    {
      cwd: root,
      hasUI: true,
      ui: { notify: (message, kind) => notices.push([kind, message]) },
      visionPreflight: async () => {
        called = true;
      },
    },
  ));

  assert.equal(called, false);
  assert.equal(byteLimit.action, 'transform');
  assert.deepEqual(byteLimit.images, []);
  assert.match(byteLimit.text, /image exceeds max_bytes \(1024\)/);
  assert.deepEqual(notices, [
    ['warning', 'Image vision preflight skipped: no supported images found; skipped 1 image.'],
  ]);

  const mimeLimit = await withEnv(allowingPromptHookEnv({
    STRONK_PI_STATE_ROOT: join(root, '.stronk-pi'),
  }), async () => internals.handleInput(
    {
      text: `Analyze ${textPath}`,
      model: 'alibaba-coding/qwen3-coder-plus',
    },
    {
      cwd: root,
      visionPreflight: async () => {
        called = true;
      },
    },
  ));

  assert.equal(called, false);
  assert.equal(mimeLimit.action, 'transform');
  assert.match(mimeLimit.text, /unsupported MIME type image\/png|unsupported MIME type unknown/);
});

test('image preflight rejects oversize base64 before decode and bounds attachment scanning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-resource-bounds.'));
  let called = false;
  const rawImages = Array.from({ length: 20 }, () => ({
    source: {
      type: 'base64',
      mediaType: 'image/png',
      data: `${PNG_BASE64}${'A'.repeat(4096)}`,
    },
  }));

  const result = await withEnv(allowingPromptHookEnv({
    STRONK_PI_IMAGE_PREFLIGHT_MAX_IMAGES: '1',
    STRONK_PI_IMAGE_PREFLIGHT_MAX_BYTES: '1024',
    STRONK_PI_STATE_ROOT: join(root, '.stronk-pi'),
  }), async () => internals.handleInput(
    {
      text: 'Analyze many oversized images',
      model: 'alibaba-coding/qwen3-coder-plus',
      images: rawImages,
    },
    {
      cwd: root,
      visionPreflight: async () => {
        called = true;
      },
    },
  ));

  assert.equal(called, false);
  assert.equal(result.action, 'transform');
  assert.deepEqual(result.images, []);
  assert.match(result.text, /image exceeds max_bytes \(1024\)/);
  assert.match(result.text, /image attachment scan limit reached \(2\)/);
  assert.doesNotMatch(result.text, /event\.images\[19]/);
});

test('image preflight rejects spoofed and invalid base64 attachments before vision calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-spoofed-base64.'));
  let called = false;

  const spoofed = await withEnv(allowingPromptHookEnv({
    STRONK_PI_STATE_ROOT: join(root, '.stronk-pi'),
  }), async () => internals.handleInput(
    {
      text: 'Analyze attached spoofed image',
      model: 'alibaba-coding/qwen3-coder-plus',
      images: [{ source: { type: 'base64', mediaType: 'image/png', data: Buffer.from('not an image').toString('base64') } }],
    },
    {
      cwd: root,
      visionPreflight: async () => {
        called = true;
      },
    },
  ));

  assert.equal(called, false);
  assert.equal(spoofed.action, 'transform');
  assert.deepEqual(spoofed.images, []);
  assert.match(spoofed.text, /unsupported MIME type image\/png/);

  const invalid = await withEnv(allowingPromptHookEnv({
    STRONK_PI_STATE_ROOT: join(root, '.stronk-pi'),
  }), async () => internals.handleInput(
    {
      text: 'Analyze invalid base64 image',
      model: 'alibaba-coding/qwen3-coder-plus',
      images: [{ source: { type: 'base64', mediaType: 'image/png', data: 'not valid base64!' } }],
    },
    {
      cwd: root,
      visionPreflight: async () => {
        called = true;
      },
    },
  ));

  assert.equal(called, false);
  assert.equal(invalid.action, 'transform');
  assert.deepEqual(invalid.images, []);
  assert.match(invalid.text, /invalid image base64/);
});

test('image preflight fail-soft strips raw images and injects failure context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-failsoft.'));
  const notices = [];

  const result = await withEnv(allowingPromptHookEnv({ STRONK_PI_STATE_ROOT: join(root, '.stronk-pi') }), async () => (
    internals.handleInput(
      {
        text: 'What is in this image?',
        model: 'alibaba-coding/qwen3-coder-plus',
        images: [{ source: { type: 'base64', mediaType: 'image/png', data: PNG_BASE64 } }],
      },
      {
        cwd: root,
        hasUI: true,
        ui: { notify: (message, kind) => notices.push([kind, message]) },
        visionPreflight: async () => {
          throw new Error(`mock provider echoed data:image/png;base64,${PNG_BASE64}`);
        },
      },
    )
  ));

  assert.equal(result.action, 'transform');
  assert.deepEqual(result.images, []);
  assert.match(result.text, /Preflight status: failed \(vision provider request failed\)/);
  assert.match(result.text, /No structured observed facts were returned/);
  assert.doesNotMatch(result.text, /data:image\/png;base64/);
  assert.doesNotMatch(result.text, new RegExp(PNG_BASE64.slice(0, 24)));
  assert.deepEqual(notices, [
    ['info', 'Stronk Pi detected 1 image for a text-only model; analyzing with vision preflight.'],
    ['warning', 'Image vision preflight failed: vision provider request failed; using a failure note instead of raw images.'],
  ]);
});

test('image preflight block mode handles prompt on vision failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-block.'));
  const notices = [];

  const result = await withEnv(allowingPromptHookEnv({
    STRONK_PI_IMAGE_PREFLIGHT_FAILURE_MODE: 'block',
    STRONK_PI_STATE_ROOT: join(root, '.stronk-pi'),
  }), async () => internals.handleInput(
    {
      text: 'What is in this image?',
      model: 'alibaba-coding/qwen3-coder-plus',
      images: [{ source: { type: 'base64', mediaType: 'image/png', data: PNG_BASE64 } }],
    },
    {
      cwd: root,
      hasUI: true,
      ui: { notify: (message, kind) => notices.push([kind, message]) },
      visionPreflight: async () => {
        throw new Error('mock block failure');
      },
    },
  ));

  assert.deepEqual(result, { action: 'handled' });
  assert.deepEqual(notices, [
    ['info', 'Stronk Pi detected 1 image for a text-only model; analyzing with vision preflight.'],
    ['warning', 'Image vision preflight failed: vision provider request failed.'],
  ]);
});

test('image preflight timeout is bounded and reported fail-soft', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stronk-pi-image-timeout.'));

  const result = await withEnv(allowingPromptHookEnv({
    STRONK_PI_IMAGE_PREFLIGHT_TIMEOUT_MS: '1000',
    STRONK_PI_STATE_ROOT: join(root, '.stronk-pi'),
  }), async () => internals.handleInput(
    {
      text: 'What is in this image?',
      model: 'alibaba-coding/qwen3-coder-plus',
      images: [{ source: { type: 'base64', mediaType: 'image/png', data: PNG_BASE64 } }],
    },
    {
      cwd: root,
      visionPreflight: async () => new Promise(() => {}),
    },
  ));

  assert.equal(result.action, 'transform');
  assert.deepEqual(result.images, []);
  assert.match(result.text, /Preflight status: failed \(timed out\)/);
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
      ['code_search', { query: 'Pi Coding Agent tool implementation' }],
      ['fetch_content', { url: 'https://example.com' }],
      ['image_read', { paths: ['screenshots/example.png'] }],
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

test('disabled search-content compatibility tools are denied before helper execution', async () => {
  for (const toolName of ['get_search_content']) {
    await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([allowScript()]) }, async () => {
      const result = await internals.handleToolCall({
        toolName,
        input: { query: 'Pi Coding Agent docs', id: 'result-1' },
        cwd: process.cwd(),
      });
      assert.equal(result.block, true);
      assert.match(result.reason, /disabled upstream tool/);
    });
  }
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
    assert.match(result.reason, /secret literal/);
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
  assert.equal(internals.hasBlockingSensitiveContent({ command: `key=${fakeSecret} some-tool` }), true);
  assert.equal(internals.hasBlockingSensitiveContent({ command: 'OPENAI_API_KEY=plain-demo-value some-tool' }), false);
});

test('sensitive key placeholders reach helper with redacted values', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stronk-pi-sensitive-redact.'));
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
    const result = await internals.handleToolCall({
      toolName: 'mcp',
      input: {
        tool: 'mock_echo',
        args: {
          apiKey: 'plain-demo-value',
          secretKey: 'another-placeholder',
          command: 'OPENAI_API_KEY=plain-demo-value some-tool',
        },
      },
      cwd: process.cwd(),
    });
    assert.equal(result, undefined);
  });

  const captured = readFileSync(capture, 'utf8');
  assert.match(captured, /<redacted>/);
  assert.doesNotMatch(captured, /plain-demo-value/);
  assert.doesNotMatch(captured, /another-placeholder/);
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
    assert.match(result.result.output, /secret literal/);
  });
});

test('inline placeholder assignment in user_bash reaches helper redacted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stronk-pi-user-bash-redact.'));
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
    const result = await internals.handleUserBash({
      command: 'OPENAI_API_KEY=plain-demo-value some-tool',
      cwd: process.cwd(),
      excludeFromContext: false,
    });
    assert.equal(result, undefined);
  });

  const captured = readFileSync(capture, 'utf8');
  assert.match(captured, /OPENAI_API_KEY=<redacted>/);
  assert.doesNotMatch(captured, /plain-demo-value/);
});

test('quoted placeholder assignment in user_bash reaches helper redacted', async () => {
  await withEnv({ STRONK_PI_HOOK_COMMAND_JSON: JSON.stringify([allowScript()]) }, async () => {
    const result = await internals.handleUserBash({
      command: 'printf \'{"OPENAI_API_KEY":"plain-demo-value"}\'',
      cwd: process.cwd(),
      excludeFromContext: false,
    });
    assert.equal(result, undefined);
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
