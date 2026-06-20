import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubagentFacade } from '../src/subagents/facade.mjs';
import { PiSubagentsBridgeAdapter } from '../src/subagents/adapters/pi-subagents-bridge.mjs';
import { SubagentLedger } from '../src/subagents/ledger.mjs';

function withEnv(env, fn) {
  const old = {};
  for (const key of Object.keys(env)) {
    old[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
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

function parseResult(result) {
  return JSON.parse(result.text);
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

class FakeEvents {
  constructor() {
    this.emitter = new EventEmitter();
    this.emitted = [];
  }

  on(event, handler) {
    this.emitter.on(event, handler);
    return () => this.emitter.off(event, handler);
  }

  emit(event, data) {
    this.emitted.push({ event, data });
    this.emitter.emit(event, data);
  }
}

test('stronk_subagent schema denies upstream override fields before adapter calls', async () => {
  const adapter = {
    calls: [],
    async spawn() {
      this.calls.push('spawn');
    },
  };
  const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });

  await assert.rejects(
    () => execute({ action: 'spawn', role: 'executor', task: 'do read-only work', tools: ['bash'] }),
    /stronk_subagent override denied: tools/,
  );
  assert.deepEqual(adapter.calls, []);

  await assert.rejects(
    () => execute({ action: 'resume', target: 'child-1' }),
    /stronk_subagent action denied: resume/,
  );
});

test('stronk_subagent denies spawn without launcher role manifest', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-missing-manifest.'));

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_ROLE_MANIFEST: undefined,
    STRONK_PI_FACADE_RUN_ID: 'facade-missing-manifest-run',
  }, async () => {
    const execute = createSubagentFacade();
    await assert.rejects(
      () => execute({ action: 'spawn', role: 'executor', task: 'must not run without manifest' }),
      /stronk_subagent role manifest required/,
    );
  });
});

test('stronk_subagent allows manifest-listed role without test allowlist', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-manifest-role.'));
  const manifestRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-role-manifest.'));
  const rolesDir = join(manifestRoot, 'roles');
  mkdirSync(rolesDir);
  writeFileSync(join(rolesDir, 'executor.toml'), 'name = "executor"\n');
  const manifestPath = join(manifestRoot, 'roles.toml');
  writeFileSync(manifestPath, 'codex_roles_dir = "roles"\n');

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_ROLE_MANIFEST: manifestPath,
    STRONK_PI_FACADE_RUN_ID: 'facade-manifest-role-run',
  }, async () => {
    const execute = createSubagentFacade();
    const result = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'manifest-approved role' }));

    assert.equal(result.child.status, 'completed');
    assert.equal(result.child.role, 'executor');
  });
});

test('stronk_subagent dry-run spawn writes private redacted ledger state', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-state.'));
  const task = 'inspect without leaking FAKE_SECRET_VALUE_1234567890';

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-test-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'dry-run',
    STRONK_PI_RAW_SUBAGENT: 'enabled',
    STRONK_PI_FACADE_DEBUG: '1',
  }, async () => {
    const execute = createSubagentFacade({ allowedRoles: new Set(['executor']) });
    const result = parseResult(await execute({ action: 'spawn', role: 'executor', task }));
    const artifacts = result.artifacts;

    assert.equal(result.child.status, 'completed');
    assert.equal(mode(artifacts.runDir), 0o700);
    assert.equal(mode(artifacts.manifest), 0o600);
    assert.equal(mode(artifacts.children), 0o600);
    assert.equal(mode(artifacts.events), 0o600);

    const children = readFileSync(artifacts.children, 'utf8');
    const events = readFileSync(artifacts.events, 'utf8');
    assert.match(children, /taskSha256/);
    assert.match(events, /taskSha256/);
    assert.doesNotMatch(children, /FAKE_SECRET_VALUE/);
    assert.doesNotMatch(events, /FAKE_SECRET_VALUE/);
    assert.doesNotMatch(children, /inspect without leaking/);
  });
});

test('stronk_subagent ledger serializes concurrent child writes', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-ledger-race.'));

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
  }, async () => {
    const ledger = await new SubagentLedger({
      cwd: stateRoot,
      mode: 'test',
      facadeRunId: 'facade-ledger-race-run',
      maxChildren: 24,
    }).init();

    await Promise.all(
      Array.from({ length: 20 }, (_, index) => ledger.createChild({
        role: 'executor',
        task: `parallel child ${index}`,
      })),
    );

    const children = await ledger.children();
    assert.equal(children.length, 20);
    assert.equal(new Set(children.map((child) => child.childId)).size, 20);

    const events = readFileSync(ledger.artifactPaths().events, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.event === 'child_spawned').length, 20);
  });
});

