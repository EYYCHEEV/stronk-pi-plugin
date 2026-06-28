import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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

function ledgerArtifactsForRun(stateRoot, runId) {
  const projectsRoot = join(stateRoot, 'projects');
  const [projectHash] = readdirSync(projectsRoot);
  const runDir = join(projectsRoot, projectHash, 'facade-runs', runId);
  return {
    runDir,
    manifest: join(runDir, 'manifest.json'),
    children: join(runDir, 'children.json'),
    events: join(runDir, 'events.ndjson'),
  };
}

function ledgerChildrenForRun(stateRoot, runId) {
  return JSON.parse(readFileSync(ledgerArtifactsForRun(stateRoot, runId).children, 'utf8')).children;
}

function ledgerEventsForRun(stateRoot, runId) {
  return readFileSync(ledgerArtifactsForRun(stateRoot, runId).events, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertPublicResultPathClean(result, forbiddenPaths = []) {
  const serialized = JSON.stringify(result);
  assert.equal(Object.hasOwn(result, 'artifacts'), false);
  if (result.child) assert.equal(Object.hasOwn(result.child, 'cwd'), false);
  for (const child of result.children || []) {
    assert.equal(Object.hasOwn(child, 'cwd'), false);
  }
  for (const value of forbiddenPaths.filter(Boolean)) {
    assert.equal(serialized.includes(value), false);
  }
  assert.doesNotMatch(serialized, /"artifacts"\s*:/);
  assert.doesNotMatch(serialized, /"cwd"\s*:\s*"(?:\/|file:)/);
  assert.doesNotMatch(serialized, /\/Users\/|\/home\/|\/tmp\/|\/var\/folders\/|\/private\/var\/|\/root\/|\/etc\//);
  assert.doesNotMatch(serialized, /file:\/\/\//);
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

function registerSimpleIntercomRun(events, {
  stateRoot,
  asyncRoot,
  asyncId,
  role = 'executor',
  capturedRequests = [],
}) {
  const asyncDir = join(asyncRoot, 'async-subagent-runs', asyncId);
  const resultDir = join(asyncRoot, 'async-subagent-results');
  const resultPath = join(resultDir, `${asyncId}.json`);

  events.on('subagent:slash:request', (request) => {
    capturedRequests.push(request);
    events.emit('subagent:slash:started', { requestId: request.requestId });
    if (request.params.action === 'interrupt') {
      events.emit('subagent:slash:response', {
        requestId: request.requestId,
        isError: false,
        result: {
          content: [{ type: 'text', text: `Interrupted async child ${asyncId}` }],
          details: { mode: 'management', results: [] },
        },
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
      steps: [{ agent: role, status: 'running' }],
    }, null, 2));
    events.emit('subagent:async-started', { id: asyncId, asyncDir, pid: process.pid, mode: 'single', agent: role });
    events.emit('subagent:slash:response', {
      requestId: request.requestId,
      isError: false,
      result: {
        content: [{ type: 'text', text: `Async: ${role} [${asyncId}]` }],
        details: { mode: 'single', results: [], asyncId, asyncDir },
      },
    });
  });

  return { asyncDir, resultDir, resultPath, capturedRequests };
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
    () => execute({ action: 'spawn', role: 'executor', task: 'do read-only work', model: 'kimi-coding/kimi-for-coding' }),
    /stronk_subagent override denied: model/,
  );
  assert.deepEqual(adapter.calls, []);

  await assert.rejects(
    () => execute({ action: 'spawn', role: 'executor', task: 'do read-only work', cwd: '/Users/example' }),
    /stronk_subagent override denied: cwd/,
  );
  assert.deepEqual(adapter.calls, []);

  await assert.rejects(
    () => execute({ action: 'revive', childId: 'sp-child-1', cwd: '/' }),
    /stronk_subagent override denied: cwd/,
  );
  assert.deepEqual(adapter.calls, []);

  await assert.rejects(
    () => execute({ action: 'resume', target: 'child-1' }),
    /stronk_subagent action denied: resume/,
  );
});

test('stronk_subagent schema recursively denies unsafe overrides in new actions', async () => {
  const execute = createSubagentFacade({ allowedRoles: new Set(['executor']) });
  const validHandle = 'subagent-output-00000000-0000-0000-0000-000000000000';
  const cases = [
    [{ action: 'wait_all', childIds: ['sp-child-1'], meta: [{ cwd: '/' }] }, /override denied: meta.0.cwd/],
    [{ action: 'wait_all', childIds: ['sp-child-1'], childMeta: [{ model: 'override' }] }, /override denied: childMeta.0.model/],
    [{ action: 'wait_all', childIds: ['sp-child-1'], output: { path: '/tmp/out' } }, /override denied: output/],
    [{ action: 'wait_all', childIds: ['sp-child-1'], context: 'full' }, /context must be fresh/],
    [{ action: 'close_all', childIds: ['sp-child-1'], nested: { tools: ['bash'] } }, /override denied: nested.tools/],
    [{ action: 'close_all', childIds: ['sp-child-1'], maxConcurrency: 2 }, /override denied: maxConcurrency/],
    [{ action: 'read_output', outputHandle: validHandle, options: [{ worktree: '/tmp/wt' }] }, /override denied: options.0.worktree/],
    [{ action: 'read_output', outputHandle: validHandle, outputMode: 'raw' }, /override denied: outputMode/],
    [{ action: 'read_output', outputHandle: validHandle, includeRaw: true }, /override denied: includeRaw/],
  ];

  for (const [payload, expected] of cases) {
    await assert.rejects(() => execute(payload), expected);
  }
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

    assert.equal(result.child.status, 'dry-run');
    assert.equal(result.child.role, 'executor');
    assert.deepEqual(result.warnings?.map((warning) => warning.code), ['dry_run_no_worker']);
  });
});

test('stronk_subagent accepts schema-advertised spawn timeout', async () => {
  const adapter = {
    calls: [],
    async spawn(_ledger, normalized) {
      this.calls.push(normalized);
      return {
        childId: 'sp-child-timeout',
        role: normalized.role,
        cwd: normalized.cwd || process.cwd(),
        status: 'running',
        upstreamSessionId: null,
        upstreamRunId: null,
        upstreamAsyncDir: null,
        upstreamResultPath: null,
        upstreamMode: null,
        upstreamState: 'running',
        upstreamRequestId: null,
        intercomTarget: 'subagent-executor-timeout-1',
        pid: null,
        processGroup: null,
        terminalResult: null,
        terminalResultSha256: null,
        terminalResultBytes: 0,
        cleanupState: 'none',
        taskSha256: '0'.repeat(64),
        taskBytes: normalized.task.length,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },
  };
  const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });

  const spawn = parseResult(await execute({
    action: 'spawn',
    role: 'executor',
    task: 'respect the model-provided timeout',
    timeoutMs: 300000,
  }));

  assert.equal(spawn.child.status, 'running');
  assert.equal(adapter.calls[0].timeoutMs, 300000);
});

test('stronk_subagent allows explicit local overlay role manifest', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-local-manifest-role.'));
  const manifestRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-role-manifest.'));
  const localRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-local-role-manifest.'));
  const rolesDir = join(manifestRoot, 'roles');
  const localRolesDir = join(localRoot, 'roles');
  mkdirSync(rolesDir);
  mkdirSync(localRolesDir);
  writeFileSync(join(rolesDir, 'executor.toml'), 'name = "executor"\n');
  writeFileSync(join(localRolesDir, 'vision.toml'), 'name = "vision"\n');
  const manifestPath = join(manifestRoot, 'roles.toml');
  const localManifestPath = join(localRoot, 'roles.local.toml');
  writeFileSync(manifestPath, '[paths]\ncodex_roles_dir = "roles"\n');
  writeFileSync(localManifestPath, '[paths]\ncodex_roles_dir = "roles"\n');

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_ROLE_MANIFEST: manifestPath,
    STRONK_PI_ROLE_MANIFEST_LOCAL: localManifestPath,
    STRONK_PI_FACADE_RUN_ID: 'facade-local-manifest-role-run',
  }, async () => {
    const execute = createSubagentFacade();
    const result = parseResult(await execute({ action: 'spawn', role: 'vision', task: 'manifest-approved local role' }));

    assert.equal(result.child.status, 'dry-run');
    assert.equal(result.child.role, 'vision');
  });
});

test('stronk_subagent dry-run propagation is distinct from real completion', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-state.'));
  const task = 'inspect without leaking FAKE_SECRET_VALUE_1234567890';

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-test-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'dry-run',
    STRONK_PI_FACADE_DEBUG: '1',
  }, async () => {
    const execute = createSubagentFacade({ allowedRoles: new Set(['executor']) });
    const result = parseResult(await execute({ action: 'spawn', role: 'executor', task }));
    const artifacts = ledgerArtifactsForRun(stateRoot, 'facade-test-run');

    assert.equal(result.child.status, 'dry-run');
    assert.equal(result.child.terminalResult, 'dry-run-completed');
    assert.equal(result.child.pid, null);
    assert.equal(result.child.upstreamRunId, null);
    assert.equal(result.child.intercomTarget, null);
    assert.deepEqual(result.warnings, [{
      code: 'dry_run_no_worker',
      message: 'stronk_subagent dry-run completed without launching a worker; delegation output is unavailable',
      terminalResult: 'dry-run-completed',
    }]);
    assert.equal(mode(artifacts.runDir), 0o700);
    assert.equal(mode(artifacts.manifest), 0o600);
    assert.equal(mode(artifacts.children), 0o600);
    assert.equal(mode(artifacts.events), 0o600);

    const manifest = readFileSync(artifacts.manifest, 'utf8');
    const children = readFileSync(artifacts.children, 'utf8');
    const events = readFileSync(artifacts.events, 'utf8');
    assert.doesNotMatch(manifest, /raw_subagent/);
    assert.match(children, /taskSha256/);
    assert.match(events, /taskSha256/);
    assert.match(events, /child_dry_run/);
    assert.doesNotMatch(events, /child_completed/);
    assert.doesNotMatch(children, /FAKE_SECRET_VALUE/);
    assert.doesNotMatch(events, /FAKE_SECRET_VALUE/);
    assert.doesNotMatch(children, /inspect without leaking/);
  });
});

