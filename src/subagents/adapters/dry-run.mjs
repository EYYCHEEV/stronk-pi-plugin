import { isTerminalStatus } from '../ledger.mjs';

const DRY_RUN_PATCH = {
  status: 'dry-run',
  terminalResult: 'dry-run-completed',
  cleanupState: 'none',
};

export class DryRunSubagentAdapter {
  constructor() {
    this.calls = [];
  }

  async spawn(ledger, normalized) {
    this.calls.push({ action: 'spawn', role: normalized.role });
    const child = await ledger.createChild(normalized);
    await ledger.updateChild(child.childId, { status: 'running' }, 'child_running');
    return ledger.updateChild(
      child.childId,
      DRY_RUN_PATCH,
      'child_dry_run',
    );
  }

  async wait(ledger, childId) {
    this.calls.push({ action: 'wait', childId });
    const child = await ledger.getChild(childId);
    if (!isTerminalStatus(child.status)) {
      return ledger.updateChild(childId, DRY_RUN_PATCH, 'child_dry_run');
    }
    return child;
  }

  async close(ledger, childId) {
    this.calls.push({ action: 'close', childId });
    const child = await ledger.getChild(childId);
    if (isTerminalStatus(child.status)) {
      return ledger.updateChild(childId, {
        cleanupState: child.cleanupState === 'closed' ? 'closed' : 'already_closed',
        closeRequested: false,
        processLive: null,
        cleanupVerified: false,
        terminalResult: child.terminalResult ?? child.status,
      }, 'child_already_closed');
    }
    return ledger.updateChild(childId, {
      status: 'closed',
      cleanupState: 'closed',
      closeRequested: true,
      processLive: null,
      cleanupVerified: false,
      terminalResult: child.terminalResult ?? 'closed',
    }, 'child_closed');
  }

  async interrupt(ledger, childId) {
    this.calls.push({ action: 'interrupt', childId });
    const child = await ledger.getChild(childId);
    return ledger.updateChild(childId, {
      status: isTerminalStatus(child.status) ? child.status : 'interrupted',
      cleanupState: 'interrupted',
      closeRequested: !isTerminalStatus(child.status),
      processLive: null,
      cleanupVerified: false,
      terminalResult: child.terminalResult ?? 'interrupted',
    }, 'child_interrupted');
  }
}