test('stronk_subagent ledger initializes shared run state without overwriting concurrent children', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-ledger-init-race.'));
  const facadeRunId = 'facade-ledger-init-race-run';

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
  }, async () => {
    const ledgers = await Promise.all(
      Array.from({ length: 20 }, async (_, index) => {
        const ledger = await new SubagentLedger({
          cwd: stateRoot,
          mode: 'test',
          facadeRunId,
          maxChildren: 24,
        }).init();
        await ledger.createChild({
          role: 'executor',
          task: `parallel init child ${index}`,
        });
        return ledger;
      }),
    );

    const ledger = ledgers[0];
    const children = await ledger.children();
    assert.equal(children.length, 20);
    assert.equal(new Set(children.map((child) => child.childId)).size, 20);

    const events = readFileSync(ledger.artifactPaths().events, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.event === 'child_spawned').length, 20);
  });
});

test('stronk_subagent normalizes guard-approved role aliases', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-alias.'));

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-alias-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'dry-run',
  }, async () => {
    const execute = createSubagentFacade({ allowedRoles: new Set(['executor']) });
    const result = parseResult(await execute({ action: 'spawn', role: 'delegate', task: 'finish immediately' }));

    assert.equal(result.child.role, 'executor');
  });
});

test('stronk_subagent denies send_input to terminal dry-run child', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-send.'));

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-send-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'dry-run',
    STRONK_PI_FACADE_DEBUG: '1',
  }, async () => {
    const execute = createSubagentFacade({ allowedRoles: new Set(['executor']) });
    const spawn = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'finish immediately' }));
    await assert.rejects(
      () => execute({ action: 'send_input', childId: spawn.child.childId, message: 'continue' }),
      /send_input denied: child is terminal or has no registered intercom target/,
    );
    const events = readFileSync(spawn.artifacts.events, 'utf8');
    assert.match(events, /send_input_denied/);
    assert.match(events, /terminal_or_missing_intercom_target/);
    assert.doesNotMatch(events, /continue/);
  });
});

test('stronk_subagent close is idempotent for terminal dry-run child', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-close-terminal.'));

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-close-terminal-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'dry-run',
  }, async () => {
    const execute = createSubagentFacade({ allowedRoles: new Set(['executor']) });
    const spawn = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'finish immediately' }));
    const closed = parseResult(await execute({ action: 'close', childId: spawn.child.childId }));

    assert.equal(closed.child.status, 'completed');
    assert.equal(closed.child.cleanupState, 'already_closed');
  });
});

test('stronk_subagent revive creates a new child linked to previous terminal child', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-revive.'));

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-revive-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'dry-run',
    STRONK_PI_FACADE_DEBUG: '1',
  }, async () => {
    const execute = createSubagentFacade({ allowedRoles: new Set(['executor']) });
    const spawn = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'finish first' }));
    const revived = parseResult(await execute({ action: 'revive', childId: spawn.child.childId, task: 'revived task' }));

    assert.equal(revived.previousChildId, spawn.child.childId);
    assert.notEqual(revived.child.childId, spawn.child.childId);
    assert.equal(revived.child.previousChildId, spawn.child.childId);
    assert.equal(revived.child.status, 'completed');
  });
});

test('stronk_subagent keeps one ledger across lifecycle actions without env run id', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-stable-run.'));

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: undefined,
    STRONK_PI_SUBAGENT_ADAPTER: 'dry-run',
    STRONK_PI_FACADE_DEBUG: '1',
  }, async () => {
    const execute = createSubagentFacade({ allowedRoles: new Set(['executor']) });
    const spawn = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'finish immediately' }));
    const status = parseResult(await execute({ action: 'status', childId: spawn.child.childId }));

    assert.equal(status.child.childId, spawn.child.childId);
    assert.equal(status.artifacts.runDir, spawn.artifacts.runDir);
  });
});

