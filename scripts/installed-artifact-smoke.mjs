#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  await withEnv({
    STRONK_PI_SUBAGENT_FACADE: 'stronk',
    STRONK_PI_SUBAGENT_ADAPTER: 'dry-run',
    STRONK_PI_STATE_ROOT: subagentStateRoot,
    STRONK_PI_FACADE_RUN_ID: 'installed-subagent-smoke',
    STRONK_PI_FACADE_DEBUG: '1',
  }, async () => {
    const subagentTools = [];
    await plugin.default({
      on: () => {},
      registerTool: (tool) => subagentTools.push(tool),
    });
    const subagentByName = new Map(subagentTools.map((tool) => [tool.name, tool]));
    assert.ok(subagentByName.has('stronk_subagent'));
    assert.equal(subagentByName.has('subagent'), false);

    const execute = plugin.internals.createSubagentFacade({ allowedRoles: new Set(['executor']) });
    const result = JSON.parse((await execute({
      action: 'spawn',
      role: 'executor',
      task: 'installed artifact subagent dry-run smoke',
    })).text);
    assert.equal(result.child.status, 'dry-run');
    assert.equal(result.child.terminalResult, 'dry-run-completed');
    assert.equal(result.child.pid, null);
    assert.deepEqual(result.warnings?.map((warning) => warning.code), ['dry_run_no_worker']);
    assert.doesNotMatch(readFileSync(result.artifacts.manifest, 'utf8'), /raw_subagent/);
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

console.log(`installed artifact mock smoke: ok (${pluginPath})`);