test('stronk_subagent public single-child results omit cwd and debug artifact paths', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-path-clean.'));
  const runId = 'facade-path-clean-run';

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: runId,
    STRONK_PI_SUBAGENT_ADAPTER: 'dry-run',
    STRONK_PI_FACADE_DEBUG: '1',
  }, async () => {
    const execute = createSubagentFacade({ allowedRoles: new Set(['executor']) });
    const spawn = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'finish without path leaks' }));
    const status = parseResult(await execute({ action: 'status', childId: spawn.child.childId }));
    const closed = parseResult(await execute({ action: 'close', childId: spawn.child.childId }));
    const artifacts = ledgerArtifactsForRun(stateRoot, runId);

    assertPublicResultPathClean(spawn, [stateRoot, artifacts.runDir, artifacts.children, artifacts.events]);
    assertPublicResultPathClean(status, [stateRoot, artifacts.runDir, artifacts.children, artifacts.events]);
    assertPublicResultPathClean(closed, [stateRoot, artifacts.runDir, artifacts.children, artifacts.events]);
    assert.equal(mode(artifacts.runDir), 0o700);
    assert.equal(mode(artifacts.children), 0o600);
  });
});

test('stronk_subagent public batch wait results omit cwd and debug artifact paths', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-batch-path-clean.'));
  const runId = 'facade-batch-path-clean-run';

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: runId,
    STRONK_PI_SUBAGENT_ADAPTER: 'dry-run',
    STRONK_PI_FACADE_DEBUG: '1',
  }, async () => {
    const execute = createSubagentFacade({ allowedRoles: new Set(['executor']) });
    const first = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'first child' }));
    const second = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'second child' }));
    const batch = parseResult(await execute({
      action: 'wait_all',
      childIds: [first.child.childId, second.child.childId],
      timeoutMs: 1000,
    }));
    const artifacts = ledgerArtifactsForRun(stateRoot, runId);

    assert.equal(batch.children.length, 2);
    assert.deepEqual(batch.children.map((child) => child.childId), [first.child.childId, second.child.childId]);
    assertPublicResultPathClean(batch, [stateRoot, artifacts.runDir, artifacts.children, artifacts.events]);
  });
});

test('stronk_subagent wait_all validates explicit current-run child IDs before waiting', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-wait-all-validation.'));
  const adapter = {
    waits: [],
    async spawn(ledger, normalized) {
      const child = await ledger.createChild(normalized);
      return ledger.updateChild(child.childId, { status: 'running' }, 'child_running');
    },
    async wait(ledger, childId) {
      this.waits.push(childId);
      return ledger.getChild(childId);
    },
  };

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-wait-all-validation-run',
  }, async () => {
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const first = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'first child' }));

    await assert.rejects(
      () => execute({ action: 'wait_all', childIds: [first.child.childId, first.child.childId] }),
      /duplicate childId denied/,
    );
    await assert.rejects(
      () => execute({ action: 'wait_all', childIds: Array.from({ length: 7 }, (_, index) => `sp-child-${index}`) }),
      /childIds exceeds max children/,
    );
    await assert.rejects(
      () => execute({ action: 'wait_all', childIds: ['not-a-child-id'] }),
      /childId invalid/,
    );
    await assert.rejects(
      () => execute({ action: 'wait_all', childIds: ['sp-child-foreign'] }),
      /child not found or foreign-run denied/,
    );
    assert.deepEqual(adapter.waits, []);
  });
});

test('stronk_subagent wait_all preserves request order and exposes mixed terminal, timeout, and failure metadata', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-wait-all-mixed.'));
  const waitCalls = [];
  const adapter = {
    byTask: new Map(),
    async spawn(ledger, normalized) {
      const child = await ledger.createChild(normalized);
      const running = await ledger.updateChild(child.childId, { status: 'running' }, 'child_running');
      this.byTask.set(normalized.task, running.childId);
      return running;
    },
    async wait(ledger, childId, normalized) {
      waitCalls.push({ childId, timeoutMs: normalized.timeoutMs });
      const child = await ledger.getChild(childId);
      if (childId === this.byTask.get('completed child')) {
        return ledger.updateChild(childId, {
          status: 'completed',
          childOutputPreview: 'completed child output',
          childOutputBytes: 22,
          childOutputHash: 'a'.repeat(64),
          timedOut: false,
          recommendedNextAction: 'close_child',
        }, 'child_completed');
      }
      if (childId === this.byTask.get('failed child')) {
        return ledger.updateChild(childId, {
          status: 'failed',
          failureReason: 'test_failure',
          errorSummary: 'failed child visible',
          childOutputPreview: 'failed child visible',
          childOutputBytes: 20,
          childOutputHash: 'b'.repeat(64),
          timedOut: false,
          recommendedNextAction: 'inspect_error',
        }, 'child_failed');
      }
      return ledger.updateChild(childId, {
        status: child.status,
        timedOut: true,
        timeoutMs: normalized.timeoutMs,
        recommendedNextAction: 'wait_again',
      }, 'child_wait_timeout');
    },
  };

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-wait-all-mixed-run',
  }, async () => {
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const running = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'running child' }));
    const completed = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'completed child' }));
    const failed = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'failed child' }));
    const requested = [failed.child.childId, running.child.childId, completed.child.childId];

    const batch = parseResult(await execute({ action: 'wait_all', childIds: requested, timeoutMs: 1000 }));

    assert.equal(batch.action, 'wait_all');
    assert.deepEqual(batch.children.map((child) => child.childId), requested);
    assert.deepEqual(batch.terminalChildIds, [failed.child.childId, completed.child.childId]);
    assert.deepEqual(batch.nonTerminalChildIds, [running.child.childId]);
    assert.deepEqual(batch.failedChildIds, [failed.child.childId]);
    assert.equal(batch.timedOut, true);
    assert.equal(batch.timeoutMs, 1000);
    assert.equal(typeof batch.elapsedMs, 'number');
    assert.equal(batch.recommendedNextAction, 'wait_again');
    assert.equal(batch.children[0].failureReason, 'test_failure');
    assert.equal(batch.children[1].timedOut, true);
    assert.equal(batch.children[2].recommendedNextAction, 'close_child');
    assert.deepEqual(waitCalls.map((call) => call.childId), requested);
    const waitAllEvent = ledgerEventsForRun(stateRoot, 'facade-wait-all-mixed-run').find((event) => event.event === 'facade_wait_all');
    assert.deepEqual(waitAllEvent.childIds, requested);
    assert.deepEqual(waitAllEvent.terminalChildIds, [failed.child.childId, completed.child.childId]);
    assert.deepEqual(waitAllEvent.nonTerminalChildIds, [running.child.childId]);
    assert.deepEqual(waitAllEvent.failedChildIds, [failed.child.childId]);
    assert.equal(waitAllEvent.timedOut, true);
  });
});

test('stronk_subagent wait_all exposes drain-aware retry metadata for provider capacity children', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-wait-all-capacity.'));
  const adapter = {
    byTask: new Map(),
    drained: false,
    async spawn(ledger, normalized) {
      const child = await ledger.createChild(normalized);
      const running = await ledger.updateChild(child.childId, { status: 'running' }, 'child_running');
      this.byTask.set(normalized.task, running.childId);
      return running;
    },
    async wait(ledger, childId, normalized) {
      const child = await ledger.getChild(childId);
      if (childId === this.byTask.get('capacity child')) {
        return ledger.updateChild(childId, {
          status: 'failed',
          failureReason: 'provider_capacity_retryable',
          failureClass: 'provider_capacity',
          retryable: true,
          retryReason: 'provider_capacity',
          retryAfterMs: null,
          capacityBlocked: true,
          outputUsableForSynthesis: false,
          recommendedNextAction: 'retry_capacity_children_next_batch',
          timedOut: false,
        }, 'child_failed');
      }
      if (childId === this.byTask.get('running child') && !this.drained) {
        return ledger.updateChild(childId, {
          status: child.status,
          timedOut: true,
          timeoutMs: normalized.timeoutMs,
          recommendedNextAction: 'wait_again',
        }, 'child_wait_timeout');
      }
      return ledger.updateChild(childId, {
        status: 'completed',
        childOutputPreview: 'completed child output',
        childOutputBytes: 22,
        childOutputHash: 'c'.repeat(64),
        timedOut: false,
        recommendedNextAction: 'close_child',
      }, 'child_completed');
    },
  };

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-wait-all-capacity-run',
  }, async () => {
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const capacity = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'capacity child' }));
    const running = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'running child' }));
    const completed = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'completed child' }));
    const requested = [capacity.child.childId, running.child.childId, completed.child.childId];

    const draining = parseResult(await execute({ action: 'wait_all', childIds: requested, timeoutMs: 1000 }));
    assert.deepEqual(draining.children.map((child) => child.childId), requested);
    assert.deepEqual(draining.retryableCapacityChildIds, [capacity.child.childId]);
    assert.equal(draining.retryPolicy, 'after_nonterminal_drain');
    assert.equal(draining.nextRetryAfterMs, null);
    assert.equal(draining.recommendedNextAction, 'wait_again');
    assert.equal(draining.children[0].failureClass, 'provider_capacity');
    assert.equal(draining.children[0].retryable, true);
    assert.equal(draining.children[0].outputUsableForSynthesis, false);

    adapter.drained = true;
    const drained = parseResult(await execute({ action: 'wait_all', childIds: requested, timeoutMs: 1000 }));
    assert.deepEqual(drained.retryableCapacityChildIds, [capacity.child.childId]);
    assert.equal(drained.retryPolicy, 'next_batch');
    assert.equal(drained.recommendedNextAction, 'retry_capacity_children_next_batch');
    assert.deepEqual(drained.nonTerminalChildIds, []);
  });
});