test('stronk_subagent intercom adapter delegates through Pi subagent slash bridge', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-bridge.'));
  const asyncRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-upstream.'));
  const asyncId = 'async-test-run';
  const asyncDir = join(asyncRoot, 'async-subagent-runs', asyncId);
  const resultDir = join(asyncRoot, 'async-subagent-results');
  const resultPath = join(resultDir, `${asyncId}.json`);
  const events = new FakeEvents();
  const capturedRequests = [];
  const fakeSecret = `sk-${'1234567890abcdefghijklmnop'}`;

  events.on('subagent:slash:request', (request) => {
    capturedRequests.push(request);
    events.emit('subagent:slash:started', { requestId: request.requestId });
    events.emit('subagent:slash:update', { requestId: request.requestId, currentTool: 'read', toolCount: 1 });
    mkdirSync(asyncDir, { recursive: true });
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(join(asyncDir, 'status.json'), JSON.stringify({
      runId: asyncId,
      mode: 'single',
      state: 'running',
      startedAt: Date.now(),
      lastUpdate: Date.now(),
      pid: process.pid,
      cwd: stateRoot,
      steps: [{ agent: 'executor', status: 'running' }],
    }, null, 2));
    events.emit('subagent:async-started', { id: asyncId, asyncDir, pid: process.pid, mode: 'single', agent: 'executor' });
    events.emit('subagent:slash:response', {
      requestId: request.requestId,
      isError: false,
      result: {
        content: [{ type: 'text', text: `Async: executor [${asyncId}]` }],
        details: {
          mode: 'single',
          results: [],
          asyncId,
          asyncDir,
        },
      },
    });
  });

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-bridge-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'intercom',
    STRONK_PI_FACADE_DEBUG: '1',
  }, async () => {
    const adapter = new PiSubagentsBridgeAdapter({ events, timeoutMs: 1000 });
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const task = 'do not persist this exact child prompt';
    const spawn = parseResult(await execute({ action: 'spawn', role: 'executor', task }));

    assert.equal(spawn.child.status, 'running');
    assert.equal(spawn.child.upstreamRunId, asyncId);
    assert.equal(spawn.child.intercomTarget, `subagent-executor-${asyncId}-1`);
    assert.ok(!JSON.stringify(spawn).includes(fakeSecret));
    assert.equal(capturedRequests.length, 1);
    assert.deepEqual(Object.keys(capturedRequests[0].params).sort(), [
      'agent',
      'artifacts',
      'async',
      'context',
      'cwd',
      'progress',
      'task',
    ]);
    assert.equal(capturedRequests[0].params.agent, 'executor');
    assert.equal(capturedRequests[0].params.context, 'fresh');
    assert.equal(capturedRequests[0].params.async, true);
    assert.equal(capturedRequests[0].params.task, task);

    writeFileSync(join(asyncDir, 'status.json'), JSON.stringify({
      runId: asyncId,
      mode: 'single',
      state: 'complete',
      startedAt: Date.now() - 1000,
      endedAt: Date.now(),
      lastUpdate: Date.now(),
      pid: process.pid,
      cwd: stateRoot,
      sessionFile: '/tmp/stronk-pi-session.jsonl',
      steps: [{ agent: 'executor', status: 'complete', exitCode: 0 }],
    }, null, 2));
    writeFileSync(resultPath, JSON.stringify({
      id: asyncId,
      mode: 'single',
      state: 'complete',
      success: true,
      summary: `bridge-completed ${fakeSecret}`,
      results: [{ agent: 'executor', output: `bridge-completed ${fakeSecret}`, success: true }],
      exitCode: 0,
      sessionFile: '/tmp/stronk-pi-session.jsonl',
    }, null, 2));

    const waited = parseResult(await execute({ action: 'wait', childId: spawn.child.childId, timeoutMs: 1000 }));
    assert.equal(waited.child.status, 'completed');
    assert.equal(waited.child.terminalResult, 'completed');
    assert.equal(waited.child.terminalResultBytes > 0, true);
    assert.match(waited.child.terminalResultSha256, /^[a-f0-9]{64}$/);
    const waitedAgain = parseResult(await execute({ action: 'wait', childId: spawn.child.childId, timeoutMs: 1000 }));
    assert.equal(waitedAgain.child.status, 'completed');

    const children = readFileSync(spawn.artifacts.children, 'utf8');
    const eventsText = readFileSync(spawn.artifacts.events, 'utf8');
    const eventRows = eventsText
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(eventRows.filter((event) => event.event === 'child_completed').length, 1);
    assert.match(children, /taskSha256/);
    assert.match(eventsText, /bridge_async_started/);
    assert.doesNotMatch(children, /do not persist this exact child prompt/);
    assert.doesNotMatch(eventsText, /do not persist this exact child prompt/);
    assert.doesNotMatch(children, /bridge-completed/);
    assert.doesNotMatch(eventsText, /bridge-completed/);
    assert.ok(!children.includes(fakeSecret));
    assert.ok(!eventsText.includes(fakeSecret));
  });
});

