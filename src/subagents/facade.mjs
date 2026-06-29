import { readFileSync, readdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { normalizeFacadePayload, stronkSubagentSchema, MAX_CHILDREN } from './schema.mjs';
import { SubagentLedger, createFacadeRunId, isTerminalStatus } from './ledger.mjs';
import { DryRunSubagentAdapter } from './adapters/dry-run.mjs';

export { stronkSubagentSchema };

function resolveManifestRelative(manifestPath, rawPath) {
  if (!rawPath) return undefined;
  const expanded = rawPath.replace(/^~(?=\/|$)/, process.env.HOME || '');
  return resolve(dirname(manifestPath), expanded);
}

function rolesFromManifest(manifestPath) {
  if (!manifestPath) return new Set();
  const resolvedManifest = resolve(manifestPath);
  let text;
  try {
    text = readFileSync(resolvedManifest, 'utf8');
  } catch {
    throw new Error(`stronk_subagent role manifest unreadable: ${manifestPath}`);
  }
  const matches = [...text.matchAll(/codex_roles_dir\s*=\s*"([^"]+)"/g)];
  if (matches.length === 0) {
    throw new Error('stronk_subagent role manifest missing codex_roles_dir');
  }
  const roles = new Set();
  for (const match of matches) {
    const rolesDir = resolveManifestRelative(resolvedManifest, match[1]);
    try {
      for (const entry of readdirSync(rolesDir)) {
        if (!entry.endsWith('.toml')) continue;
        const role = entry.slice(0, -5);
        if (statSync(resolve(rolesDir, `${role}.toml`)).isFile()) roles.add(role);
      }
    } catch {
      throw new Error(`stronk_subagent role manifest roles dir unreadable: ${rolesDir}`);
    }
  }
  return roles;
}

function manifestRoles(manifestPath = process.env.STRONK_PI_ROLE_MANIFEST, localManifestPath = process.env.STRONK_PI_ROLE_MANIFEST_LOCAL) {
  if (!manifestPath) {
    throw new Error('stronk_subagent role manifest required');
  }
  return new Set([
    ...rolesFromManifest(manifestPath),
    ...rolesFromManifest(localManifestPath),
  ]);
}

function assertAllowedRole(role, allowedRoles = manifestRoles()) {
  if (!allowedRoles.has(role)) {
    const allowed = [...allowedRoles].sort().join(', ') || 'none';
    throw new Error(`stronk_subagent role denied: ${role}. Allowed roles: ${allowed}`);
  }
}

const ROLE_ALIASES = new Map([
  ['researcher', ['technical-researcher']],
  ['scout', ['technical-researcher', 'explorer']],
  ['context-builder', ['technical-researcher', 'explorer']],
  ['docs-scout', ['technical-researcher', 'explorer']],
  ['structure-scout', ['technical-researcher', 'explorer']],
  ['source-scout', ['technical-researcher', 'explorer']],
  ['oracle', ['planner', 'critic']],
  ['worker', ['executor']],
  ['delegate', ['executor']],
  ['implementer', ['executor']],
  ['coder', ['executor']],
  ['reviewer', ['code-reviewer']],
  ['security', ['code-reviewer', 'security-reviewer']],
  ['qa', ['executor', 'qa-tester']],
  ['tester', ['executor', 'qa-tester']],
]);

function normalizeRole(role, allowedRoles) {
  if (allowedRoles?.has(role)) return role;
  const aliases = ROLE_ALIASES.get(role);
  if (!aliases) return role;
  if (allowedRoles) {
    const allowedAlias = aliases.find((alias) => allowedRoles.has(alias));
    if (allowedAlias) return allowedAlias;
  }
  return aliases[0] || role;
}

function resolveRoleMetadata(role, allowedRoles) {
  const roleUsed = normalizeRole(role, allowedRoles);
  const aliasResolved = roleUsed !== role;
  return {
    roleRequested: role,
    roleUsed,
    aliasResolved,
    aliasMessage: aliasResolved ? `${role} resolved to ${roleUsed}` : null,
  };
}

function output(payload) {
  return JSON.stringify(payload);
}

function debugArtifacts(ledger) {
  return process.env.STRONK_PI_FACADE_DEBUG === '1' ? { debug: ledger.publicDiagnostics() } : {};
}

function dryRunWarnings(payload = {}) {
  const child = payload.child;
  if (child?.status !== 'dry-run' && child?.terminalResult !== 'dry-run-completed') return [];
  return [{
    code: 'dry_run_no_worker',
    message: 'stronk_subagent dry-run completed without launching a worker; delegation output is unavailable',
    terminalResult: child.terminalResult ?? 'dry-run-completed',
  }];
}

const FACADE_SCHEMA_VERSION = 2;

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function statusCounts(children = []) {
  const counts = {};
  for (const child of children) {
    const status = child?.status ?? 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function compactChild(child) {
  const artifactKind = child.outputArtifactKind
    ?? (child.childOutputHandle || child.childOutputPreview
      ? child.status === 'completed'
        ? 'findings'
        : child.status === 'failed'
          ? 'failure-summary'
          : 'terminal-summary'
      : undefined);
  return compactObject({
    childId: child.childId,
    role: child.role,
    roleRequested: child.roleRequested ?? child.role,
    roleUsed: child.roleUsed ?? child.role,
    aliasResolved: Boolean(child.aliasResolved),
    aliasMessage: child.aliasMessage ?? null,
    status: child.status,
    isTerminal: isTerminalStatus(child.status),
    previousChildId: child.previousChildId ?? null,
    upstreamRunId: child.upstreamRunId ?? null,
    upstreamState: child.upstreamState ?? null,
    intercomTarget: child.intercomTarget ?? null,
    pid: child.pid ?? null,
    terminalResult: child.terminalResult ?? null,
    terminalResultSha256: child.terminalResultSha256 ?? null,
    terminalResultBytes: child.terminalResultBytes ?? 0,
    childOutputTruncated: Boolean(child.childOutputTruncated),
    childOutputBytes: child.childOutputBytes ?? 0,
    childOutputHash: child.childOutputHash ?? null,
    childOutputHandle: child.childOutputHandle ?? null,
    childOutputFullBytes: child.childOutputFullBytes ?? null,
    childOutputFullChars: child.childOutputFullChars ?? null,
    childOutputFullHash: child.childOutputFullHash ?? null,
    childOutputArtifactTruncated: Boolean(child.childOutputArtifactTruncated),
    outputArtifactKind: artifactKind,
    outputUsableForSynthesis: child.outputUsableForSynthesis ?? artifactKind === 'findings',
    failureReason: child.failureReason ?? null,
    failureClass: child.failureClass ?? null,
    retryable: Boolean(child.retryable),
    retryReason: child.retryReason ?? null,
    retryAfterMs: typeof child.retryAfterMs === 'number' ? child.retryAfterMs : null,
    capacityBlocked: Boolean(child.capacityBlocked),
    concurrencyInUse: typeof child.concurrencyInUse === 'number' ? child.concurrencyInUse : null,
    concurrencyLimit: typeof child.concurrencyLimit === 'number' ? child.concurrencyLimit : null,
    errorSummary: child.errorSummary ?? null,
    timedOut: child.timedOut ? true : undefined,
    elapsedMs: typeof child.elapsedMs === 'number' ? child.elapsedMs : undefined,
    timeoutMs: typeof child.timeoutMs === 'number' ? child.timeoutMs : undefined,
    recommendedNextAction: child.recommendedNextAction ?? null,
    closeRequested: Boolean(child.closeRequested),
    cleanupState: child.cleanupState && child.cleanupState !== 'none' ? child.cleanupState : undefined,
    processLive: child.processLive ?? null,
    cleanupVerified: Boolean(child.cleanupVerified),
    closeError: child.closeError ?? null,
    inputAccepted: Boolean(child.inputAccepted),
    inputLinkedChildId: child.inputLinkedChildId ?? null,
  });
}

function ledgerPointer(ledger, children = []) {
  const diagnostics = ledger.publicDiagnostics();
  const handles = children
    .map((child) => child.childOutputHandle)
    .filter((handle) => typeof handle === 'string' && handle);
  return compactObject({
    facadeRunId: diagnostics.facadeRunId,
    projectRef: diagnostics.projectRef,
    childOutputHandle: handles.length === 1 ? handles[0] : undefined,
    childOutputHandles: handles.length > 1 ? Object.fromEntries(children
      .filter((child) => typeof child.childOutputHandle === 'string' && child.childOutputHandle)
      .map((child) => [child.childId, child.childOutputHandle])) : undefined,
  });
}

function lifecycleEnvelope(action, ledger, payload = {}, children = []) {
  const childIds = payload.childIds ?? children.map((child) => child.childId).filter(Boolean);
  const counts = payload.counts ?? statusCounts(children);
  const status = payload.status
    ?? (children.length === 0 ? 'ok' : children.every((child) => isTerminalStatus(child.status)) ? 'terminal' : 'active');
  return compactObject({
    ok: true,
    action,
    requestId: `sp-request-${randomUUID()}`,
    schemaVersion: FACADE_SCHEMA_VERSION,
    facadeRunId: ledger.publicDiagnostics().facadeRunId,
    status,
    counts,
    childIds,
    ledger: ledgerPointer(ledger, children),
    ...payload,
  });
}

function facadeResult(action, ledger, payload = {}, children = []) {
  const warnings = dryRunWarnings(payload);
  const details = lifecycleEnvelope(action, ledger, payload, children);
  if (warnings.length > 0) details.warnings = warnings;
  Object.assign(details, debugArtifacts(ledger));
  return {
    text: output(details),
    details,
  };
}

async function validateKnownChildren(ledger, childIds) {
  const children = await ledger.children();
  const byId = new Map(children.map((child) => [child.childId, child]));
  for (const childId of childIds) {
    if (!byId.has(childId)) {
      throw new Error(`stronk_subagent child not found or foreign-run denied: ${childId}`);
    }
  }
}

function aggregateChildren(children, timeoutMs, elapsedMs) {
  const terminalChildIds = [];
  const nonTerminalChildIds = [];
  const failedChildIds = [];
  const nonRetryableFailedChildIds = [];
  const retryableCapacityChildIds = [];
  let nextRetryAfterMs = null;
  for (const child of children) {
    if (isTerminalStatus(child.status)) terminalChildIds.push(child.childId);
    else nonTerminalChildIds.push(child.childId);
    if (child.status === 'failed' || child.failureReason) failedChildIds.push(child.childId);
    const capacityRetryable = child.failureClass === 'provider_capacity'
      || child.retryReason === 'provider_capacity'
      || (child.retryable === true && child.capacityBlocked === true);
    if (capacityRetryable) {
      retryableCapacityChildIds.push(child.childId);
      if (typeof child.retryAfterMs === 'number') {
        nextRetryAfterMs = nextRetryAfterMs === null
          ? child.retryAfterMs
          : Math.min(nextRetryAfterMs, child.retryAfterMs);
      }
    } else if (child.status === 'failed' || child.failureReason) {
      nonRetryableFailedChildIds.push(child.childId);
    }
  }
  const retryPolicy = retryableCapacityChildIds.length === 0
    ? null
    : nextRetryAfterMs !== null
      ? 'after_retry_after'
      : nonTerminalChildIds.length > 0
        ? 'after_nonterminal_drain'
        : 'next_batch';
  return {
    children,
    terminalChildIds,
    nonTerminalChildIds,
    failedChildIds,
    nonRetryableFailedChildIds,
    retryableCapacityChildIds,
    nextRetryAfterMs,
    retryPolicy,
    timedOut: nonTerminalChildIds.length > 0,
    elapsedMs,
    timeoutMs,
    recommendedNextAction: nonTerminalChildIds.length > 0
      ? 'wait_again'
      : nonRetryableFailedChildIds.length > 0
        ? 'inspect_error'
        : retryableCapacityChildIds.length > 0
          ? 'retry_capacity_children_next_batch'
          : null,
  };
}

function aggregateClosedChildren(children, timeoutMs, elapsedMs) {
  const closedChildIds = [];
  const failedCloseChildIds = [];
  const cleanupVerifiedChildIds = [];
  const cleanupFailedChildIds = [];
  for (const child of children) {
    if (child.closeError || child.cleanupState === 'close_failed' || child.cleanupState === 'interrupt_failed') {
      failedCloseChildIds.push(child.childId);
    } else if (child.cleanupState === 'closed' || child.cleanupState === 'already_closed' || child.status === 'closed' || child.isTerminal) {
      closedChildIds.push(child.childId);
    }
    if (child.cleanupVerified) cleanupVerifiedChildIds.push(child.childId);
    if (child.closeError || child.cleanupState === 'close_failed' || child.cleanupState === 'interrupt_failed') {
      cleanupFailedChildIds.push(child.childId);
    }
  }
  const timedOut = elapsedMs >= timeoutMs && cleanupFailedChildIds.length > 0;
  return {
    children,
    closedChildIds,
    failedCloseChildIds,
    cleanupVerifiedChildIds,
    cleanupFailedChildIds,
    timedOut,
    elapsedMs,
    timeoutMs,
    recommendedNextAction: failedCloseChildIds.length > 0 ? 'inspect_error' : null,
  };
}

function runtimeHints(parentModelProvider, execution) {
  if (typeof parentModelProvider !== 'function') return {};
  const model = parentModelProvider(execution);
  return typeof model === 'string' && model.trim() ? { parentModel: model.trim() } : {};
}

export function facadeEnabled() {
  const value = process.env.STRONK_PI_SUBAGENT_FACADE;
  return Boolean(value) && value !== 'off' && value !== '0';
}

export function facadeMode() {
  return process.env.STRONK_PI_SUBAGENT_FACADE || 'shadow';
}

export function facadeAdapterMode() {
  return process.env.STRONK_PI_SUBAGENT_ADAPTER || 'dry-run';
}

export function createSubagentFacade({
  adapter = new DryRunSubagentAdapter(),
  ledgerFactory,
  allowedRoles,
  facadeRunId,
  parentModelProvider,
} = {}) {
  const stableFacadeRunId = facadeRunId || process.env.STRONK_PI_FACADE_RUN_ID || createFacadeRunId();
  return async function executeStronkSubagent(params = {}, execution = {}) {
    const normalized = normalizeFacadePayload(params);
    const ledger = await (ledgerFactory?.(normalized) ?? new SubagentLedger({
      cwd: process.cwd(),
      mode: facadeAdapterMode(),
      maxChildren: MAX_CHILDREN,
      facadeRunId: stableFacadeRunId,
    })).init();
    const runtime = runtimeHints(parentModelProvider, execution);

    if (normalized.action === 'spawn') {
      const spawnAllowedRoles = allowedRoles ?? manifestRoles();
      const roleMetadata = resolveRoleMetadata(normalized.role, spawnAllowedRoles);
      Object.assign(normalized, roleMetadata, { role: roleMetadata.roleUsed });
      assertAllowedRole(normalized.role, spawnAllowedRoles);
      const child = compactChild(ledger.publicChild(await adapter.spawn(ledger, normalized, runtime)));
      return facadeResult('spawn', ledger, { child }, [child]);
    }

    if (normalized.action === 'list') {
      const children = (await ledger.children()).map((child) => compactChild(ledger.publicChild(child)));
      await ledger.appendEvent({
        event: 'facade_list',
        childIds: children.map((child) => child.childId),
      });
      return facadeResult('list', ledger, {
        statusByChildId: Object.fromEntries(children.map((child) => [child.childId, child.status])),
      }, children);
    }

    if (normalized.action === 'status') {
      const child = typeof adapter.status === 'function'
        ? await adapter.status(ledger, normalized.childId, normalized)
        : await ledger.getChild(normalized.childId);
      const publicChild = compactChild(ledger.publicChild(child));
      return facadeResult('status', ledger, { child: publicChild }, [publicChild]);
    }

    if (normalized.action === 'wait') {
      const child = await adapter.wait(ledger, normalized.childId, normalized);
      const publicChild = compactChild(ledger.publicChild(child));
      return facadeResult('wait', ledger, { child: publicChild }, [publicChild]);
    }

    if (normalized.action === 'wait_all') {
      await validateKnownChildren(ledger, normalized.childIds);
      const timeoutMs = normalized.timeoutMs ?? 3600000;
      const startedAt = Date.now();
      const deadline = startedAt + timeoutMs;
      const children = [];
      for (const childId of normalized.childIds) {
        const remainingMs = Math.max(1, deadline - Date.now());
        const child = await adapter.wait(ledger, childId, { ...normalized, childId, timeoutMs: remainingMs });
        children.push(compactChild(ledger.publicChild(child)));
      }
      const aggregate = aggregateChildren(children, timeoutMs, Date.now() - startedAt);
      await ledger.appendEvent({
        event: 'facade_wait_all',
        childIds: normalized.childIds,
        terminalChildIds: aggregate.terminalChildIds,
        nonTerminalChildIds: aggregate.nonTerminalChildIds,
        failedChildIds: aggregate.failedChildIds,
        timedOut: aggregate.timedOut,
        timeoutMs,
      });
      const { children: _children, ...compactAggregate } = aggregate;
      return facadeResult('wait_all', ledger, {
        ...compactAggregate,
        statusByChildId: Object.fromEntries(children.map((child) => [child.childId, child.status])),
      }, children);
    }

    if (normalized.action === 'read_output') {
      const output = await ledger.readOutput(normalized.outputHandle, {
        offset: normalized.offset,
        maxChars: normalized.maxChars,
      });
      await ledger.appendEvent({
        event: 'facade_read_output',
        outputHandle: normalized.outputHandle,
        childId: output.childId,
        offset: output.offset,
        nextOffset: output.nextOffset,
        totalChars: output.totalChars,
        eof: output.eof,
        maxChars: normalized.maxChars,
      });
      return facadeResult('read_output', ledger, { output }, [{ childId: output.childId, status: 'read', childOutputHandle: output.handle }]);
    }

    if (normalized.action === 'send_input') {
      const child = typeof adapter.status === 'function'
        ? await adapter.status(ledger, normalized.childId, normalized)
        : await ledger.getChild(normalized.childId);
      if (isTerminalStatus(child.status) || !child.intercomTarget) {
        await ledger.appendEvent({
          event: 'send_input_denied',
          childId: child.childId,
          status: child.status,
          reason: 'terminal_or_missing_intercom_target',
          hasIntercomTarget: Boolean(child.intercomTarget),
        });
        throw new Error('stronk_subagent send_input denied: child is terminal or has no registered intercom target');
      }
      if (typeof adapter.sendInput === 'function') {
        const updated = compactChild(ledger.publicChild(await adapter.sendInput(ledger, normalized.childId, normalized, runtime)));
        return facadeResult('send_input', ledger, { child: updated }, [updated]);
      }
      await ledger.appendEvent({
        event: 'send_input_denied',
        childId: child.childId,
        status: child.status,
        reason: 'live_intercom_adapter_disabled',
        hasIntercomTarget: Boolean(child.intercomTarget),
      });
      throw new Error('stronk_subagent send_input denied: live intercom adapter is not enabled');
    }

    if (normalized.action === 'revive') {
      const previous = await ledger.getChild(normalized.childId);
      if (!isTerminalStatus(previous.status)) {
        throw new Error('stronk_subagent revive denied: child is not terminal');
      }
      if (typeof adapter.revive === 'function') {
        const revived = compactChild(ledger.publicChild(await adapter.revive(ledger, previous.childId, normalized, runtime)));
        return facadeResult('revive', ledger, { previousChildId: previous.childId, child: revived }, [revived]);
      }
      const revived = await adapter.spawn(ledger, {
        action: 'spawn',
        role: previous.role,
        roleRequested: previous.roleRequested ?? previous.role,
        roleUsed: previous.roleUsed ?? previous.role,
        aliasResolved: Boolean(previous.aliasResolved),
        aliasMessage: previous.aliasMessage ?? null,
        cwd: previous.cwd,
        task: normalized.task || `revive:${previous.childId}`,
        previousChildId: previous.childId,
      }, runtime);
      const publicChild = compactChild(ledger.publicChild(revived));
      return facadeResult('revive', ledger, { previousChildId: previous.childId, child: publicChild }, [publicChild]);
    }

    if (normalized.action === 'close') {
      const child = await adapter.close(ledger, normalized.childId, normalized);
      const publicChild = compactChild(ledger.publicChild(child));
      return facadeResult('close', ledger, { child: publicChild }, [publicChild]);
    }

    if (normalized.action === 'close_all') {
      await validateKnownChildren(ledger, normalized.childIds);
      const timeoutMs = normalized.timeoutMs ?? 3600000;
      const startedAt = Date.now();
      const deadline = startedAt + timeoutMs;
      const children = [];
      for (const childId of normalized.childIds) {
        const remainingMs = Math.max(1, deadline - Date.now());
        try {
          const closed = await adapter.close(ledger, childId, { ...normalized, childId, timeoutMs: remainingMs });
          children.push(compactChild(ledger.publicChild(closed)));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const current = await ledger.getChild(childId);
          const patched = await ledger.updateChild(childId, {
            closeError: message,
            cleanupState: current.cleanupState === 'none' ? 'close_failed' : current.cleanupState,
            cleanupVerified: false,
          }, 'child_close_failed_visible');
          children.push(compactChild(ledger.publicChild(patched)));
        }
      }
      const aggregate = aggregateClosedChildren(children, timeoutMs, Date.now() - startedAt);
      await ledger.appendEvent({
        event: 'facade_close_all',
        childIds: normalized.childIds,
        closedChildIds: aggregate.closedChildIds,
        failedCloseChildIds: aggregate.failedCloseChildIds,
        cleanupVerifiedChildIds: aggregate.cleanupVerifiedChildIds,
        cleanupFailedChildIds: aggregate.cleanupFailedChildIds,
        timedOut: aggregate.timedOut,
        timeoutMs,
      });
      const { children: _children, ...compactAggregate } = aggregate;
      return facadeResult('close_all', ledger, {
        ...compactAggregate,
        statusByChildId: Object.fromEntries(children.map((child) => [child.childId, child.status])),
      }, children);
    }

    if (normalized.action === 'interrupt') {
      const child = await adapter.interrupt(ledger, normalized.childId, normalized);
      const publicChild = compactChild(ledger.publicChild(child));
      return facadeResult('interrupt', ledger, { child: publicChild }, [publicChild]);
    }

    throw new Error(`stronk_subagent action denied: ${normalized.action}`);
  };
}