test('stronk_subagent wait_all uses one shared deadline instead of full timeout per child', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-wait-all-deadline.'));
  const timeouts = [];
  const adapter = {
    async spawn(ledger, normalized) {
      const child = await ledger.createChild(normalized);
      return ledger.updateChild(child.childId, { status: 'running' }, 'child_running');
    },
    async wait(ledger, childId, normalized) {
      timeouts.push(normalized.timeoutMs);
      if (timeouts.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return ledger.getChild(childId);
    },
  };

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-wait-all-deadline-run',
  }, async () => {
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const first = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'first child' }));
    const second = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'second child' }));

    const batch = parseResult(await execute({
      action: 'wait_all',
      childIds: [first.child.childId, second.child.childId],
      timeoutMs: 60,
    }));

    assert.equal(batch.timedOut, true);
    assert.equal(timeouts[0], 60);
    assert.equal(timeouts[1] < 60, true);
  });
});

test('stronk_subagent terminal output handle is opaque and read_output returns sanitized bounded chunks', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-output-handle.'));
  const asyncRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-upstream-output-handle.'));
  const asyncId = 'async-output-handle-run';
  const events = new FakeEvents();
  const { asyncDir, resultPath } = registerSimpleIntercomRun(events, { stateRoot, asyncRoot, asyncId });

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-output-handle-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'intercom',
  }, async () => {
    const adapter = new PiSubagentsBridgeAdapter({ events, timeoutMs: 1000 });
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const spawn = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'produce durable output' }));
    const raw = [
      'alpha',
      `password=supersecret123 token = sk-${'1234567890abcdefghijklmnop'}`,
      `${stateRoot}/private-output.txt /var/folders/zz/private.txt /private/var/tmp/private.txt`,
      '/root/.ssh/id_rsa /etc/passwd file:///Users/example/secret.txt',
      'x'.repeat(9000),
      'omega',
    ].join('\n');
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
      summary: raw,
      results: [{ agent: 'executor', output: raw, success: true }],
      exitCode: 0,
    }, null, 2));

    const waited = parseResult(await execute({ action: 'wait', childId: spawn.child.childId, timeoutMs: 1000 }));
    assert.match(waited.child.childOutputHandle, /^subagent-output-[a-f0-9-]+$/);
    assert.doesNotMatch(waited.child.childOutputHandle, /\/|\\|:|\.\.|file:|https?:/);
    assert.equal(waited.child.childOutputFullBytes > waited.child.childOutputBytes, true);
    assert.match(waited.child.childOutputFullHash, /^[a-f0-9]{64}$/);
    assert.equal(waited.child.childOutputArtifactTruncated, false);
    assertPublicResultPathClean(waited, [stateRoot, asyncRoot]);

    const first = parseResult(await execute({
      action: 'read_output',
      outputHandle: waited.child.childOutputHandle,
      offset: 0,
      maxChars: 12,
    }));
    assert.equal(first.action, 'read_output');
    assert.equal(first.output.handle, waited.child.childOutputHandle);
    assert.equal(first.output.childId, waited.child.childId);
    assert.equal(first.output.offset, 0);
    assert.equal(first.output.nextOffset, 12);
    assert.equal(first.output.eof, false);
    assert.equal(first.output.redacted, true);
    assert.match(first.output.hash, /^[a-f0-9]{64}$/);
    assert.match(first.output.chunk, /^alpha/);
    const eventsAfterFirstRead = ledgerEventsForRun(stateRoot, 'facade-output-handle-run');
    const readOutputEvent = eventsAfterFirstRead.find((event) => event.event === 'facade_read_output');
    assert.equal(readOutputEvent.outputHandle, waited.child.childOutputHandle);
    assert.equal(readOutputEvent.childId, waited.child.childId);
    assert.equal(readOutputEvent.offset, 0);
    assert.equal(readOutputEvent.nextOffset, 12);
    assert.equal(readOutputEvent.eof, false);

    const second = parseResult(await execute({
      action: 'read_output',
      outputHandle: waited.child.childOutputHandle,
      offset: first.output.nextOffset,
      maxChars: 65536,
    }));
    const combined = `${first.output.chunk}${second.output.chunk}`;
    assert.match(combined, /alpha/);
    assert.match(combined, /omega/);
    assert.doesNotMatch(combined, /supersecret123|sk-1234567890/);
    assert.doesNotMatch(combined, /\/var\/folders|\/private\/var|\/root|\/etc\/passwd|\.ssh|file:\/\/\/Users/);
    assert.doesNotMatch(combined, new RegExp(stateRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assertPublicResultPathClean(first, [stateRoot, asyncRoot]);
    assertPublicResultPathClean(second, [stateRoot, asyncRoot]);
  });
});

test('stronk_subagent read_output denies invalid handles and invalid chunk bounds', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-output-deny.'));
  const asyncRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-upstream-output-deny.'));
  const asyncId = 'async-output-deny-run';
  const events = new FakeEvents();
  const { asyncDir, resultPath } = registerSimpleIntercomRun(events, { stateRoot, asyncRoot, asyncId });

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-output-deny-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'intercom',
  }, async () => {
    const adapter = new PiSubagentsBridgeAdapter({ events, timeoutMs: 1000 });
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const spawn = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'produce output for handle denial' }));
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
      summary: 'short durable text',
      results: [{ agent: 'executor', output: 'short durable text', success: true }],
      exitCode: 0,
    }, null, 2));
    const waited = parseResult(await execute({ action: 'wait', childId: spawn.child.childId, timeoutMs: 1000 }));
    const handle = waited.child.childOutputHandle;

    for (const badHandle of [
      'subagent-output-guessed',
      '../subagent-output-guess',
      '/tmp/subagent-output-guess',
      'file:///tmp/subagent-output-guess',
      'https://example.invalid/subagent-output-guess',
    ]) {
      await assert.rejects(
        () => execute({ action: 'read_output', outputHandle: badHandle }),
        /output handle denied|outputHandle invalid/,
      );
    }
    await assert.rejects(() => execute({ action: 'read_output', outputHandle: handle, offset: -1 }), /offset/);
    await assert.rejects(() => execute({ action: 'read_output', outputHandle: handle, offset: 0.5 }), /offset/);
    await assert.rejects(() => execute({ action: 'read_output', outputHandle: handle, offset: 9999 }), /offset/);
    await assert.rejects(() => execute({ action: 'read_output', outputHandle: handle, maxChars: 0 }), /maxChars/);
    await assert.rejects(() => execute({ action: 'read_output', outputHandle: handle, maxChars: 65537 }), /maxChars/);
  });
});

test('stronk_subagent durable output is capped at 1 MiB, UTF-8 safe, and invalidated on close', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-output-cap.'));
  const asyncRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-upstream-output-cap.'));
  const asyncId = 'async-output-cap-run';
  const runId = 'facade-output-cap-run';
  const events = new FakeEvents();
  const { asyncDir, resultPath } = registerSimpleIntercomRun(events, { stateRoot, asyncRoot, asyncId });

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: runId,
    STRONK_PI_SUBAGENT_ADAPTER: 'intercom',
  }, async () => {
    const adapter = new PiSubagentsBridgeAdapter({ events, timeoutMs: 1000 });
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const spawn = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'produce huge output' }));
    const raw = `${'a'.repeat(1024 * 1024 + 2048)}😀`;
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
      summary: raw,
      results: [{ agent: 'executor', output: raw, success: true }],
      exitCode: 0,
    }, null, 2));

    const waited = parseResult(await execute({ action: 'wait', childId: spawn.child.childId, timeoutMs: 1000 }));
    assert.equal(waited.child.childOutputArtifactTruncated, true);
    assert.equal(waited.child.childOutputFullBytes, 1024 * 1024);
    assert.equal(waited.child.childOutputFullHash.length, 64);
    const privateChild = ledgerChildrenForRun(stateRoot, runId).find((child) => child.childId === spawn.child.childId);
    assert.equal(mode(privateChild.childOutputArtifactPath), 0o600);
    assert.equal(Buffer.byteLength(readFileSync(privateChild.childOutputArtifactPath, 'utf8'), 'utf8'), 1024 * 1024);
    assert.doesNotMatch(readFileSync(privateChild.childOutputArtifactPath, 'utf8'), /\uFFFD/);

    const eof = parseResult(await execute({
      action: 'read_output',
      outputHandle: waited.child.childOutputHandle,
      offset: waited.child.childOutputFullChars,
      maxChars: 10,
    }));
    assert.equal(eof.output.chunk, '');
    assert.equal(eof.output.eof, true);

    const closed = parseResult(await execute({ action: 'close', childId: spawn.child.childId, timeoutMs: 1000 }));
    assert.equal(closed.child.childOutputHandle, null);
    assert.equal(existsSync(privateChild.childOutputArtifactPath), false);
    await assert.rejects(
      () => execute({ action: 'read_output', outputHandle: waited.child.childOutputHandle }),
      /output handle denied/,
    );
  });
});