test('stronk_subagent intercom adapter sends live input through upstream resume', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-input.'));
  const asyncRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-upstream-input.'));
  const asyncId = 'async-input-run';
  const asyncDir = join(asyncRoot, 'async-subagent-runs', asyncId);
  const events = new FakeEvents();
  const capturedRequests = [];

  events.on('subagent:slash:request', (request) => {
    capturedRequests.push(request);
    events.emit('subagent:slash:started', { requestId: request.requestId });
    if (request.params.action === 'resume') {
      events.emit('subagent:slash:response', {
        requestId: request.requestId,
        isError: false,
        result: {
          content: [{ type: 'text', text: `Delivered follow-up to live async child.\nRun: ${asyncId}` }],
          details: { mode: 'management', results: [] },
        },
      });
      return;
    }

    mkdirSync(asyncDir, { recursive: true });
    writeFileSync(join(asyncDir, 'status.json'), JSON.stringify({
      runId: asyncId,
      mode: 'single',
      state: 'running',
      startedAt: Date.now(),
      lastUpdate: Date.now(),
      pid: process.pid,
      cwd: stateRoot,
      steps: [{ agent: 'executor', status: 'running' }],
    }, null, 2));
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
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-input-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'intercom',
    STRONK_PI_FACADE_DEBUG: '1',
  }, async () => {
    const adapter = new PiSubagentsBridgeAdapter({ events, timeoutMs: 1000 });
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const spawn = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'stay alive for follow-up' }));
    const sent = parseResult(await execute({ action: 'send_input', childId: spawn.child.childId, message: 'continue with scoped check', timeoutMs: 1000 }));

    assert.equal(sent.child.status, 'running');
    assert.equal(capturedRequests.length, 2);
    assert.equal(capturedRequests[1].params.action, 'resume');
    assert.equal(capturedRequests[1].params.id, asyncId);
    assert.equal(capturedRequests[1].params.message, 'continue with scoped check');
  });
});

test('stronk_subagent intercom close refreshes already-terminal upstream before interrupt', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-close-terminal-upstream.'));
  const asyncRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-upstream-close-terminal.'));
  const asyncId = 'async-close-terminal-run';
  const asyncDir = join(asyncRoot, 'async-subagent-runs', asyncId);
  const resultDir = join(asyncRoot, 'async-subagent-results');
  const resultPath = join(resultDir, `${asyncId}.json`);
  const events = new FakeEvents();
  const capturedRequests = [];

  events.on('subagent:slash:request', (request) => {
    capturedRequests.push(request);
    events.emit('subagent:slash:started', { requestId: request.requestId });
    if (request.params.action === 'interrupt') {
      events.emit('subagent:slash:response', {
        requestId: request.requestId,
        isError: true,
        result: { content: [{ type: 'text', text: 'No interrupt-capable run found in this session' }] },
      });
      return;
    }

    mkdirSync(asyncDir, { recursive: true });
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(join(asyncDir, 'status.json'), JSON.stringify({
      runId: asyncId,
      mode: 'single',
      state: 'running',
      startedAt: Date.now(),
      lastUpdate: Date.now(),
      pid: process.pid,
      cwd: stateRoot,
      steps: [{ agent: 'executor', status: 'running' }],
    }, null, 2));
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
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-close-terminal-upstream-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'intercom',
  }, async () => {
    const adapter = new PiSubagentsBridgeAdapter({ events, timeoutMs: 1000 });
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const spawn = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'finish upstream before close' }));

    writeFileSync(join(asyncDir, 'status.json'), JSON.stringify({
      runId: asyncId,
      mode: 'single',
      state: 'complete',
      startedAt: Date.now() - 1000,
      endedAt: Date.now(),
      lastUpdate: Date.now(),
      pid: process.pid,
      cwd: stateRoot,
      steps: [{ agent: 'executor', status: 'complete', exitCode: 0 }],
    }, null, 2));
    writeFileSync(resultPath, JSON.stringify({
      id: asyncId,
      mode: 'single',
      state: 'complete',
      success: true,
      summary: 'completed before close',
      results: [{ agent: 'executor', output: 'completed before close', success: true }],
      exitCode: 0,
    }, null, 2));

    const closed = parseResult(await execute({ action: 'close', childId: spawn.child.childId, timeoutMs: 1000 }));

    assert.equal(closed.child.status, 'completed');
    assert.equal(closed.child.cleanupState, 'already_closed');
    assert.equal(capturedRequests.some((request) => request.params.action === 'interrupt'), false);
  });
});

