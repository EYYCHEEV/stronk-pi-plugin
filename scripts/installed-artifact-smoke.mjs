#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, '..');
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const pluginVersion = process.env.STRONK_PI_SMOKE_PLUGIN_VERSION || packageJson.version;

const home = homedir();
const stateRoot = process.env.STRONK_PI_STATE_ROOT || join(home, '.stronk-pi');
const runtimeRoot = process.env.STRONK_PI_SMOKE_RUNTIME || join(stateRoot, 'pi-fork-runtime');
const pluginPath = process.env.STRONK_PI_SMOKE_PLUGIN
  || join(stateRoot, `artifacts/stronk-pi-plugin-${pluginVersion}/package/src/index.mjs`);
const runInstalledAgentSmoke = process.env.STRONK_PI_SMOKE_AGENT_RUN !== '0';

if (!existsSync(pluginPath)) {
  throw new Error(`Stronk Pi plugin artifact not found: ${pluginPath}`);
}

const plugin = await import(pathToFileURL(resolve(pluginPath)).href);
const { Box } = await import(pathToFileURL(join(runtimeRoot, 'node_modules/@earendil-works/pi-tui/dist/components/box.js')).href);
const { visibleWidth } = await import(pathToFileURL(join(runtimeRoot, 'node_modules/@earendil-works/pi-tui/dist/tui.js')).href);

function renderText(component, width) {
  assert.notEqual(typeof component, 'string');
  assert.equal(typeof component?.render, 'function');
  const box = new Box(1, 0);
  box.addChild(component);
  const lines = box.render(width);
  for (const [index, line] of lines.entries()) {
    const lineWidth = visibleWidth(line);
    assert.ok(
      lineWidth <= width,
      `rendered line ${index} exceeds width ${width}: ${lineWidth} > ${width}\n${line}`,
    );
  }
  return lines.join('\n');
}

function mockFetch(body) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(body);
      },
    };
  };
  fetchFn.calls = calls;
  return fetchFn;
}

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQCzUH0LAAAAAElFTkSuQmCC',
  'base64',
);

function allowPromptHookCommandJson() {
  return JSON.stringify([
    'node',
    '-e',
    "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({allow:true})))",
  ]);
}

function parseToolJson(result) {
  const text = result?.content?.[0]?.text;
  assert.equal(typeof text, 'string');
  return JSON.parse(text);
}

function assertNoDryRunPath(payload) {
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /dry-run|dry_run_no_worker|skipped child execution/i);
}