test('stronk_subagent ledger cleanup refuses durable output paths outside its output directory', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-output-containment.'));
  const runId = 'facade-output-containment-run';

  await withEnv({ STRONK_PI_STATE_ROOT: stateRoot }, async () => {
    const ledger = await new SubagentLedger({ cwd: stateRoot, mode: 'intercom', facadeRunId: runId }).init();
    const child = await ledger.createChild({ role: 'executor', task: 'store contained output' });
    await ledger.storeChildOutput(child.childId, 'safe child output');

    const [storedChild] = await ledger.children();
    const originalArtifactPath = storedChild.childOutputArtifactPath;
    const sentinelPath = join(stateRoot, 'outside-output-sentinel.txt');
    writeFileSync(sentinelPath, 'must remain', 'utf8');
    await ledger.mutateChildren((children) => {
      children[0].childOutputArtifactPath = sentinelPath;
      return children[0];
    });

    await ledger.clearChildOutput(child.childId);

    assert.equal(existsSync(sentinelPath), true);
    assert.equal(existsSync(originalArtifactPath), true);
  });
});

test('stronk_subagent close_all validates child IDs before closing', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-close-all-validation.'));
  const adapter = {
    closes: [],
    async spawn(ledger, normalized) {
      const child = await ledger.createChild(normalized);
      return ledger.updateChild(child.childId, { status: 'running' }, 'child_running');
    },
    async close(ledger, childId) {
      this.closes.push(childId);
      return ledger.updateChild(childId, { status: 'closed', cleanupState: 'closed' }, 'child_closed');
    },
  };

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-close-all-validation-run',
  }, async () => {
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const first = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'first child' }));

    await assert.rejects(
      () => execute({ action: 'close_all', childIds: [first.child.childId, first.child.childId] }),
      /duplicate childId denied/,
    );
    await assert.rejects(
      () => execute({ action: 'close_all', childIds: ['sp-child-foreign'] }),
      /child not found or foreign-run denied/,
    );
    assert.deepEqual(adapter.closes, []);
  });
});

test('stronk_subagent close_all preserves request order, reports per-child cleanup, and keeps close failures visible', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-close-all.'));
  const runId = 'facade-close-all-run';
  const adapter = {
    byTask: new Map(),
    async spawn(ledger, normalized) {
      const child = await ledger.createChild(normalized);
      this.byTask.set(normalized.task, child.childId);
      if (normalized.task === 'completed with output') {
        const completed = await ledger.updateChild(child.childId, {
          status: 'completed',
          cleanupState: 'none',
          childOutputPreview: 'private completed output',
          childOutputBytes: 24,
          childOutputHash: 'c'.repeat(64),
          recommendedNextAction: 'close_child',
        }, 'child_completed');
        return ledger.storeChildOutput(completed.childId, 'private completed output');
      }
      return ledger.updateChild(child.childId, { status: 'running', cleanupState: 'none' }, 'child_running');
    },
    async close(ledger, childId) {
      if (childId === this.byTask.get('close failure')) {
        await ledger.updateChild(childId, {
          cleanupState: 'close_failed',
          closeRequested: true,
          processLive: true,
          cleanupVerified: false,
        }, 'child_cleanup_failed');
        throw new Error('simulated close failure');
      }
      const child = await ledger.getChild(childId);
      return ledger.updateChild(childId, {
        status: child.status === 'completed' ? 'completed' : 'closed',
        cleanupState: child.status === 'completed' ? 'already_closed' : 'closed',
        closeRequested: child.status !== 'completed',
        processLive: false,
        cleanupVerified: true,
        recommendedNextAction: null,
      }, child.status === 'completed' ? 'child_already_closed' : 'child_closed');
    },
  };

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: runId,
  }, async () => {
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const failed = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'close failure' }));
    const completed = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'completed with output' }));
    const running = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'running close success' }));
    const privateCompletedBefore = ledgerChildrenForRun(stateRoot, runId).find((child) => child.childId === completed.child.childId);
    assert.equal(existsSync(privateCompletedBefore.childOutputArtifactPath), true);
    const requested = [running.child.childId, failed.child.childId, completed.child.childId];

    const batch = parseResult(await execute({ action: 'close_all', childIds: requested, timeoutMs: 1000 }));

    assert.equal(batch.action, 'close_all');
    assert.deepEqual(batch.children.map((child) => child.childId), requested);
    assert.deepEqual(batch.closedChildIds, [running.child.childId, completed.child.childId]);
    assert.deepEqual(batch.failedCloseChildIds, [failed.child.childId]);
    assert.deepEqual(batch.cleanupVerifiedChildIds, [running.child.childId, completed.child.childId]);
    assert.deepEqual(batch.cleanupFailedChildIds, [failed.child.childId]);
    assert.equal(batch.timedOut, false);
    assert.equal(batch.timeoutMs, 1000);
    assert.equal(batch.recommendedNextAction, 'inspect_error');
    assert.equal(batch.children[0].cleanupState, 'closed');
    assert.equal(batch.children[0].cleanupVerified, true);
    assert.equal(batch.children[1].cleanupState, 'close_failed');
    assert.equal(batch.children[1].closeError, 'simulated close failure');
    assert.equal(batch.children[2].cleanupState, 'already_closed');
    assert.equal(batch.children[2].childOutputHandle, null);
    assert.equal(existsSync(privateCompletedBefore.childOutputArtifactPath), false);
    assertPublicResultPathClean(batch, [stateRoot, privateCompletedBefore.childOutputArtifactPath]);
    const closeAllEvent = ledgerEventsForRun(stateRoot, runId).find((event) => event.event === 'facade_close_all');
    assert.deepEqual(closeAllEvent.childIds, requested);
    assert.deepEqual(closeAllEvent.closedChildIds, [running.child.childId, completed.child.childId]);
    assert.deepEqual(closeAllEvent.failedCloseChildIds, [failed.child.childId]);
    assert.deepEqual(closeAllEvent.cleanupVerifiedChildIds, [running.child.childId, completed.child.childId]);
    assert.deepEqual(closeAllEvent.cleanupFailedChildIds, [failed.child.childId]);
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

test('stronk_subagent ledger limits active children, not retained terminal history', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-active-limit.'));

  await withEnv({ STRONK_PI_STATE_ROOT: stateRoot }, async () => {
    const ledger = await new SubagentLedger({
      cwd: stateRoot,
      mode: 'intercom',
      maxChildren: 6,
      facadeRunId: 'active-limit-run',
    }).init();

    for (let index = 0; index < 6; index += 1) {
      const child = await ledger.createChild({ role: 'executor', task: `terminal child ${index}` });
      await ledger.updateChild(child.childId, {
        status: 'completed',
        terminalResult: 'completed',
      }, 'child_completed');
    }

    const next = await ledger.createChild({ role: 'executor', task: 'seventh child after cleanup' });

    assert.equal(next.status, 'spawned');
  });
});

test('stronk_subagent ledger still blocks the seventh active child', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-active-block.'));

  await withEnv({ STRONK_PI_STATE_ROOT: stateRoot }, async () => {
    const ledger = await new SubagentLedger({
      cwd: stateRoot,
      mode: 'intercom',
      maxChildren: 6,
      facadeRunId: 'active-block-run',
    }).init();

    for (let index = 0; index < 6; index += 1) {
      await ledger.createChild({ role: 'executor', task: `running child ${index}` });
    }

    await assert.rejects(
      () => ledger.createChild({ role: 'executor', task: 'seventh active child' }),
      /child limit exceeded/,
    );
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
    assert.equal(result.child.roleRequested, 'delegate');
    assert.equal(result.child.roleUsed, 'executor');
    assert.equal(result.child.aliasResolved, true);
    assert.match(result.child.aliasMessage, /delegate resolved to executor/);
  });
});

test('stronk_subagent maps scout aliases to available read-only roles', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-scout-alias.'));

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-scout-alias-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'dry-run',
  }, async () => {
    const withPublicRoles = createSubagentFacade({
      allowedRoles: new Set(['executor', 'technical-researcher', 'planner', 'code-reviewer', 'vision']),
    });
    const scoutResult = parseResult(await withPublicRoles({
      action: 'spawn',
      role: 'docs-scout',
      task: 'inspect docs',
    }));
    assert.equal(scoutResult.child.role, 'technical-researcher');
    assert.equal(scoutResult.child.roleRequested, 'docs-scout');
    assert.equal(scoutResult.child.roleUsed, 'technical-researcher');
    assert.equal(scoutResult.child.aliasResolved, true);

    const contextResult = parseResult(await withPublicRoles({
      action: 'spawn',
      role: 'context-builder',
      task: 'build context',
    }));
    assert.equal(contextResult.child.role, 'technical-researcher');
    assert.equal(contextResult.child.roleRequested, 'context-builder');
    assert.equal(contextResult.child.aliasResolved, true);

    const oracleResult = parseResult(await withPublicRoles({
      action: 'spawn',
      role: 'oracle',
      task: 'advise on plan',
    }));
    assert.equal(oracleResult.child.role, 'planner');

    const qaResult = parseResult(await withPublicRoles({
      action: 'spawn',
      role: 'qa',
      task: 'verify behavior',
    }));
    assert.equal(qaResult.child.role, 'executor');

    const withoutExplorer = createSubagentFacade({
      allowedRoles: new Set(['technical-researcher']),
      facadeRunId: 'facade-scout-fallback-run',
    });
    const fallbackResult = parseResult(await withoutExplorer({
      action: 'spawn',
      role: 'source-scout',
      task: 'inspect source',
    }));
    assert.equal(fallbackResult.child.role, 'technical-researcher');
    assert.equal(fallbackResult.child.roleRequested, 'source-scout');
    assert.equal(fallbackResult.child.roleUsed, 'technical-researcher');
    assert.equal(fallbackResult.child.aliasResolved, true);
  });
});