test('stronk_subagent intercom adapter does not mark interrupt failure as terminal', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-interrupt-fail.'));
  const asyncRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-upstream-interrupt-fail.'));
  const asyncId = 'async-interrupt-fail-run';
  const asyncDir = join(asyncRoot, 'async-subagent-runs', asyncId);
  const events = new FakeEvents();

  events.on('subagent:slash:request', (request) => {
    events.emit('subagent:slash:started', { requestId: request.requestId });
    if (request.params.action === 'interrupt') {
      events.emit('subagent:slash:response', {
        requestId: request.requestId,
        isError: true,
        result: { content: [{ type: 'text', text: 'interrupt failed with sensitive output body' }] },
      });
      return;
    }

    mkdirSync(asyncDir, { recursive: true });
    writeFileSync(join(asyncDir, 'status.json'), JSON.stringify({
      runId: asyncId,
      mode: 'single',
      state: 'running',
      startedAt: Date.now(),
      lastUpdate: Date.now(),
      pid: process.pid,
      cwd: stateRoot,
      steps: [{ agent: 'executor', status: 'running' }],
    }, null, 2));
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
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-interrupt-fail-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'intercom',
    STRONK_PI_FACADE_DEBUG: '1',
  }, async () => {
    const adapter = new PiSubagentsBridgeAdapter({ events, timeoutMs: 1000 });
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const spawn = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'stay alive' }));

    await assert.rejects(
      () => execute({ action: 'interrupt', childId: spawn.child.childId, timeoutMs: 1000 }),
      /interrupt failed/,
    );

    const status = parseResult(await execute({ action: 'status', childId: spawn.child.childId }));
    assert.equal(status.child.status, 'running');
    assert.equal(status.child.cleanupState, 'interrupt_failed');

    const children = readFileSync(spawn.artifacts.children, 'utf8');
    const eventsText = readFileSync(spawn.artifacts.events, 'utf8');
    assert.doesNotMatch(children, /sensitive output body/);
    assert.doesNotMatch(eventsText, /sensitive output body/);
    assert.match(eventsText, /bridge_interrupt_error/);
    assert.match(eventsText, /errorSha256/);
  });
});

test('stronk_subagent intercom adapter does not mark close failure as terminal', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-close-fail.'));
  const asyncRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-upstream-close-fail.'));
  const asyncId = 'async-close-fail-run';
  const asyncDir = join(asyncRoot, 'async-subagent-runs', asyncId);
  const events = new FakeEvents();

  events.on('subagent:slash:request', (request) => {
    events.emit('subagent:slash:started', { requestId: request.requestId });
    if (request.params.action === 'interrupt') {
      events.emit('subagent:slash:response', {
        requestId: request.requestId,
        isError: true,
        result: { content: [{ type: 'text', text: 'close failed with sensitive output body' }] },
      });
      return;
    }

    mkdirSync(asyncDir, { recursive: true });
    writeFileSync(join(asyncDir, 'status.json'), JSON.stringify({
      runId: asyncId,
      mode: 'single',
      state: 'running',
      startedAt: Date.now(),
      lastUpdate: Date.now(),
      pid: process.pid,
      cwd: stateRoot,
      steps: [{ agent: 'executor', status: 'running' }],
    }, null, 2));
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
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-close-fail-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'intercom',
    STRONK_PI_FACADE_DEBUG: '1',
  }, async () => {
    const adapter = new PiSubagentsBridgeAdapter({ events, timeoutMs: 1000 });
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const spawn = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'stay alive' }));

    await assert.rejects(
      () => execute({ action: 'close', childId: spawn.child.childId, timeoutMs: 1000 }),
      /close failed/,
    );

    const status = parseResult(await execute({ action: 'status', childId: spawn.child.childId }));
    assert.equal(status.child.status, 'running');
    assert.equal(status.child.cleanupState, 'close_failed');

    const children = readFileSync(spawn.artifacts.children, 'utf8');
    const eventsText = readFileSync(spawn.artifacts.events, 'utf8');
    assert.doesNotMatch(children, /sensitive output body/);
    assert.doesNotMatch(eventsText, /sensitive output body/);
    assert.match(eventsText, /bridge_close_error/);
    assert.match(eventsText, /errorSha256/);
  });
});
