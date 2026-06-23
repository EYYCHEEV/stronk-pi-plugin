#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const home = homedir();
const stateRoot = process.env.STRONK_PI_STATE_ROOT || join(home, '.stronk-pi');
const runtimeRoot = process.env.STRONK_PI_SMOKE_RUNTIME || join(stateRoot, 'pi-fork-runtime');
const pluginPath = process.env.STRONK_PI_SMOKE_PLUGIN
  || join(stateRoot, 'artifacts/stronk-pi-plugin-0.1.0/package/src/index.mjs');

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