test('stronk_subagent role denial lists allowed roles', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-role-denial.'));

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-role-denial-run',
  }, async () => {
    const execute = createSubagentFacade({ allowedRoles: new Set(['executor', 'technical-researcher']) });
    await assert.rejects(
      () => execute({ action: 'spawn', role: 'unknown-scout', task: 'inspect something' }),
      /stronk_subagent role denied: unknown-scout\. Allowed roles: executor, technical-researcher/,
    );
  });
});

test('stronk_subagent returns actionable errors for unknown child and non-terminal revive', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-actionable-errors.'));

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-actionable-errors-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'dry-run',
  }, async () => {
    const execute = createSubagentFacade({ allowedRoles: new Set(['executor']) });

    await assert.rejects(
      () => execute({ action: 'status', childId: 'sp-child-missing' }),
      /stronk_subagent child not found: sp-child-missing/,
    );

    const adapter = {
      async spawn(ledger, normalized) {
        const child = await ledger.createChild(normalized);
        return ledger.updateChild(child.childId, {
          status: 'running',
          upstreamRunId: 'async-non-terminal',
          intercomTarget: 'subagent-executor-async-non-terminal-1',
        }, 'child_running');
      },
    };
    const liveExecute = createSubagentFacade({
      adapter,
      allowedRoles: new Set(['executor']),
      facadeRunId: 'facade-live-errors-run',
    });
    const spawn = parseResult(await liveExecute({ action: 'spawn', role: 'executor', task: 'stay running' }));

    await assert.rejects(
      () => liveExecute({ action: 'revive', childId: spawn.child.childId, task: 'should not revive running child' }),
      /stronk_subagent revive denied: child is not terminal/,
    );
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
    const events = readFileSync(ledgerArtifactsForRun(stateRoot, 'facade-send-run').events, 'utf8');
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

    assert.equal(closed.child.status, 'dry-run');
    assert.equal(closed.child.cleanupState, 'already_closed');
    assert.equal(closed.child.closeRequested, false);
    assert.equal(closed.child.processLive, null);
    assert.equal(closed.child.cleanupVerified, false);
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
    assert.equal(revived.child.status, 'dry-run');
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
    assert.equal(status.debug.facadeRunId, spawn.debug.facadeRunId);
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
    const execute = createSubagentFacade({
      adapter,
      allowedRoles: new Set(['executor']),
      parentModelProvider: (execution) => execution?.ctx?.model,
    });
    const task = 'do not persist this exact child prompt';
    const spawn = parseResult(await execute(
      { action: 'spawn', role: 'executor', task },
      { ctx: { model: 'deepseek/deepseek-v4-pro:high' } },
    ));

    assert.equal(spawn.child.status, 'running');
    assert.equal(spawn.child.isTerminal, false);
    assert.equal(spawn.child.roleRequested, 'executor');
    assert.equal(spawn.child.roleUsed, 'executor');
    assert.equal(spawn.child.aliasResolved, false);
    assert.equal(spawn.child.recommendedNextAction, 'wait_again');
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
      'model',
      'progress',
      'task',
    ]);
    assert.equal(capturedRequests[0].params.agent, 'executor');
    assert.equal(capturedRequests[0].params.context, 'fresh');
    assert.equal(capturedRequests[0].params.async, true);
    assert.equal(capturedRequests[0].params.task, task);
    assert.equal(capturedRequests[0].params.model, 'deepseek/deepseek-v4-pro:high');

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
    assert.equal(waited.child.isTerminal, true);
    assert.equal(waited.child.terminalResult, 'completed');
    assert.equal(waited.child.terminalResultBytes > 0, true);
    assert.match(waited.child.terminalResultSha256, /^[a-f0-9]{64}$/);
    assert.match(waited.child.childOutputPreview, /bridge-completed/);
    assert.equal(waited.child.terminalOutputPreview, waited.child.childOutputPreview);
    assert.equal(waited.child.childOutputTruncated, false);
    assert.equal(waited.child.childOutputBytes, Buffer.byteLength(waited.child.childOutputPreview, 'utf8'));
    assert.match(waited.child.childOutputHash, /^[a-f0-9]{64}$/);
    assert.equal(waited.child.recommendedNextAction, 'close_child');
    assert.equal(waited.child.timedOut, false);
    assert.ok(!waited.child.childOutputPreview.includes(fakeSecret));
    const waitedAgain = parseResult(await execute({ action: 'wait', childId: spawn.child.childId, timeoutMs: 1000 }));
    assert.equal(waitedAgain.child.status, 'completed');
    const status = parseResult(await execute({ action: 'status', childId: spawn.child.childId }));
    assert.equal(status.child.status, 'completed');
    assert.equal(status.child.childOutputPreview, waited.child.childOutputPreview);
    assert.equal(status.child.childOutputHash, waited.child.childOutputHash);
    assert.equal(status.child.childOutputBytes, waited.child.childOutputBytes);
    assert.equal(status.child.childOutputTruncated, false);

    const artifacts = ledgerArtifactsForRun(stateRoot, 'facade-bridge-run');
    const children = readFileSync(artifacts.children, 'utf8');
    const eventsText = readFileSync(artifacts.events, 'utf8');
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
    assert.match(children, /bridge-completed/);
    assert.doesNotMatch(eventsText, /bridge-completed/);
    assert.ok(!children.includes(fakeSecret));
    assert.ok(!eventsText.includes(fakeSecret));
  });
});

test('stronk_subagent intercom wait classifies failed complete result before exposing redacted preview', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-failed-complete.'));
  const asyncRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-upstream-failed-complete.'));
  const asyncId = 'async-failed-complete-run';
  const asyncDir = join(asyncRoot, 'async-subagent-runs', asyncId);
  const resultDir = join(asyncRoot, 'async-subagent-results');
  const resultPath = join(resultDir, `${asyncId}.json`);
  const events = new FakeEvents();

  events.on('subagent:slash:request', (request) => {
    events.emit('subagent:slash:started', { requestId: request.requestId });
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
    STRONK_PI_FACADE_RUN_ID: 'facade-failed-complete-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'intercom',
    STRONK_PI_FACADE_DEBUG: '1',
  }, async () => {
    const adapter = new PiSubagentsBridgeAdapter({ events, timeoutMs: 1000 });
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const spawn = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'fail visibly' }));
    const rawSecret = 'password=supersecret123';
    const rawPath = '/Users/example/private.txt';
    const rawFileUrl = 'file:///tmp/secret-output.txt';
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
      success: false,
      summary: `negative failure visible to parent ${rawSecret} ${rawPath} ${rawFileUrl}`,
      results: [{ agent: 'executor', output: 'ignored success-looking text', success: false, error: 'child reported failure row' }],
      exitCode: 0,
    }, null, 2));

    const waited = parseResult(await execute({ action: 'wait', childId: spawn.child.childId, timeoutMs: 1000 }));

    assert.equal(waited.child.status, 'failed');
    assert.equal(waited.child.isTerminal, true);
    assert.equal(waited.child.failureReason, 'upstream_success_false');
    assert.match(waited.child.errorSummary, /negative failure visible to parent/);
    assert.match(waited.child.childOutputPreview, /negative failure visible to parent/);
    assert.doesNotMatch(waited.child.childOutputPreview, /supersecret123/);
    assert.doesNotMatch(waited.child.childOutputPreview, /\/Users\/example/);
    assert.doesNotMatch(waited.child.childOutputPreview, /file:\/\/\/tmp/);
    assert.equal(waited.child.recommendedNextAction, 'inspect_error');

    const artifacts = ledgerArtifactsForRun(stateRoot, 'facade-failed-complete-run');
    const children = readFileSync(artifacts.children, 'utf8');
    const eventsText = readFileSync(artifacts.events, 'utf8');
    assert.match(children, /negative failure visible to parent/);
    assert.doesNotMatch(children, /supersecret123/);
    assert.doesNotMatch(children, /\/Users\/example/);
    assert.doesNotMatch(eventsText, /supersecret123/);
    assert.doesNotMatch(eventsText, /negative failure visible to parent/);
  });
});

test('stronk_subagent intercom immediate response classifies failed result rows', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-immediate-failure.'));
  const events = new FakeEvents();

  events.on('subagent:slash:request', (request) => {
    events.emit('subagent:slash:started', { requestId: request.requestId });
    events.emit('subagent:slash:response', {
      requestId: request.requestId,
      isError: false,
      result: {
        content: [{ type: 'text', text: 'Immediate child finished with failed row' }],
        details: {
          mode: 'single',
          results: [{
            agent: 'executor',
            success: false,
            error: 'immediate row failed',
            output: 'immediate row failed output',
          }],
        },
      },
    });
  });

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-immediate-failure-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'intercom',
  }, async () => {
    const adapter = new PiSubagentsBridgeAdapter({ events, timeoutMs: 1000 });
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const result = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'fail immediately' }));

    assert.equal(result.child.status, 'failed');
    assert.equal(result.child.isTerminal, true);
    assert.equal(result.child.failureReason, 'upstream_result_failed');
    assert.match(result.child.childOutputPreview, /immediate row failed output/);
    assert.equal(result.child.recommendedNextAction, 'inspect_error');
  });
});