function assertPublicPathClean(payload, forbidden = []) {
  const serialized = JSON.stringify(payload);
  assert.equal(Object.hasOwn(payload, 'artifacts'), false);
  assert.doesNotMatch(serialized, /"cwd"\s*:\s*"(?:\/|file:)/);
  assert.doesNotMatch(serialized, /\/Users\/|\/home\/|\/tmp\/|\/var\/folders\/|\/private\/var\/|\/root\/|\/etc\//);
  assert.doesNotMatch(serialized, /file:\/\/\//);
  for (const value of forbidden.filter(Boolean)) {
    assert.equal(serialized.includes(value), false, `public result leaked ${value}`);
  }
}

function assertNoSkippedChildText(text) {
  assert.doesNotMatch(text, /dry[-_ ]run|dry_run_no_worker|skipped child execution|no launched worker|without launching a worker/i);
}

function unsubscribeEventBus() {
  const emitter = new EventEmitter();
  return {
    emit: (...args) => emitter.emit(...args),
    on: (event, listener) => {
      emitter.on(event, listener);
      return () => emitter.off(event, listener);
    },
  };
}

async function withEnv(values, action) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await action();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

const tools = [];
await plugin.default({
  on: () => {},
  registerTool: (tool) => tools.push(tool),
});

const byName = new Map(tools.map((tool) => [tool.name, tool]));
assert.deepEqual(
  [...byName.keys()].filter((name) => ['web_search', 'code_search', 'fetch_content', 'get_search_content'].includes(name)).sort(),
  ['code_search', 'fetch_content', 'web_search'],
);
assert.match(byName.get('fetch_content')?.description || '', /Stronk Pi redirect-aware SSRF guard/);
assert.match(byName.get('image_read')?.description || '', /text-only models/);
const webSearchSchema = byName.get('web_search')?.parameters?.properties ?? {};
assert.equal(webSearchSchema.resultRanks?.type, 'array');
assert.equal(webSearchSchema.resultIds?.type, 'array');
assert.equal(webSearchSchema.searchResultUrls?.type, 'array');

const subagentStateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-installed-subagent-smoke.'));
try {
  const rolesDir = join(subagentStateRoot, 'roles');
  mkdirSync(rolesDir, { recursive: true });
  writeFileSync(join(rolesDir, 'executor.toml'), 'name = "executor"\n');
  const roleManifest = join(subagentStateRoot, 'roles.toml');
  writeFileSync(roleManifest, `codex_roles_dir = "${rolesDir}"\n`);
  const events = unsubscribeEventBus();
  const asyncIds = [
    'installed-artifact-intercom-run-a',
    'installed-artifact-intercom-run-b',
    'installed-artifact-intercom-run-c',
    'installed-artifact-intercom-run-close-fail',
    'installed-artifact-intercom-run-capacity-retry',
  ];
  const closeFailAsyncId = asyncIds[3];
  const resultDir = join(subagentStateRoot, 'async-subagent-results');
  const requests = [];
  let spawnIndex = 0;
  let capacityBlockedOnce = false;

  const asyncDirFor = (asyncId) => join(subagentStateRoot, 'async-subagent-runs', asyncId);
  const resultPathFor = (asyncId) => join(resultDir, `${asyncId}.json`);
  const writeStatus = (asyncId, patch = {}) => {
    const asyncDir = asyncDirFor(asyncId);
    mkdirSync(asyncDir, { recursive: true });
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(join(asyncDir, 'status.json'), JSON.stringify({
      runId: asyncId,
      mode: 'single',
      state: 'running',
      startedAt: Date.now(),
      lastUpdate: Date.now(),
      pid: process.pid,
      cwd: packageRoot,
      steps: [{ agent: 'executor', status: 'running' }],
      ...patch,
    }, null, 2));
    return asyncDir;
  };
  const completeRun = (asyncId, result) => {
    writeStatus(asyncId, {
      state: 'complete',
      endedAt: Date.now(),
      steps: [{ agent: 'executor', status: 'complete', exitCode: 0 }],
    });
    writeFileSync(resultPathFor(asyncId), JSON.stringify({
      id: asyncId,
      mode: 'single',
      state: 'complete',
      exitCode: 0,
      ...result,
    }, null, 2));
  };

  events.on('subagent:slash:request', (request) => {
    requests.push(request);
    events.emit('subagent:slash:started', { requestId: request.requestId });
    if (request.params.action === 'interrupt') {
      if (request.params.id === closeFailAsyncId) {
        events.emit('subagent:slash:response', {
          requestId: request.requestId,
          isError: true,
          result: { content: [{ type: 'text', text: 'simulated installed close failure' }] },
        });
        return;
      }
      events.emit('subagent:slash:response', {
        requestId: request.requestId,
        isError: false,
        result: {
          content: [{ type: 'text', text: `Interrupted async child ${request.params.id}` }],
          details: { mode: 'management', results: [] },
        },
      });
      return;
    }

    if (request.params.task === 'installed capacity blocked child' && !capacityBlockedOnce) {
      capacityBlockedOnce = true;
      events.emit('subagent:slash:response', {
        requestId: request.requestId,
        isError: true,
        result: {
          content: [{ type: 'text', text: 'HTTP 429 concurrent limit reached: 6/6 slots in use. Retry-After: 1s' }],
          details: {
            mode: 'single',
            statusCode: 429,
            retryAfterMs: 1000,
            concurrency: { inUse: 6, limit: 6 },
          },
        },
      });
      return;
    }

    const asyncId = asyncIds[spawnIndex] || `installed-artifact-intercom-run-extra-${spawnIndex}`;
    spawnIndex += 1;
    const asyncDir = writeStatus(asyncId);
    events.emit('subagent:async-started', { id: asyncId, asyncDir, pid: process.pid, mode: 'single', agent: 'executor' });
    events.emit('subagent:slash:response', {
      requestId: request.requestId,
      isError: false,
      result: {
        content: [{ type: 'text', text: `Async: executor [${asyncId}]` }],
        details: { mode: 'single', results: [], asyncId, asyncDir },
      },
    });
  });

  await withEnv({
    STRONK_PI_SUBAGENT_FACADE: 'stronk',
    STRONK_PI_SUBAGENT_ADAPTER: 'intercom',
    STRONK_PI_STATE_ROOT: subagentStateRoot,
    STRONK_PI_FACADE_RUN_ID: 'installed-subagent-smoke',
    STRONK_PI_FACADE_DEBUG: '1',
    STRONK_PI_ROLE_MANIFEST: roleManifest,
    STRONK_PI_ROLE_MANIFEST_LOCAL: undefined,
  }, async () => {
    const subagentTools = [];
    await plugin.default({
      events,
      on: () => {},
      registerTool: (tool) => subagentTools.push(tool),
    });
    const subagentByName = new Map(subagentTools.map((tool) => [tool.name, tool]));
    const facade = subagentByName.get('stronk_subagent');
    assert.ok(facade);
    assert.equal(subagentByName.has('subagent'), false);

    const spawn = parseToolJson(await facade.execute({
      action: 'spawn',
      role: 'executor',
      task: 'installed artifact subagent intercom smoke',
    }, undefined, undefined, { model: 'installed-smoke/model:xhigh' }));
    assertNoDryRunPath(spawn);
    assertPublicPathClean(spawn, [subagentStateRoot, packageRoot]);
    assert.equal(spawn.child.status, 'running');
    assert.equal(spawn.child.roleRequested, 'executor');
    assert.equal(spawn.child.roleUsed, 'executor');
    assert.equal(spawn.child.aliasResolved, false);
    assert.equal(spawn.child.upstreamRunId, asyncIds[0]);
    assert.equal(spawn.child.recommendedNextAction, 'wait_again');
    assert.equal(requests[0].params.model, 'installed-smoke/model:xhigh');

    completeRun(asyncIds[0], {
      success: true,
      summary: `installed artifact intercom child completed password=supersecret123 ${subagentStateRoot}/secret.txt ${'x'.repeat(9000)}`,
      results: [{ agent: 'executor', output: `installed artifact intercom child completed ${subagentStateRoot}/secret.txt`, success: true }],
    });

    const waited = parseToolJson(await facade.execute({
      action: 'wait',
      childId: spawn.child.childId,
      timeoutMs: 1000,
    }));
    assertNoDryRunPath(waited);
    assertPublicPathClean(waited, [subagentStateRoot, packageRoot]);
    assert.equal(waited.child.status, 'completed');
    assert.equal(waited.child.isTerminal, true);
    assert.match(waited.child.childOutputPreview, /installed artifact intercom child completed/);
    assert.equal(waited.child.childOutputTruncated, true);
    assert.equal(waited.child.childOutputBytes, Buffer.byteLength(waited.child.childOutputPreview, 'utf8'));
    assert.match(waited.child.childOutputHash, /^[a-f0-9]{64}$/);
    assert.match(waited.child.childOutputHandle, /^subagent-output-[a-f0-9-]+$/);
    assert.doesNotMatch(waited.child.childOutputPreview, /supersecret123/);
    assert.doesNotMatch(waited.child.childOutputPreview, new RegExp(subagentStateRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(waited.child.recommendedNextAction, 'close_child');

    const read = parseToolJson(await facade.execute({
      action: 'read_output',
      outputHandle: waited.child.childOutputHandle,
      offset: 0,
      maxChars: 12000,
    }));
    assertNoDryRunPath(read);
    assertPublicPathClean(read, [subagentStateRoot, packageRoot]);
    assert.match(read.output.chunk, /installed artifact intercom child completed/);
    assert.doesNotMatch(read.output.chunk, /supersecret123/);
    assert.equal(read.output.redacted, true);

    const running = parseToolJson(await facade.execute({ action: 'spawn', role: 'executor', task: 'installed wait_all still running' }));
    const failed = parseToolJson(await facade.execute({ action: 'spawn', role: 'executor', task: 'installed wait_all failed child' }));
    const closeFail = parseToolJson(await facade.execute({ action: 'spawn', role: 'executor', task: 'installed close_all failure child' }));
    completeRun(asyncIds[2], {
      success: false,
      summary: 'installed artifact failure visible',
      results: [{ agent: 'executor', success: false, error: 'installed artifact failure visible' }],
    });
    const batch = parseToolJson(await facade.execute({
      action: 'wait_all',
      childIds: [spawn.child.childId, running.child.childId, failed.child.childId],
      timeoutMs: 20,
    }));
    assertNoDryRunPath(batch);
    assertPublicPathClean(batch, [subagentStateRoot, packageRoot]);
    assert.equal(batch.children.length, 3);
    assert.equal(batch.timedOut, true);
    assert.deepEqual(batch.nonTerminalChildIds, [running.child.childId]);
    assert.deepEqual(batch.failedChildIds, [failed.child.childId]);

    const closed = parseToolJson(await facade.execute({
      action: 'close_all',
      childIds: [spawn.child.childId, running.child.childId, failed.child.childId, closeFail.child.childId],
      timeoutMs: 1000,
    }));
    assertNoDryRunPath(closed);
    assertPublicPathClean(closed, [subagentStateRoot, packageRoot]);
    assert.equal(closed.children.length, 4);
    assert.ok(closed.closedChildIds.includes(spawn.child.childId));
    assert.ok(closed.cleanupVerifiedChildIds.includes(running.child.childId) || closed.children.find((child) => child.childId === running.child.childId)?.cleanupVerified === false);
    assert.deepEqual(closed.failedCloseChildIds, [closeFail.child.childId]);
    assert.equal(closed.children.find((child) => child.childId === closeFail.child.childId)?.closeError, 'stronk_subagent close failed: simulated installed close failure');
    assert.equal(closed.children.find((child) => child.childId === spawn.child.childId)?.childOutputHandle, null);

    const capacity = parseToolJson(await facade.execute({
      action: 'spawn',
      role: 'executor',
      task: 'installed capacity blocked child',
    }, undefined, undefined, { model: 'installed-smoke/model:xhigh' }));
    assertNoDryRunPath(capacity);
    assertPublicPathClean(capacity, [subagentStateRoot, packageRoot]);
    assert.equal(capacity.child.status, 'failed');
    assert.equal(capacity.child.failureClass, 'provider_capacity');
    assert.equal(capacity.child.retryable, true);
    assert.equal(capacity.child.retryAfterMs, 1000);
    assert.equal(capacity.child.concurrencyInUse, 6);
    assert.equal(capacity.child.concurrencyLimit, 6);
    assert.equal(capacity.child.outputUsableForSynthesis, false);
    assert.equal(capacity.child.childOutputHandle, null);
    assert.equal(capacity.child.childOutputPreview, null);
    assert.equal(capacity.child.recommendedNextAction, 'retry_capacity_children_next_batch');
    assert.doesNotMatch(JSON.stringify(capacity), /concurrent limit reached|slots in use/i);

    const revivedCapacity = parseToolJson(await facade.execute({
      action: 'revive',
      childId: capacity.child.childId,
    }, undefined, undefined, { model: 'installed-smoke/model:xhigh' }));
    assertNoDryRunPath(revivedCapacity);
    assertPublicPathClean(revivedCapacity, [subagentStateRoot, packageRoot]);
    assert.equal(revivedCapacity.previousChildId, capacity.child.childId);
    assert.equal(revivedCapacity.child.previousChildId, capacity.child.childId);
    assert.equal(revivedCapacity.child.status, 'running');
    assert.equal(revivedCapacity.child.upstreamRunId, asyncIds[4]);
    assert.equal(requests.at(-1).params.agent, 'executor');
    assert.equal(requests.at(-1).params.task, 'installed capacity blocked child');
    assert.equal(requests.at(-1).params.model, 'installed-smoke/model:xhigh');
    assert.equal(Object.hasOwn(requests.at(-1).params, 'fallbackModels'), false);
    assert.equal(Object.hasOwn(requests.at(-1).params, 'provider'), false);
    assert.equal(Object.hasOwn(requests.at(-1).params, 'concurrency'), false);

    const capacityClosed = parseToolJson(await facade.execute({
      action: 'close_all',
      childIds: [capacity.child.childId, revivedCapacity.child.childId],
      timeoutMs: 1000,
    }));
    assertNoDryRunPath(capacityClosed);
    assertPublicPathClean(capacityClosed, [subagentStateRoot, packageRoot]);
    assert.equal(capacityClosed.children.length, 2);
    assert.equal(capacityClosed.failedCloseChildIds.length, 0);
  });
} finally {
  rmSync(subagentStateRoot, { recursive: true, force: true });
}

const imageStateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-installed-image-preflight-smoke.'));
try {
  const imagePath = join(imageStateRoot, 'pi-clipboard-smoke.png');
  writeFileSync(imagePath, PNG_BYTES);
  const realImagePath = realpathSync(imagePath);
  let visionCalls = 0;
  const imageNotices = [];
  const imageUiEvents = [];
  const imageResult = await withEnv({
    STRONK_PI_CODEX_HOOK_COMMAND_JSON: allowPromptHookCommandJson(),
    STRONK_PI_STATE_ROOT: join(imageStateRoot, '.stronk-pi'),
    STRONK_PI_IMAGE_PREFLIGHT: '1',
    STRONK_PI_IMAGE_PREFLIGHT_MODEL: 'kimi-coding/kimi-for-coding:xhigh',
    TMPDIR: tmpdir(),
  }, async () => plugin.internals.handleInput(
    {
      text: `${realImagePath}\nwhat do you see`,
      model: 'neuralwatt/glm-5.2:xhigh',
    },
    {
      cwd: packageRoot,
      mode: 'tui',
      hasUI: true,
      ui: {
        notify: (message, kind) => imageNotices.push([kind, message]),
        setStatus: (key, text) => imageUiEvents.push(['status', key, text]),
        setWorkingMessage: (message) => imageUiEvents.push(['workingMessage', message]),
        setWorkingIndicator: (options) => imageUiEvents.push(['workingIndicator', options]),
        setWidget: (key, content, options) => imageUiEvents.push(['widget', key, typeof content, options]),
      },
      visionPreflight: async () => {
        visionCalls += 1;
        return {
          images: [{
            label: 'image-1',
            observed_facts: ['Installed artifact image preflight smoke observed the clipboard image.'],
            inferences: ['The installed plugin can route text-only image prompts through vision preflight.'],
          }],
        };
      },
    },
  ));
  assert.equal(imageResult?.action, 'transform');
  assert.equal(visionCalls, 1);
  assert.match(imageResult.text, /<stronk-pi-image-vision-preflight>/);
  assert.match(imageResult.text.split('<stronk-pi-image-vision-preflight>')[0], /\[image-1; pi-clipboard-smoke\.png]/);
  assert.equal(imageResult.text.split('<stronk-pi-image-vision-preflight>')[0].includes(realImagePath), false);
  assert.match(imageResult.text, /Do not call file or image read tools/);
  assert.match(imageResult.text, /Installed artifact image preflight smoke observed the clipboard image/);
  assert.ok(imageResult.images === undefined || Array.isArray(imageResult.images));
  assert.equal(imageResult.images?.length ?? 0, 0);
  assert.deepEqual(imageNotices, [
    ['info', 'Stronk Pi detected 1 image for a text-only model; analyzing with vision preflight.'],
    ['info', 'Image vision preflight complete: analyzed 1 image.'],
  ]);
  const imageNoticeText = imageNotices.map(([_kind, message]) => message).join('\n');
  assert.equal(imageNoticeText.includes(realImagePath), false);
  assert.equal(imageNoticeText.includes(PNG_BYTES.toString('base64').slice(0, 24)), false);
  assert.deepEqual(imageUiEvents.filter((event) => event[0] === 'status'), [
    ['status', 'stronk-pi-image-vision-preflight', 'image vision: Analyzing 1 image with vision preflight'],
    ['status', 'stronk-pi-image-vision-preflight', undefined],
  ]);
  assert.equal(imageUiEvents.some((event) => event[0] === 'widget' && event[2] === 'function'), true);
  assert.equal(imageUiEvents.some((event) => event[0] === 'widget' && event[2] === 'undefined'), true);
} finally {
  rmSync(imageStateRoot, { recursive: true, force: true });
}

const imageReadStateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-installed-image-read-smoke.'));
try {
  const imagePath = join(imageReadStateRoot, 'tool-discovered-screenshot.png');
  writeFileSync(imagePath, PNG_BYTES);
  const realImagePath = realpathSync(imagePath);
  const imageReadCalls = [];
  const imageReadResult = await withEnv({
    STRONK_PI_STATE_ROOT: join(imageReadStateRoot, '.stronk-pi'),
    STRONK_PI_IMAGE_PREFLIGHT: '1',
    STRONK_PI_IMAGE_PREFLIGHT_MODEL: 'kimi-coding/kimi-for-coding:xhigh',
    TMPDIR: tmpdir(),
  }, async () => plugin.internals.executeImageRead(
    {
      paths: [realImagePath],
      question: `Inspect ${realImagePath}`,
    },
    undefined,
    {
      cwd: imageReadStateRoot,
      visionPreflight: async (request) => {
        imageReadCalls.push(request);
        return {
          images: [{
            label: 'image-1',
            observed_facts: ['Installed artifact image_read smoke observed the screenshot.'],
            inferences: ['The image_read tool can route tool-discovered images through vision preflight.'],
          }],
        };
      },
    },
  ));
  assert.equal(imageReadCalls.length, 1);
  assert.equal(imageReadCalls[0].messages[0].content[0].text.includes(realImagePath), false);
  assert.equal(JSON.stringify(imageReadCalls[0].images).includes(realImagePath), false);
  assert.match(imageReadResult.content[0].text, /Image Read complete: analyzed 1 image/);
  assert.match(imageReadResult.content[0].text, /<stronk-pi-image-read>/);
  assert.match(imageReadResult.content[0].text, /<\/stronk-pi-image-read>/);
  assert.doesNotMatch(imageReadResult.content[0].text, /<stronk-pi-image-vision-preflight>/);
  assert.doesNotMatch(imageReadResult.content[0].text, /<\/stronk-pi-image-vision-preflight>/);
  assert.match(imageReadResult.content[0].text, /Image Evidence Index:/);
  assert.match(imageReadResult.content[0].text, /Installed artifact image_read smoke observed the screenshot/);
  assert.equal(imageReadResult.content[0].text.includes(realImagePath), false);
  assert.equal(JSON.stringify(imageReadResult.details).includes(realImagePath), false);
} finally {
  rmSync(imageReadStateRoot, { recursive: true, force: true });
}

const builtinKimiStateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-installed-builtin-kimi-smoke.'));
try {
  const imagePath = join(builtinKimiStateRoot, 'pi-clipboard-builtin-kimi.png');
  writeFileSync(imagePath, PNG_BYTES);
  const realImagePath = realpathSync(imagePath);
  const fetch = mockFetch({
    content: [{
      type: 'text',
      text: JSON.stringify({
        images: [{
          label: 'image-1',
          observed_facts: ['Installed artifact built-in Kimi fallback observed the image.'],
          inferences: ['The installed plugin can call the built-in Kimi provider fallback.'],
        }],
      }),
    }],
  });
  const builtinKimiResult = await withEnv({
    STRONK_PI_CODEX_HOOK_COMMAND_JSON: allowPromptHookCommandJson(),
    STRONK_PI_STATE_ROOT: join(builtinKimiStateRoot, '.stronk-pi'),
    STRONK_PI_IMAGE_PREFLIGHT: '1',
    STRONK_PI_IMAGE_PREFLIGHT_MODEL: 'kimi-coding/kimi-for-coding:xhigh',
    KIMI_API_KEY: 'installed-smoke-kimi-generic-key',
    KIMI_CODE_API_KEY: 'installed-smoke-kimi-code-fallback-key',
    TMPDIR: tmpdir(),
  }, async () => plugin.internals.handleInput(
    {
      text: `${realImagePath}\nwhat do you see`,
      model: 'neuralwatt/glm-5.2:xhigh',
    },
    {
      cwd: packageRoot,
      fetch,
    },
  ));
  assert.equal(builtinKimiResult?.action, 'transform');
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, 'https://api.kimi.com/coding/v1/messages');
  assert.equal(fetch.calls[0].init.headers['x-api-key'], 'installed-smoke-kimi-generic-key');
  assert.equal(fetch.calls[0].init.headers['User-Agent'], 'KimiCLI/1.5');
  const builtinKimiPayload = JSON.parse(fetch.calls[0].init.body);
  assert.equal(builtinKimiPayload.max_tokens, 4096);
  assert.match(builtinKimiResult.text, /Installed artifact built-in Kimi fallback observed the image/);
  assert.equal(builtinKimiResult.images?.length ?? 0, 0);
} finally {
  rmSync(builtinKimiStateRoot, { recursive: true, force: true });
}

const cjkTitle = '【瀚铠（VASTARMOR）R9700】瀚铠（VASTARMOR）AMD RADEON AI PRO R9700 AI工作站专业显卡 32GB AI开发 高性能工作站 支持多GPU扩展【行情 报价 价格 评测】-京东';
const longUrl = `https://example.com/${'amd-radeon-ai-pro-r9700-'.repeat(12)}?token=${'secret-looking-value-'.repeat(8)}`;
const emojiTitle = `${'⚠️'.repeat(40)} ${'❤️'.repeat(40)} terminal width check`;

for (const width of [20, 40, 60, 120, 149]) {
  renderText(byName.get('web_search').renderCall({
    workflow: 'summary-review\nspoof=true\u202E',
    queries: ['Radeon R9700 京东 price', longUrl, emojiTitle],
  }, {}, {}), width);
  renderText(byName.get('web_search').renderResult({
    details: {
      provider: 'exa',
      workflow: 'summary-review',
      count: 2,
      queryStates: [{ id: 'q1', status: 'complete', query: 'Radeon R9700 京东 price', resultCount: 2 }],
      results: [
        { rank: 1, title: cjkTitle, url: 'https://item.jd.com/100318052056.html', qualitySignals: ['same-host-3'] },
        { rank: 2, title: emojiTitle, url: longUrl, sourceKind: 'web', sourceReliability: 'unknown' },
      ],
    },
  }, {}, {}, {}), width);
  const fetchRendered = renderText(byName.get('fetch_content').renderResult({
    content: [{ type: 'text', text: `${cjkTitle}\n${longUrl}\nRAW_FETCH_BODY_SENTINEL` }],
    details: {
      urls: [longUrl],
      finalUrl: longUrl,
      title: cjkTitle,
      statusCode: 200,
      successful: 1,
    },
  }, {}, {}, {}), width);
  assert.doesNotMatch(fetchRendered, /RAW_FETCH_BODY_SENTINEL|secret-looking-value/);
}

const secret = `sk-${'s'.repeat(24)}`;
const updates = [];
const result = await plugin.internals.executeWebSearch(
  { query: 'CLI smoke search', workflow: 'summary-review', count: 1 },
  undefined,
  (update) => updates.push(update),
  {
    env: { STRONK_PI_SEARCH_PROVIDER: 'exa', EXA_API_KEY: secret },
    fetch: mockFetch({
      results: [{
        title: 'Smoke \x1b[31mResult\u202E',
        url: 'https://example.com/smoke',
        highlights: ['Snippet with token=<redacted> and \x1b]8;;https://example.com\x07control\u202E'],
      }],
    }),
    ctx: { hasUI: true },
    state: {},
  },
);

const serialized = JSON.stringify({ result, updates });
const renderedResult = renderText(byName.get('web_search').renderResult(result, {}, {}, {}), 149);
const visibleText = [
  renderedResult,
  ...updates.map((update) => update.content?.[0]?.text ?? ''),
].join('\n');
assert.equal(result.details.workflow, 'summary-review');
assert.equal(result.details.browserCurator, undefined);
assert.match(result.details.reviewId, /^search-review-\d+$/);
assert.match(result.details.results[0].title, /Smoke Result/);
assert.match(result.details.results[0].snippet, /Snippet with token=/);
assert.match(result.content?.[0]?.text ?? '', /Result records for model:/);
assert.match(result.content?.[0]?.text ?? '', /Smoke Result/);
assert.match(result.content?.[0]?.text ?? '', /searchResultUrl: https:\/\/example\.com\/smoke/);
assert.match(result.content?.[0]?.text ?? '', /Snippet with token=/);
assert.doesNotMatch(result.details.results[0].snippet, new RegExp(secret));
assert.doesNotMatch(visibleText, /Smoke Result|https:\/\/example\.com\/smoke|Snippet with token/);
assert.ok(updates.length > 0);
assert.doesNotMatch(serialized, new RegExp(secret));
assert.doesNotMatch(serialized, /\x1b|\u202E/);

const metadataReviewState = {};
const metadataResult = await plugin.internals.executeWebSearch(
  { query: 'official Playwright vs Cypress docs 2026', workflow: 'summary-review', count: 2 },
  undefined,
  () => {},
  {
    env: { STRONK_PI_SEARCH_PROVIDER: 'exa', EXA_API_KEY: secret },
    fetch: mockFetch({
      results: [
        {
          title: 'Medium Playwright Cypress comparison 2026',
          url: 'https://medium.com/@example/playwright-cypress-2026',
          highlights: ['Third-party comparison with useful but fetch-risk content.'],
        },
        {
          title: 'Cypress Migration Guide',
          url: 'https://docs.cypress.io/app/guides/migration/playwright-to-cypress',
          highlights: ['Official Cypress documentation for migration context.'],
        },
      ],
    }),
    ctx: { hasUI: true },
    reviewState: metadataReviewState,
  },
);
assert.equal(metadataResult.details.results[0].url, 'https://docs.cypress.io/app/guides/migration/playwright-to-cypress');
const restrictedResult = metadataResult.details.results.find((item) => item.url.startsWith('https://medium.com/'));
assert.equal(restrictedResult?.sourceAccessibility, 'restricted');
assert.ok(restrictedResult?.qualitySignals?.includes('fetch-risk'));
assert.match(metadataResult.content?.[0]?.text ?? '', /sourceAccessibility: restricted/);
const metadataReviewId = metadataResult.details.review.reviewId;
const bulkKeep = await plugin.internals.executeWebSearch(
  { curatorAction: 'keep', reviewId: metadataReviewId, resultRanks: [1, 2] },
  undefined,
  undefined,
  { reviewState: metadataReviewState },
);
assert.match(bulkKeep.content?.[0]?.text ?? '', /Kept 2 results/);
const finishedReview = await plugin.internals.executeWebSearch(
  { curatorAction: 'finish', reviewId: metadataReviewId },
  undefined,
  undefined,
  { reviewState: metadataReviewState },
);
assert.equal(finishedReview.details.review.keptResults.length, 2);
assert.ok(finishedReview.details.review.keptResults.every((item) => item.fetchRecommendedBeforeUse === true));
assert.match(finishedReview.content?.[0]?.text ?? '', /Content: snippet-only; fetch_content recommended before citation/);

if (runInstalledAgentSmoke) {
  const agentRunRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-installed-agent-run-smoke.'));
  try {
    const promptPath = join(agentRunRoot, 'installed-agent-run.prompt.md');
    writeFileSync(promptPath, [
      'Use only the `stronk_subagent` tool.',
      'Do not call the raw upstream subagent tool.',
      'Run this through a real child agent execution path.',
      'If the child result indicates a mocked worker, skipped child execution, or no launched worker, stop and report failure.',
      '',
      '1. Spawn three role `executor` children with tasks that do not modify files.',
      '   Child A must return a long output containing the token below, plus a fake local path `/tmp/stronk-pi-should-redact`, plus `password=supersecret123`, plus enough filler text that the preview is truncated and a `childOutputHandle` is produced.',
      '   Child B must stay non-terminal for at least 30 seconds before returning exactly `STATUS_TOKEN=STRONK_PI_WAIT_ALL_RUNNING_CHILD_DONE`.',
      '   Child C must visibly report a failure or failed finding without modifying files.',
      '',
      '```text',
      'STATUS_TOKEN=STRONK_PI_INSTALLED_AGENT_RUN_OK',
      '```',
      '',
      '2. Call `wait_all` with all three child IDs and `timeoutMs=1000` before Child B finishes.',
      '3. Confirm the parent-visible batch result has exactly three children in request order, no `cwd`, no raw local paths, no debug artifact paths, failure visibility for Child C, and one non-terminal timeout entry for Child B.',
      '4. Use `read_output` on Child A `childOutputHandle` with chunking. Confirm the handle is opaque, output is redacted, and no raw output path is visible.',
      '5. Call `close_all` on all three child IDs and confirm per-child cleanup fields are present. Confirm close failure arrays are visible in the schema, even if all real closes succeed.',
      '6. Run negative checks through `stronk_subagent`: duplicate child ID in `wait_all` must be denied, a foreign child ID must be denied, and an invalid output handle must be denied.',
      '7. Recheck any file-line citations in the final answer against current files if you cite a file.',
      '8. Final answer must include exactly these lines:',
      '',
      '```text',
      'STATUS_TOKEN=STRONK_PI_INSTALLED_AGENT_RUN_OK',
      'STATUS_TOKEN=STRONK_PI_PUBLIC_PATH_REDACTION_OK',
      'NO_CWD_IN_PUBLIC_RESULT=true',
      'DEBUG_ARTIFACT_PATHS_NOT_PUBLIC=true',
      'STATUS_TOKEN=STRONK_PI_WAIT_ALL_OK',
      'WAIT_ALL_CHILDREN=3',
      'WAIT_ALL_TIMEOUT_NONTERMINAL=true',
      'WAIT_ALL_FAILURE_VISIBLE=true',
      'STATUS_TOKEN=STRONK_PI_READ_OUTPUT_OK',
      'OUTPUT_HANDLE_OPAQUE=true',
      'READ_OUTPUT_CHUNKED=true',
      'READ_OUTPUT_REDACTED=true',
      'NO_RAW_OUTPUT_PATH=true',
      'STATUS_TOKEN=STRONK_PI_BATCH_CLOSE_OK',
      'CLEANUP_REPORTED_PER_CHILD=true',
      'CLOSE_FAILURE_NOT_HIDDEN=true',
      'STATUS_TOKEN=STRONK_PI_NEGATIVE_BATCH_OK',
      'DUPLICATE_CHILD_DENIED=true',
      'FOREIGN_CHILD_DENIED=true',
      'INVALID_OUTPUT_HANDLE_DENIED=true',
      'STATUS_TOKEN=STRONK_PI_CITATION_OK',
      'FILE_LINE_RECHECKED_AT_SYNTHESIS=true',
      '```',
      '',
    ].join('\n'));

    const stronkpi = process.env.STRONK_PI_SMOKE_STRONKPI || 'stronkpi';
    const model = process.env.STRONK_PI_SMOKE_MODEL || 'deepseek/deepseek-v4-pro:high';
    const run = spawnSync(stronkpi, ['--model', model, '--no-session', '-p', `@${promptPath}`], {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: Number(process.env.STRONK_PI_SMOKE_AGENT_TIMEOUT_MS || 3600000),
      env: process.env,
      maxBuffer: 1024 * 1024 * 20,
    });
    const combined = `${run.stdout || ''}\n${run.stderr || ''}`;
    assertNoSkippedChildText(combined);
    assert.equal(run.status, 0, `installed agent-run smoke failed with status ${run.status}\n${combined}`);
    assert.match(combined, /STATUS_TOKEN=STRONK_PI_INSTALLED_AGENT_RUN_OK/);
    assert.match(combined, /STATUS_TOKEN=STRONK_PI_PUBLIC_PATH_REDACTION_OK/);
    assert.match(combined, /NO_CWD_IN_PUBLIC_RESULT=true/);
    assert.match(combined, /DEBUG_ARTIFACT_PATHS_NOT_PUBLIC=true/);
    assert.match(combined, /STATUS_TOKEN=STRONK_PI_WAIT_ALL_OK/);
    assert.match(combined, /WAIT_ALL_CHILDREN=3/);
    assert.match(combined, /WAIT_ALL_TIMEOUT_NONTERMINAL=true/);
    assert.match(combined, /WAIT_ALL_FAILURE_VISIBLE=true/);
    assert.match(combined, /STATUS_TOKEN=STRONK_PI_READ_OUTPUT_OK/);
    assert.match(combined, /OUTPUT_HANDLE_OPAQUE=true/);
    assert.match(combined, /READ_OUTPUT_CHUNKED=true/);
    assert.match(combined, /READ_OUTPUT_REDACTED=true/);
    assert.match(combined, /NO_RAW_OUTPUT_PATH=true/);
    assert.match(combined, /STATUS_TOKEN=STRONK_PI_BATCH_CLOSE_OK/);
    assert.match(combined, /CLEANUP_REPORTED_PER_CHILD=true/);
    assert.match(combined, /CLOSE_FAILURE_NOT_HIDDEN=true/);
    assert.match(combined, /STATUS_TOKEN=STRONK_PI_NEGATIVE_BATCH_OK/);
    assert.match(combined, /DUPLICATE_CHILD_DENIED=true/);
    assert.match(combined, /FOREIGN_CHILD_DENIED=true/);
    assert.match(combined, /INVALID_OUTPUT_HANDLE_DENIED=true/);
    assert.match(combined, /STATUS_TOKEN=STRONK_PI_CITATION_OK/);
    assert.match(combined, /FILE_LINE_RECHECKED_AT_SYNTHESIS=true/);
  } finally {
    rmSync(agentRunRoot, { recursive: true, force: true });
  }
}

console.log(`installed artifact smoke: ok (${pluginPath})`);
