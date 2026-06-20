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

function manifestRoles(manifestPath = process.env.STRONK_PI_ROLE_MANIFEST) {
  if (!manifestPath) {
    throw new Error('stronk_subagent role manifest required');
  }
  let text;
  try {
    text = readFileSync(manifestPath, 'utf8');
  } catch {
    throw new Error(`stronk_subagent role manifest unreadable: ${manifestPath}`);
  }
  const match = text.match(/codex_roles_dir\s*=\s*"([^"]+)"/);
  if (!match) {
    throw new Error('stronk_subagent role manifest missing codex_roles_dir');
  }
  const rolesDir = resolveManifestRelative(resolve(manifestPath), match[1]);
  try {
    return new Set(
      readdirSync(rolesDir)
        .filter((entry) => entry.endsWith('.toml'))
        .map((entry) => entry.slice(0, -5))
        .filter((entry) => statSync(resolve(rolesDir, `${entry}.toml`)).isFile()),
    );
  } catch {
    throw new Error(`stronk_subagent role manifest roles dir unreadable: ${rolesDir}`);
  }
}

function assertAllowedRole(role, allowedRoles = manifestRoles()) {
  if (!allowedRoles.has(role)) {
    throw new Error(`stronk_subagent role denied: ${role}`);
  }
}

const ROLE_ALIASES = new Map([
  ['researcher', 'technical-researcher'],
  ['worker', 'executor'],
  ['delegate', 'executor'],
  ['implementer', 'executor'],
  ['coder', 'executor'],
  ['reviewer', 'code-reviewer'],
  ['security', 'security-reviewer'],
  ['qa', 'qa-tester'],
  ['tester', 'qa-tester'],
]);

function normalizeRole(role) {
  return ROLE_ALIASES.get(role) || role;
}

function output(payload) {
  return JSON.stringify(payload, null, 2);
}

function debugArtifacts(ledger) {
  return process.env.STRONK_PI_FACADE_DEBUG === '1' ? { artifacts: ledger.artifactPaths() } : {};
}

function facadeResult(action, ledger, payload = {}) {
  const details = { ok: true, action, ...payload, ...debugArtifacts(ledger) };
  return {
    text: output(details),
    details,
  };
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

export function rawSubagentMode() {
  return process.env.STRONK_PI_RAW_SUBAGENT || (facadeMode() === 'stronk' ? 'disabled' : 'enabled');
}

export function createSubagentFacade({ adapter = new DryRunSubagentAdapter(), ledgerFactory, allowedRoles, facadeRunId } = {}) {
  const stableFacadeRunId = facadeRunId || process.env.STRONK_PI_FACADE_RUN_ID || createFacadeRunId();
  return async function executeStronkSubagent(params = {}) {
    const normalized = normalizeFacadePayload(params);
    if (normalized.role) normalized.role = normalizeRole(normalized.role);
    const ledger = await (ledgerFactory?.(normalized) ?? new SubagentLedger({
      cwd: normalized.cwd || process.cwd(),
      mode: facadeAdapterMode(),
      rawSubagent: rawSubagentMode(),
      maxChildren: MAX_CHILDREN,
      facadeRunId: stableFacadeRunId,
    })).init();

    if (normalized.action === 'spawn') {
      assertAllowedRole(normalized.role, allowedRoles);
      const child = await adapter.spawn(ledger, normalized);
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

    if (normalized.action === 'send_input') {
      const child = await ledger.getChild(normalized.childId);
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
        const updated = await adapter.sendInput(ledger, normalized.childId, normalized);
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
        const revived = await adapter.revive(ledger, previous.childId, normalized);
        return facadeResult('revive', ledger, { previousChildId: previous.childId, child: ledger.publicChild(revived) });
      }
      const revived = await adapter.spawn(ledger, {
        action: 'spawn',
        role: previous.role,
        cwd: normalized.cwd || previous.cwd,
        task: normalized.task || `revive:${previous.childId}`,
        previousChildId: previous.childId,
      });
      return facadeResult('revive', ledger, { previousChildId: previous.childId, child: ledger.publicChild(revived) });
    }

    if (normalized.action === 'close') {
      const child = await adapter.close(ledger, normalized.childId, normalized);
      return facadeResult('close', ledger, { child: ledger.publicChild(child) });
    }

    if (normalized.action === 'interrupt') {
      const child = await adapter.interrupt(ledger, normalized.childId, normalized);
      return facadeResult('interrupt', ledger, { child: ledger.publicChild(child) });
    }

    throw new Error(`stronk_subagent action denied: ${normalized.action}`);
  };
}