test('stronk_subagent intercom immediate 429 capacity response exposes retry metadata without output', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-immediate-capacity.'));
  const events = new FakeEvents();
  const capturedRequests = [];
  const rawProviderText = 'NeuralWatt GLM HTTP 429 Concurrent limit reached: 5/5 slots in use. Retry-After: 2.5s';

  events.on('subagent:slash:request', (request) => {
    capturedRequests.push(request);
    events.emit('subagent:slash:started', { requestId: request.requestId });
    events.emit('subagent:slash:response', {
      requestId: request.requestId,
      isError: true,
      result: {
        content: [{ type: 'text', text: rawProviderText }],
        details: {
          mode: 'single',
          statusCode: 429,
          errorCode: 'rate_limit_exceeded',
          retryAfterMs: 2500,
          concurrency: { inUse: 5, limit: 5 },
        },
      },
    });
  });

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-immediate-capacity-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'intercom',
  }, async () => {
    const adapter = new PiSubagentsBridgeAdapter({ events, timeoutMs: 1000 });
    const execute = createSubagentFacade({
      adapter,
      allowedRoles: new Set(['executor']),
      parentModelProvider: (execution) => execution?.ctx?.model,
    });
    const result = parseResult(await execute(
      { action: 'spawn', role: 'executor', task: 'hit provider capacity' },
      { ctx: { model: 'deepseek/deepseek-v4-pro:high' } },
    ));

    assert.equal(result.child.status, 'failed');
    assert.equal(result.child.failureReason, 'provider_capacity_retryable');
    assert.equal(result.child.failureClass, 'provider_capacity');
    assert.equal(result.child.retryable, true);
    assert.equal(result.child.retryReason, 'provider_capacity');
    assert.equal(result.child.retryAfterMs, 2500);
    assert.equal(result.child.concurrencyInUse, 5);
    assert.equal(result.child.concurrencyLimit, 5);
    assert.equal(result.child.capacityBlocked, true);
    assert.equal(result.child.outputUsableForSynthesis, false);
    assert.equal(result.child.recommendedNextAction, 'retry_capacity_children_next_batch');
    assert.equal(result.child.childOutputHandle, null);
    assert.equal(result.child.childOutputPreview, null);
    assert.equal(result.child.terminalOutputPreview, null);
    assertPublicResultPathClean(result);
    assert.doesNotMatch(JSON.stringify(result), /NeuralWatt|GLM|Concurrent limit reached|slots in use/i);
    assert.equal(capturedRequests[0].params.model, 'deepseek/deepseek-v4-pro:high');
    assert.equal(Object.hasOwn(capturedRequests[0].params, 'fallbackModels'), false);
    assert.equal(Object.hasOwn(capturedRequests[0].params, 'provider'), false);
    assert.equal(Object.hasOwn(capturedRequests[0].params, 'concurrency'), false);

    const artifacts = ledgerArtifactsForRun(stateRoot, 'facade-immediate-capacity-run');
    const children = readFileSync(artifacts.children, 'utf8');
    const eventsText = readFileSync(artifacts.events, 'utf8');
    assert.doesNotMatch(children, /NeuralWatt|GLM|Concurrent limit reached|slots in use/i);
    assert.doesNotMatch(eventsText, /NeuralWatt|GLM|Concurrent limit reached|slots in use/i);
  });
});

test('stronk_subagent intercom async capacity failure is retryable and not readable output', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-async-capacity.'));
  const asyncRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-upstream-async-capacity.'));
  const asyncId = 'async-capacity-run';
  const events = new FakeEvents();
  const { asyncDir, resultPath } = registerSimpleIntercomRun(events, { stateRoot, asyncRoot, asyncId });
  const rawProviderText = 'HTTP 429 too many requests: max concurrent requests reached; 3/3 slots in use; retry after 3s';

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-async-capacity-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'intercom',
  }, async () => {
    const adapter = new PiSubagentsBridgeAdapter({ events, timeoutMs: 1000 });
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const spawn = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'capacity during async wait' }));
    writeFileSync(join(asyncDir, 'status.json'), JSON.stringify({
      runId: asyncId,
      mode: 'single',
      state: 'complete',
      startedAt: Date.now() - 1000,
      endedAt: Date.now(),
      lastUpdate: Date.now(),
      pid: process.pid,
      cwd: stateRoot,
      error: rawProviderText,
      retryAfter: '3s',
      steps: [{ agent: 'executor', status: 'failed', error: rawProviderText, statusCode: 429 }],
    }, null, 2));
    writeFileSync(resultPath, JSON.stringify({
      id: asyncId,
      mode: 'single',
      state: 'complete',
      success: false,
      error: rawProviderText,
      summary: rawProviderText,
      results: [{ agent: 'executor', success: false, error: rawProviderText }],
      exitCode: 1,
    }, null, 2));

    const waited = parseResult(await execute({ action: 'wait', childId: spawn.child.childId, timeoutMs: 1000 }));

    assert.equal(waited.child.status, 'failed');
    assert.equal(waited.child.failureClass, 'provider_capacity');
    assert.equal(waited.child.retryable, true);
    assert.equal(waited.child.retryAfterMs, 3000);
    assert.equal(waited.child.concurrencyInUse, 3);
    assert.equal(waited.child.concurrencyLimit, 3);
    assert.equal(waited.child.childOutputHandle, null);
    assert.equal(waited.child.childOutputPreview, null);
    assert.equal(waited.child.outputUsableForSynthesis, false);
    assert.equal(waited.child.recommendedNextAction, 'retry_capacity_children_next_batch');
    assert.doesNotMatch(JSON.stringify(waited), /max concurrent requests reached|slots in use/i);

    const artifacts = ledgerArtifactsForRun(stateRoot, 'facade-async-capacity-run');
    const children = readFileSync(artifacts.children, 'utf8');
    assert.doesNotMatch(children, /max concurrent requests reached|slots in use/i);
  });
});

test('stronk_subagent intercom wait classifies independent upstream failure signals', async () => {
  const cases = [
    {
      name: 'exit-code',
      expected: 'upstream_exit_code',
      status: { state: 'complete', steps: [{ agent: 'executor', status: 'complete', exitCode: 0 }] },
      result: { state: 'complete', success: true, exitCode: 2, summary: 'exit code failure visible' },
      preview: /exit code failure visible/,
    },
    {
      name: 'top-level-error',
      expected: 'upstream_error',
      status: { state: 'complete', steps: [{ agent: 'executor', status: 'complete', exitCode: 0 }] },
      result: { state: 'complete', success: true, exitCode: 0, error: 'top-level upstream error', summary: 'top-level error visible' },
      preview: /top-level error visible/,
    },
    {
      name: 'failed-row',
      expected: 'upstream_result_failed',
      status: { state: 'complete', steps: [{ agent: 'executor', status: 'complete', exitCode: 0 }] },
      result: {
        state: 'complete',
        success: true,
        exitCode: 0,
        results: [{ agent: 'executor', success: false, error: 'failed result row visible' }],
      },
      preview: /failed result row visible/,
    },
    {
      name: 'status-error',
      expected: 'upstream_status_error',
      status: { state: 'complete', error: 'status error visible', steps: [{ agent: 'executor', status: 'complete', exitCode: 0 }] },
      result: { state: 'complete', success: true, exitCode: 0 },
      preview: /status error visible/,
    },
    {
      name: 'failed-step',
      expected: 'upstream_step_failed',
      status: { state: 'complete', steps: [{ agent: 'executor', status: 'failed', error: 'step failure visible' }] },
      result: { state: 'complete', success: true, exitCode: 0 },
      preview: /step failure visible/,
    },
  ];

  for (const item of cases) {
    {
      const stateRoot = mkdtempSync(join(tmpdir(), `stronk-pi-facade-${item.name}.`));
      const asyncRoot = mkdtempSync(join(tmpdir(), `stronk-pi-upstream-${item.name}.`));
      const asyncId = `async-${item.name}-run`;
      const events = new FakeEvents();
      const { asyncDir, resultPath } = registerSimpleIntercomRun(events, { stateRoot, asyncRoot, asyncId });

      await withEnv({
        STRONK_PI_STATE_ROOT: stateRoot,
        STRONK_PI_FACADE_RUN_ID: `facade-${item.name}-run`,
        STRONK_PI_SUBAGENT_ADAPTER: 'intercom',
      }, async () => {
        const adapter = new PiSubagentsBridgeAdapter({ events, timeoutMs: 1000 });
        const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
        const spawn = parseResult(await execute({ action: 'spawn', role: 'executor', task: `classify ${item.name}` }));
        writeFileSync(join(asyncDir, 'status.json'), JSON.stringify({
          runId: asyncId,
          mode: 'single',
          startedAt: Date.now() - 1000,
          endedAt: Date.now(),
          lastUpdate: Date.now(),
          pid: process.pid,
          cwd: stateRoot,
          ...item.status,
        }, null, 2));
        writeFileSync(resultPath, JSON.stringify({
          id: asyncId,
          mode: 'single',
          ...item.result,
        }, null, 2));

        const waited = parseResult(await execute({ action: 'wait', childId: spawn.child.childId, timeoutMs: 1000 }));

        assert.equal(waited.child.status, 'failed');
        assert.equal(waited.child.failureReason, item.expected);
        assert.match(waited.child.childOutputPreview, item.preview);
        assert.equal(waited.child.recommendedNextAction, 'inspect_error');
      });
    }
  }
});

