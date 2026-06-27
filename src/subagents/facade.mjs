import { readFileSync, readdirSync, statSync } from 'node:fs';
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
  return JSON.stringify(payload, null, 2);
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

function facadeResult(action, ledger, payload = {}) {
  const warnings = dryRunWarnings(payload);
  const details = { ok: true, action, ...payload };
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
      const child = await adapter.spawn(ledger, normalized, runtime);
      return facadeResult('spawn', ledger, { child: ledger.publicChild(child) });
    }

    if (normalized.action === 'status') {
      const child = typeof adapter.status === 'function'
        ? await adapter.status(ledger, normalized.childId, normalized)
        : await ledger.getChild(normalized.childId);
      return facadeResult('status', ledger, { child: ledger.publicChild(child) });
    }

    if (normalized.action === 'wait') {
      const child = await adapter.wait(ledger, normalized.childId, normalized);
      return facadeResult('wait', ledger, { child: ledger.publicChild(child) });
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
        children.push(ledger.publicChild(child));
      }
      return facadeResult('wait_all', ledger, aggregateChildren(children, timeoutMs, Date.now() - startedAt));
    }

    if (normalized.action === 'read_output') {
      const output = await ledger.readOutput(normalized.outputHandle, {
        offset: normalized.offset,
        maxChars: normalized.maxChars,
      });
      return facadeResult('read_output', ledger, { output });
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
        const updated = await adapter.sendInput(ledger, normalized.childId, normalized, runtime);
        return facadeResult('send_input', ledger, { child: ledger.publicChild(updated) });
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
        const revived = await adapter.revive(ledger, previous.childId, normalized, runtime);
        return facadeResult('revive', ledger, { previousChildId: previous.childId, child: ledger.publicChild(revived) });
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
      return facadeResult('revive', ledger, { previousChildId: previous.childId, child: ledger.publicChild(revived) });
    }

    if (normalized.action === 'close') {
      const child = await adapter.close(ledger, normalized.childId, normalized);
      return facadeResult('close', ledger, { child: ledger.publicChild(child) });
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
          const cleared = await ledger.clearChildOutput(closed.childId);
          children.push(ledger.publicChild(cleared));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const current = await ledger.getChild(childId);
          const patched = await ledger.updateChild(childId, {
            closeError: message,
            cleanupState: current.cleanupState === 'none' ? 'close_failed' : current.cleanupState,
            cleanupVerified: false,
          }, 'child_close_failed_visible');
          children.push(ledger.publicChild(patched));
        }
      }
      return facadeResult('close_all', ledger, aggregateClosedChildren(children, timeoutMs, Date.now() - startedAt));
    }

    if (normalized.action === 'interrupt') {
      const child = await adapter.interrupt(ledger, normalized.childId, normalized);
      return facadeResult('interrupt', ledger, { child: ledger.publicChild(child) });
    }

    throw new Error(`stronk_subagent action denied: ${normalized.action}`);
  };
}
