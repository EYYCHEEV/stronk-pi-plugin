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
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['code_search', 'fetch_content', 'glob', 'question', 'todoread', 'todowrite', 'web_search']);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
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