test('stronk_subagent intercom wait timeout returns non-terminal recovery metadata', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-timeout.'));
  const asyncRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-upstream-timeout.'));
  const asyncId = 'async-timeout-run';
  const asyncDir = join(asyncRoot, 'async-subagent-runs', asyncId);
  const events = new FakeEvents();

  events.on('subagent:slash:request', (request) => {
    events.emit('subagent:slash:started', { requestId: request.requestId });
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
    STRONK_PI_FACADE_RUN_ID: 'facade-timeout-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'intercom',
  }, async () => {
    const adapter = new PiSubagentsBridgeAdapter({ events, timeoutMs: 1000 });
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const spawn = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'stay running' }));
    const waited = parseResult(await execute({ action: 'wait', childId: spawn.child.childId, timeoutMs: 20 }));

    assert.equal(waited.child.status, 'running');
    assert.equal(waited.child.isTerminal, false);
    assert.equal(waited.child.timedOut, true);
    assert.equal(waited.child.timeoutMs, 20);
    assert.equal(waited.child.elapsedMs >= 20, true);
    assert.equal(waited.child.recommendedNextAction, 'wait_again');
  });
});

test('stronk_subagent intercom bridge start failure reports diagnose recovery metadata', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-start-fail.'));
  const events = new FakeEvents();

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-start-fail-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'intercom',
  }, async () => {
    const adapter = new PiSubagentsBridgeAdapter({ events, timeoutMs: 1000, startTimeoutMs: 20 });
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const result = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'bridge never starts' }));

    assert.equal(result.child.status, 'failed');
    assert.equal(result.child.timedOut, true);
    assert.equal(result.child.timeoutMs, 20);
    assert.equal(result.child.recommendedNextAction, 'run_diagnose');
    assert.equal(result.child.failureReason, 'bridge_start_timeout');
    assert.match(result.child.errorSummary, /bridge did not start/);
  });
});

test('stronk_subagent child output preview redacts before UTF-8-safe truncation', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-truncate.'));
  const asyncRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-upstream-truncate.'));
  const asyncId = 'async-truncate-run';
  const asyncDir = join(asyncRoot, 'async-subagent-runs', asyncId);
  const resultDir = join(asyncRoot, 'async-subagent-results');
  const resultPath = join(resultDir, `${asyncId}.json`);
  const events = new FakeEvents();

  events.on('subagent:slash:request', (request) => {
    events.emit('subagent:slash:started', { requestId: request.requestId });
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
    STRONK_PI_FACADE_RUN_ID: 'facade-truncate-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'intercom',
  }, async () => {
    const adapter = new PiSubagentsBridgeAdapter({ events, timeoutMs: 1000 });
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const spawn = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'produce large unicode output' }));
    const sensitivePrefix = 'password = "super secret with spaces" quoted="/Users/example/My Documents/private file.txt" /Users/example/Library/Application Support/App/secret.txt, file:///Users/example/Library/Application%20Support/App/secret.txt ';
    const raw = `${sensitivePrefix}${'a'.repeat(8180)} token = supersecret123 ${'😀'.repeat(64)}`;
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
      summary: raw,
      results: [{ agent: 'executor', output: raw, success: true }],
      exitCode: 0,
    }, null, 2));

    const waited = parseResult(await execute({ action: 'wait', childId: spawn.child.childId, timeoutMs: 1000 }));

    assert.equal(waited.child.status, 'completed');
    assert.equal(waited.child.childOutputTruncated, true);
    assert.equal(Buffer.byteLength(waited.child.childOutputPreview, 'utf8') <= 8192, true);
    assert.doesNotMatch(waited.child.childOutputPreview, /supersecret123/);
    assert.doesNotMatch(waited.child.childOutputPreview, /super secret with spaces/);
    assert.doesNotMatch(waited.child.childOutputPreview, /\/Users\/example/);
    assert.doesNotMatch(waited.child.childOutputPreview, /Application Support|My Documents|private file/);
    assert.doesNotMatch(waited.child.childOutputPreview, /file:\/\/\/Users/);
    assert.doesNotMatch(waited.child.childOutputPreview, /\uFFFD/);
  });
});

test('stronk_subagent intercom adapter sends live input through upstream resume', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-input.'));
  const asyncRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-upstream-input.'));
  const asyncId = 'async-input-run';
  const continuationAsyncId = 'async-input-run-continuation';
  const asyncDir = join(asyncRoot, 'async-subagent-runs', asyncId);
  const continuationAsyncDir = join(asyncRoot, 'async-subagent-runs', continuationAsyncId);
  const events = new FakeEvents();
  const capturedRequests = [];
  let createCount = 0;

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
    if (request.params.action === 'interrupt') {
      events.emit('subagent:slash:response', {
        requestId: request.requestId,
        isError: false,
        result: {
          content: [{ type: 'text', text: `Interrupted async child ${asyncId}` }],
          details: { mode: 'management', results: [] },
        },
      });
      return;
    }

    const selectedAsyncId = createCount === 0 ? asyncId : continuationAsyncId;
    const selectedAsyncDir = createCount === 0 ? asyncDir : continuationAsyncDir;
    createCount += 1;
    mkdirSync(selectedAsyncDir, { recursive: true });
    writeFileSync(join(selectedAsyncDir, 'status.json'), JSON.stringify({
      runId: selectedAsyncId,
      mode: 'single',
      state: 'running',
      startedAt: Date.now(),
      lastUpdate: Date.now(),
      pid: process.pid,
      cwd: stateRoot,
      steps: [{ agent: 'executor', status: 'running' }],
    }, null, 2));
    events.emit('subagent:async-started', { id: selectedAsyncId, asyncDir: selectedAsyncDir, pid: process.pid, mode: 'single', agent: 'executor' });
    events.emit('subagent:slash:response', {
      requestId: request.requestId,
      isError: false,
      result: {
        content: [{ type: 'text', text: `Async: executor [${selectedAsyncId}]` }],
        details: { mode: 'single', results: [], asyncId: selectedAsyncId, asyncDir: selectedAsyncDir },
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
    assert.equal(capturedRequests.length, 4);
    assert.equal(capturedRequests[1].params.action, 'resume');
    assert.equal(capturedRequests[1].params.id, asyncId);
    assert.equal(capturedRequests[1].params.message, 'continue with scoped check');
    assert.equal(capturedRequests[2].params.action, 'interrupt');
    assert.equal(capturedRequests[2].params.id, asyncId);
    assert.equal(capturedRequests[3].params.agent, 'executor');
    assert.equal(capturedRequests[3].params.task, 'continue with scoped check');
    assert.equal(sent.child.upstreamRunId, continuationAsyncId);
    assert.equal(sent.child.inputAccepted, true);
    assert.equal(sent.child.inputLinkedChildId, spawn.child.childId);
  });
});

test('stronk_subagent intercom adapter rejects send_input when upstream revives instead of delivering live input', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-input-not-live.'));
  const asyncRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-upstream-input-not-live.'));
  const asyncId = 'async-input-not-live-run';
  const revivedAsyncId = 'async-input-not-live-revived-run';
  const asyncDir = join(asyncRoot, 'async-subagent-runs', asyncId);
  const revivedAsyncDir = join(asyncRoot, 'async-subagent-runs', revivedAsyncId);
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
          content: [{ type: 'text', text: `Async: executor [${revivedAsyncId}]` }],
          details: { mode: 'single', results: [], asyncId: revivedAsyncId, asyncDir: revivedAsyncDir },
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
    STRONK_PI_FACADE_RUN_ID: 'facade-input-not-live-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'intercom',
    STRONK_PI_FACADE_DEBUG: '1',
  }, async () => {
    const adapter = new PiSubagentsBridgeAdapter({ events, timeoutMs: 1000 });
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const spawn = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'stay alive for follow-up' }));

    await assert.rejects(
      () => execute({ action: 'send_input', childId: spawn.child.childId, message: 'FOLLOWUP_PING', timeoutMs: 1000 }),
      /send_input failed: upstream did not deliver follow-up to live child/,
    );

    const status = parseResult(await execute({ action: 'status', childId: spawn.child.childId, timeoutMs: 1000 }));
    assert.equal(capturedRequests.at(-1).params.action, 'resume');
    assert.equal(status.child.inputAccepted, false);
    assert.equal(status.child.inputLinkedChildId, null);
  });
});

test('stronk_subagent send_input refreshes upstream state before terminal barrier', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-input-terminal-refresh.'));
  const asyncRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-upstream-input-terminal-refresh.'));
  const asyncId = 'async-input-terminal-refresh-run';
  const events = new FakeEvents();
  const capturedRequests = [];
  const { asyncDir, resultPath } = registerSimpleIntercomRun(events, { stateRoot, asyncRoot, asyncId, capturedRequests });

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-input-terminal-refresh-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'intercom',
  }, async () => {
    const adapter = new PiSubagentsBridgeAdapter({ events, timeoutMs: 1000 });
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const spawn = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'finish before follow-up' }));
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
      summary: 'finished before follow-up',
      results: [{ agent: 'executor', output: 'finished before follow-up', success: true }],
      exitCode: 0,
    }, null, 2));

    await assert.rejects(
      () => execute({ action: 'send_input', childId: spawn.child.childId, message: 'late follow-up', timeoutMs: 1000 }),
      /send_input denied: child is terminal or has no registered intercom target/,
    );

    assert.equal(capturedRequests.some((request) => request.params.action === 'resume'), false);
    const status = parseResult(await execute({ action: 'status', childId: spawn.child.childId }));
    assert.equal(status.child.status, 'completed');
    assert.match(status.child.childOutputPreview, /finished before follow-up/);
  });
});

test('stronk_subagent intercom revive forwards active parent model to upstream resume', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-revive-model.'));
  const asyncRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-upstream-revive-model.'));
  const asyncId = 'async-revive-source-run';
  const revivedId = 'async-revived-run';
  const asyncDir = join(asyncRoot, 'async-subagent-runs', asyncId);
  const revivedDir = join(asyncRoot, 'async-subagent-runs', revivedId);
  const resultDir = join(asyncRoot, 'async-subagent-results');
  const resultPath = join(resultDir, `${asyncId}.json`);
  const events = new FakeEvents();
  const capturedRequests = [];

  events.on('subagent:slash:request', (request) => {
    capturedRequests.push(request);
    events.emit('subagent:slash:started', { requestId: request.requestId });
    mkdirSync(resultDir, { recursive: true });

    if (request.params.action === 'resume') {
      mkdirSync(revivedDir, { recursive: true });
      writeFileSync(join(revivedDir, 'status.json'), JSON.stringify({
        runId: revivedId,
        mode: 'single',
        state: 'running',
        startedAt: Date.now(),
        lastUpdate: Date.now(),
        pid: process.pid,
        cwd: stateRoot,
        steps: [{ agent: 'executor', status: 'running' }],
      }, null, 2));
      events.emit('subagent:async-started', { id: revivedId, asyncDir: revivedDir, pid: process.pid, mode: 'single', agent: 'executor' });
      events.emit('subagent:slash:response', {
        requestId: request.requestId,
        isError: false,
        result: {
          content: [{ type: 'text', text: `Async: executor [${revivedId}]` }],
          details: { mode: 'single', results: [], asyncId: revivedId, asyncDir: revivedDir },
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
    STRONK_PI_FACADE_RUN_ID: 'facade-revive-model-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'intercom',
  }, async () => {
    const adapter = new PiSubagentsBridgeAdapter({ events, timeoutMs: 1000 });
    const execute = createSubagentFacade({
      adapter,
      allowedRoles: new Set(['executor']),
      parentModelProvider: (execution) => execution?.ctx?.model,
    });
    const spawn = parseResult(await execute(
      { action: 'spawn', role: 'executor', task: 'finish before revive' },
      { ctx: { model: 'deepseek/deepseek-v4-pro:high' } },
    ));
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
      summary: 'ready to revive',
      results: [{ agent: 'executor', output: 'ready to revive', success: true }],
      exitCode: 0,
    }, null, 2));
    const terminal = parseResult(await execute({ action: 'wait', childId: spawn.child.childId, timeoutMs: 1000 }));
    const revived = parseResult(await execute(
      { action: 'revive', childId: terminal.child.childId, task: 'continue with inherited model' },
      { ctx: { model: 'deepseek/deepseek-v4-pro:high' } },
    ));

    assert.equal(revived.previousChildId, terminal.child.childId);
    assert.equal(revived.child.previousChildId, terminal.child.childId);
    assert.equal(revived.child.upstreamRunId, revivedId);
    assert.equal(capturedRequests.at(-1).params.action, 'resume');
    assert.equal(capturedRequests.at(-1).params.model, 'deepseek/deepseek-v4-pro:high');
  });
});

test('stronk_subagent intercom revive retries capacity-blocked child with same task and parent model', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-capacity-revive.'));
  const asyncRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-upstream-capacity-revive.'));
  const revivedId = 'async-capacity-revived-run';
  const revivedDir = join(asyncRoot, 'async-subagent-runs', revivedId);
  const events = new FakeEvents();
  const capturedRequests = [];
  const task = 'retry this capacity-blocked task';
  const rawProviderText = 'HTTP 429 concurrent limit reached: 4/4 slots in use';

  events.on('subagent:slash:request', (request) => {
    capturedRequests.push(request);
    events.emit('subagent:slash:started', { requestId: request.requestId });
    if (capturedRequests.length === 1) {
      events.emit('subagent:slash:response', {
        requestId: request.requestId,
        isError: true,
        result: {
          content: [{ type: 'text', text: rawProviderText }],
          details: { mode: 'single', statusCode: 429 },
        },
      });
      return;
    }
    if (request.params.action === 'resume') {
      events.emit('subagent:slash:response', {
        requestId: request.requestId,
        isError: true,
        result: {
          content: [{ type: 'text', text: 'capacity retry must not use upstream resume without a live run id' }],
          details: { mode: 'management' },
        },
      });
      return;
    }
    mkdirSync(revivedDir, { recursive: true });
    writeFileSync(join(revivedDir, 'status.json'), JSON.stringify({
      runId: revivedId,
      mode: 'single',
      state: 'running',
      startedAt: Date.now(),
      lastUpdate: Date.now(),
      pid: process.pid,
      cwd: stateRoot,
      steps: [{ agent: 'executor', status: 'running' }],
    }, null, 2));
    events.emit('subagent:async-started', { id: revivedId, asyncDir: revivedDir, pid: process.pid, mode: 'single', agent: 'executor' });
    events.emit('subagent:slash:response', {
      requestId: request.requestId,
      isError: false,
      result: {
        content: [{ type: 'text', text: `Async: executor [${revivedId}]` }],
        details: { mode: 'single', results: [], asyncId: revivedId, asyncDir: revivedDir },
      },
    });
  });

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-capacity-revive-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'intercom',
  }, async () => {
    const adapter = new PiSubagentsBridgeAdapter({ events, timeoutMs: 1000 });
    const execute = createSubagentFacade({
      adapter,
      allowedRoles: new Set(['executor']),
      parentModelProvider: (execution) => execution?.ctx?.model,
    });
    const capacity = parseResult(await execute(
      { action: 'spawn', role: 'executor', task },
      { ctx: { model: 'deepseek/deepseek-v4-pro:high' } },
    ));
    const revived = parseResult(await execute(
      { action: 'revive', childId: capacity.child.childId },
      { ctx: { model: 'deepseek/deepseek-v4-pro:high' } },
    ));

    assert.equal(capacity.child.failureClass, 'provider_capacity');
    assert.equal(revived.previousChildId, capacity.child.childId);
    assert.equal(revived.child.previousChildId, capacity.child.childId);
    assert.equal(revived.child.status, 'running');
    assert.equal(revived.child.upstreamRunId, revivedId);
    assert.equal(capturedRequests.length, 2);
    assert.equal(capturedRequests[1].params.agent, 'executor');
    assert.equal(capturedRequests[1].params.task, task);
    assert.equal(capturedRequests[1].params.model, 'deepseek/deepseek-v4-pro:high');
    assert.equal(Object.hasOwn(capturedRequests[1].params, 'fallbackModels'), false);
    assert.equal(Object.hasOwn(capturedRequests[1].params, 'provider'), false);
    assert.equal(Object.hasOwn(capturedRequests[1].params, 'concurrency'), false);
    assert.equal(Object.hasOwn(capturedRequests[1].params, 'maxConcurrency'), false);
  });
});

test('stronk_subagent intercom close reports conservative cleanup proof for live child', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-facade-close-live.'));
  const asyncRoot = mkdtempSync(join(tmpdir(), 'stronk-pi-upstream-close-live.'));
  const asyncId = 'async-close-live-run';
  const events = new FakeEvents();
  const capturedRequests = [];
  registerSimpleIntercomRun(events, { stateRoot, asyncRoot, asyncId, capturedRequests });

  await withEnv({
    STRONK_PI_STATE_ROOT: stateRoot,
    STRONK_PI_FACADE_RUN_ID: 'facade-close-live-run',
    STRONK_PI_SUBAGENT_ADAPTER: 'intercom',
  }, async () => {
    const adapter = new PiSubagentsBridgeAdapter({ events, timeoutMs: 1000 });
    const execute = createSubagentFacade({ adapter, allowedRoles: new Set(['executor']) });
    const spawn = parseResult(await execute({ action: 'spawn', role: 'executor', task: 'stay alive until close' }));
    const closed = parseResult(await execute({ action: 'close', childId: spawn.child.childId, timeoutMs: 1000 }));

    assert.equal(closed.child.status, 'closed');
    assert.equal(closed.child.terminalResult, 'closed');
    assert.equal(closed.child.cleanupState, 'closed');
    assert.equal(closed.child.closeRequested, true);
    assert.equal(closed.child.processLive, true);
    assert.equal(closed.child.cleanupVerified, false);
    assert.equal(closed.child.recommendedNextAction, null);
    assert.equal(capturedRequests.some((request) => request.params.action === 'interrupt'), true);
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
    assert.equal(closed.child.closeRequested, false);
    assert.equal(closed.child.upstreamState, 'complete');
    assert.equal(closed.child.processLive, true);
    assert.equal(closed.child.cleanupVerified, false);
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

    const artifacts = ledgerArtifactsForRun(stateRoot, 'facade-interrupt-fail-run');
    const children = readFileSync(artifacts.children, 'utf8');
    const eventsText = readFileSync(artifacts.events, 'utf8');
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

    const artifacts = ledgerArtifactsForRun(stateRoot, 'facade-close-fail-run');
    const children = readFileSync(artifacts.children, 'utf8');
    const eventsText = readFileSync(artifacts.events, 'utf8');
    assert.doesNotMatch(children, /sensitive output body/);
    assert.doesNotMatch(eventsText, /sensitive output body/);
    assert.match(eventsText, /bridge_close_error/);
    assert.match(eventsText, /errorSha256/);
  });
});
