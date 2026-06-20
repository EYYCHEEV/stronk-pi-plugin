import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isTerminalStatus } from '../ledger.mjs';

const REQUEST_EVENT = 'subagent:slash:request';
const STARTED_EVENT = 'subagent:slash:started';
const RESPONSE_EVENT = 'subagent:slash:response';
const UPDATE_EVENT = 'subagent:slash:update';
const CANCEL_EVENT = 'subagent:slash:cancel';
const ASYNC_STARTED_EVENT = 'subagent:async-started';
const DEFAULT_TIMEOUT_MS = 3600000;
const START_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 250;
const STALE_AFTER_MS = 5000;
const TERMINAL_RESULT_BYTES = 8192;
const SECRET_VALUE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9_]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

function bytes(text) {
  return Buffer.byteLength(String(text), 'utf8');
}

function sha256(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex');
}

function bounded(text, maxBytes = TERMINAL_RESULT_BYTES) {
  const value = String(text ?? '');
  if (bytes(value) <= maxBytes) return value;
  return `${Buffer.from(value).subarray(0, maxBytes).toString('utf8')}\n[truncated by Stronk Pi facade]`;
}

function redactSecrets(text) {
  let value = String(text ?? '');
  for (const pattern of SECRET_VALUE_PATTERNS) {
    value = value.replace(pattern, '<redacted>');
  }
  return value;
}

function terminalSummary(text) {
  return bounded(redactSecrets(text || 'subagent completed'));
}

function terminalMetadata(text, status) {
  const value = String(text ?? '');
  return {
    terminalResult: status,
    terminalResultSha256: sha256(value),
    terminalResultBytes: bytes(value),
  };
}

function errorMetadata(message, code) {
  const value = String(message ?? '');
  return {
    errorCode: code,
    errorSha256: sha256(value),
    errorBytes: bytes(value),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function resultText(response) {
  const result = response?.result ?? {};
  const content = textFromContent(result.content);
  if (content) return content;
  const details = result.details;
  const first = Array.isArray(details?.results) ? details.results[0] : undefined;
  return first?.finalOutput || first?.error || response?.errorText || '';
}

function isErrorResponse(response) {
  return response?.isError === true || response?.result?.isError === true;
}

function sessionFileFromResponse(response) {
  const details = response?.result?.details;
  const first = Array.isArray(details?.results) ? details.results[0] : undefined;
  return first?.sessionFile || details?.sessionFile || null;
}

function detailsMode(response) {
  return response?.result?.details?.mode ?? null;
}

function asyncIdFromResponse(response) {
  return response?.result?.details?.asyncId ?? null;
}

function asyncDirFromResponse(response) {
  return response?.result?.details?.asyncDir ?? null;
}

function eventBus(events) {
  if (!events || typeof events.emit !== 'function' || typeof events.on !== 'function') {
    throw new Error('stronk_subagent intercom adapter requires pi.events');
  }
  return events;
}

function sanitizeIntercomTargetPart(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

function resolveSubagentIntercomTarget(runId, agent, index = 0) {
  return `subagent-${sanitizeIntercomTargetPart(agent)}-${sanitizeIntercomTargetPart(runId)}-${index + 1}`;
}

function deriveResultPath(asyncDir, runId) {
  if (!asyncDir || !runId) return null;
  return join(dirname(dirname(asyncDir)), 'async-subagent-results', `${runId}.json`);
}

async function readJson(path) {
  if (!path) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readText(path) {
  if (!path) return '';
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function readStatus(child) {
  if (!child.upstreamAsyncDir) return null;
  return readJson(join(child.upstreamAsyncDir, 'status.json'));
}

async function readResult(child) {
  const resultPath = child.upstreamResultPath || deriveResultPath(child.upstreamAsyncDir, child.upstreamRunId);
  return readJson(resultPath);
}

function mapStatus(status, result, child) {
  const state = status?.state ?? result?.state;
  if (child?.status === 'closed') return 'closed';
  if (state === 'complete') return 'completed';
  if (state === 'failed') return 'failed';
  if (state === 'paused') return 'interrupted';
  if (state === 'queued' || state === 'running') return 'running';
  return child?.status ?? 'running';
}

function resultSummary(status, result, fallback = 'subagent completed') {
  const resultOutput = Array.isArray(result?.results)
    ? result.results
      .map((item) => item?.output || item?.finalOutput || item?.error || '')
      .filter(Boolean)
      .join('\n\n')
    : '';
  const stepError = Array.isArray(status?.steps)
    ? status.steps.find((step) => step?.error)?.error
    : undefined;
  return terminalSummary(result?.summary || resultOutput || status?.error || stepError || fallback);
}

function isPidLive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function timedOut(startedAt, timeoutMs) {
  return Date.now() - startedAt >= timeoutMs;
}

export class PiSubagentsBridgeAdapter {
  constructor({ events, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.events = eventBus(events);
    this.timeoutMs = timeoutMs;
  }

  async request(requestId, params, timeoutMs = this.timeoutMs) {
    const updates = [];
    const asyncStarts = [];
    return new Promise((resolve, reject) => {
      let done = false;
      let started = false;

      const finish = (next) => {
        if (done) return;
        done = true;
        clearTimeout(startTimer);
        clearTimeout(responseTimer);
        unsubStarted?.();
        unsubResponse?.();
        unsubUpdate?.();
        unsubAsyncStarted?.();
        next();
      };

      const onStarted = (data) => {
        if (!data || typeof data !== 'object' || data.requestId !== requestId) return;
        started = true;
        clearTimeout(startTimer);
      };
      const onResponse = (data) => {
        if (!data || typeof data !== 'object' || data.requestId !== requestId) return;
        finish(() => resolve({ requestId, response: data, started, updates, asyncStarts }));
      };
      const onUpdate = (data) => {
        if (!data || typeof data !== 'object' || data.requestId !== requestId) return;
        updates.push({
          currentTool: typeof data.currentTool === 'string' ? data.currentTool : undefined,
          toolCount: typeof data.toolCount === 'number' ? data.toolCount : undefined,
        });
      };
      const onAsyncStarted = (data) => {
        if (data && typeof data === 'object') asyncStarts.push(data);
      };

      const unsubStarted = this.events.on(STARTED_EVENT, onStarted);
      const unsubResponse = this.events.on(RESPONSE_EVENT, onResponse);
      const unsubUpdate = this.events.on(UPDATE_EVENT, onUpdate);
      const unsubAsyncStarted = this.events.on(ASYNC_STARTED_EVENT, onAsyncStarted);
      const startTimer = setTimeout(() => {
        finish(() => reject(new Error('stronk_subagent bridge did not start within 15s')));
      }, START_TIMEOUT_MS);
      const responseTimer = setTimeout(() => {
        this.events.emit(CANCEL_EVENT, { requestId });
        finish(() => reject(new Error('stronk_subagent bridge response timed out')));
      }, timeoutMs);

      this.events.emit(REQUEST_EVENT, { requestId, params });
    });
  }

  bridgeParams(normalized, ledger) {
    return {
      agent: normalized.role,
      task: normalized.task,
      cwd: normalized.cwd || ledger.cwd,
      context: 'fresh',
      async: true,
      progress: true,
      artifacts: true,
    };
  }

  async spawn(ledger, normalized) {
    const child = await ledger.createChild(normalized);
    const requestId = `sp-bridge-${randomUUID()}`;
    await ledger.updateChild(child.childId, { status: 'running', upstreamRequestId: requestId }, 'child_running');
    await ledger.appendEvent({ event: 'bridge_request', childId: child.childId, requestId, role: normalized.role });

    try {
      const bridge = await this.request(requestId, this.bridgeParams(normalized, ledger));
      const response = bridge.response;
      const failed = isErrorResponse(response);
      const asyncId = asyncIdFromResponse(response);
      const asyncDir = asyncDirFromResponse(response);
      if (!failed && asyncId && asyncDir) {
        const asyncStart = bridge.asyncStarts.find((item) => item?.id === asyncId || item?.asyncId === asyncId);
        const intercomTarget = resolveSubagentIntercomTarget(asyncId, normalized.role, 0);
        const runningChild = await ledger.updateChild(child.childId, {
          status: 'running',
          upstreamRunId: asyncId,
          upstreamAsyncDir: asyncDir,
          upstreamResultPath: deriveResultPath(asyncDir, asyncId),
          upstreamMode: detailsMode(response) || 'single',
          upstreamState: 'running',
          upstreamSessionId: sessionFileFromResponse(response),
          intercomTarget,
          pid: typeof asyncStart?.pid === 'number' ? asyncStart.pid : child.pid,
          processGroup: typeof asyncStart?.pid === 'number' ? asyncStart.pid : child.processGroup,
          cleanupState: 'none',
        }, 'child_running');
        await ledger.appendEvent({
          event: 'bridge_async_started',
          childId: child.childId,
          requestId,
          asyncId,
          mode: detailsMode(response),
          intercomTarget,
          pid: typeof asyncStart?.pid === 'number' ? asyncStart.pid : null,
        });
        return this.refreshChild(ledger, runningChild.childId);
      }

      const text = terminalSummary(resultText(response) || (failed ? 'subagent failed' : 'subagent completed'));
      const finalChild = await ledger.updateChild(child.childId, {
        status: failed ? 'failed' : 'completed',
        upstreamSessionId: sessionFileFromResponse(response),
        upstreamMode: detailsMode(response),
        ...terminalMetadata(text, failed ? 'failed' : 'completed'),
        cleanupState: 'none',
      }, failed ? 'child_failed' : 'child_completed');
      await ledger.appendEvent({
        event: 'bridge_response',
        childId: child.childId,
        requestId,
        isError: failed,
        mode: detailsMode(response),
        updateCount: bridge.updates.length,
        resultBytes: bytes(text),
      });
      return finalChild;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ledger.appendEvent({ event: 'bridge_error', childId: child.childId, requestId, ...errorMetadata(message, 'bridge_error') });
      return ledger.updateChild(child.childId, {
        status: 'failed',
        ...terminalMetadata(message, 'failed'),
        cleanupState: 'none',
      }, 'child_failed');
    }
  }

  async refreshChild(ledger, childId) {
    const child = await ledger.getChild(childId);
    if (isTerminalStatus(child.status)) return child;
    if (!child.upstreamRunId || !child.upstreamAsyncDir) return child;
    const [status, result] = await Promise.all([readStatus(child), readResult(child)]);
    let nextStatus = mapStatus(status, result, child);
    let staleMessage = null;

    if (nextStatus === 'running' && status?.pid && !isPidLive(status.pid)) {
      const lastUpdate = typeof status.lastUpdate === 'number' ? status.lastUpdate : status.startedAt;
      if (typeof lastUpdate === 'number' && Date.now() - lastUpdate > STALE_AFTER_MS && !result) {
        nextStatus = 'stale';
        staleMessage = `Async runner process ${status.pid} is no longer live and no result file was written.`;
      }
    }

    const terminal = isTerminalStatus(nextStatus);
    const patch = {
      status: nextStatus,
      upstreamState: status?.state ?? result?.state ?? child.upstreamState,
      upstreamMode: status?.mode ?? result?.mode ?? child.upstreamMode,
      upstreamSessionId: status?.sessionFile ?? result?.sessionFile ?? child.upstreamSessionId,
      upstreamResultPath: child.upstreamResultPath || deriveResultPath(child.upstreamAsyncDir, child.upstreamRunId),
      intercomTarget: nextStatus === 'running'
        ? (child.intercomTarget || resolveSubagentIntercomTarget(child.upstreamRunId, child.role, 0))
        : child.intercomTarget,
      pid: typeof status?.pid === 'number' ? status.pid : child.pid,
      processGroup: typeof status?.pid === 'number' ? status.pid : child.processGroup,
      cleanupState: child.cleanupState ?? 'none',
    };

    if (terminal) {
      const fallbackSummary = resultSummary(
        status,
        result,
        nextStatus === 'interrupted' ? 'interrupted' : nextStatus === 'failed' ? 'subagent failed' : 'subagent completed',
      );
      const outputFileSummary = fallbackSummary === 'subagent completed' || fallbackSummary === 'subagent failed' || fallbackSummary === 'interrupted'
        ? terminalSummary(await readText(status?.outputFile))
        : '';
      patch.terminalResult = nextStatus;
      Object.assign(patch, terminalMetadata(staleMessage || outputFileSummary || fallbackSummary, nextStatus));
      if (nextStatus === 'interrupted' && patch.cleanupState === 'none') patch.cleanupState = 'interrupted';
      if (nextStatus === 'stale') patch.cleanupState = 'stale';
    }

    const event = terminal ? `child_${nextStatus}` : 'child_running';
    const updated = await ledger.updateChild(childId, patch, event);
    await ledger.appendEvent({
      event: 'bridge_status_refreshed',
      childId,
      upstreamRunId: child.upstreamRunId,
      upstreamState: patch.upstreamState,
      status: nextStatus,
    });
    return updated;
  }

  async wait(ledger, childId, normalized = {}) {
    const timeoutMs = normalized.timeoutMs ?? this.timeoutMs;
    const startedAt = Date.now();
    let child = await this.refreshChild(ledger, childId);
    while (!isTerminalStatus(child.status) && !timedOut(startedAt, timeoutMs)) {
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, timeoutMs - (Date.now() - startedAt))));
      child = await this.refreshChild(ledger, childId);
    }
    return child;
  }

  async status(ledger, childId) {
    return this.refreshChild(ledger, childId);
  }

  async sendInput(ledger, childId, normalized) {
    const child = await ledger.getChild(childId);
    const requestId = `sp-resume-${randomUUID()}`;
    const bridge = await this.request(requestId, {
      action: 'resume',
      id: child.upstreamRunId,
      message: normalized.message,
      context: 'fresh',
      artifacts: true,
    }, normalized.timeoutMs ?? this.timeoutMs);
    const response = bridge.response;
    if (isErrorResponse(response)) {
      throw new Error(`stronk_subagent send_input failed: ${terminalSummary(resultText(response) || 'resume failed')}`);
    }
    await ledger.appendEvent({
      event: 'bridge_send_input',
      childId,
      requestId,
      upstreamRunId: child.upstreamRunId,
      resultBytes: bytes(resultText(response)),
    });
    return this.refreshChild(ledger, childId);
  }

  async revive(ledger, childId, normalized) {
    const previous = await ledger.getChild(childId);
    const revived = await ledger.createChild({
      role: previous.role,
      cwd: normalized.cwd || previous.cwd,
      task: normalized.task || `revive:${previous.childId}`,
      previousChildId: previous.childId,
    });
    const requestId = `sp-revive-${randomUUID()}`;
    await ledger.updateChild(revived.childId, { status: 'running', upstreamRequestId: requestId }, 'child_running');

    try {
      const bridge = await this.request(requestId, {
        action: 'resume',
        id: previous.upstreamRunId,
        message: normalized.task || `Continue from facade child ${previous.childId}.`,
        context: 'fresh',
        artifacts: true,
      }, normalized.timeoutMs ?? this.timeoutMs);
      const response = bridge.response;
      const asyncId = asyncIdFromResponse(response);
      const asyncDir = asyncDirFromResponse(response);
      if (isErrorResponse(response) || !asyncId || !asyncDir) {
        const text = terminalSummary(resultText(response) || 'revive failed');
        return ledger.updateChild(revived.childId, {
          status: 'failed',
          ...terminalMetadata(text, 'failed'),
          cleanupState: 'none',
        }, 'child_failed');
      }
      const asyncStart = bridge.asyncStarts.find((item) => item?.id === asyncId || item?.asyncId === asyncId);
      const intercomTarget = resolveSubagentIntercomTarget(asyncId, previous.role, 0);
      const running = await ledger.updateChild(revived.childId, {
        status: 'running',
        upstreamRunId: asyncId,
        upstreamAsyncDir: asyncDir,
        upstreamResultPath: deriveResultPath(asyncDir, asyncId),
        upstreamMode: detailsMode(response) || 'single',
        upstreamState: 'running',
        intercomTarget,
        pid: typeof asyncStart?.pid === 'number' ? asyncStart.pid : null,
        processGroup: typeof asyncStart?.pid === 'number' ? asyncStart.pid : null,
        cleanupState: 'none',
      }, 'child_running');
      await ledger.appendEvent({
        event: 'bridge_revive_started',
        childId: running.childId,
        previousChildId: previous.childId,
        requestId,
        asyncId,
        intercomTarget,
      });
      return this.refreshChild(ledger, running.childId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ledger.appendEvent({ event: 'bridge_revive_error', childId: revived.childId, requestId, ...errorMetadata(message, 'bridge_revive_error') });
      return ledger.updateChild(revived.childId, {
        status: 'failed',
        ...terminalMetadata(message, 'failed'),
        cleanupState: 'none',
      }, 'child_failed');
    }
  }

  async requestInterrupt(child, timeoutMs) {
    if (child.upstreamRunId) {
      const requestId = `sp-interrupt-${randomUUID()}`;
      const bridge = await this.request(requestId, {
        action: 'interrupt',
        id: child.upstreamRunId,
        context: 'fresh',
      }, timeoutMs);
      if (isErrorResponse(bridge.response)) {
        throw new Error(terminalSummary(resultText(bridge.response) || 'interrupt failed'));
      }
      return requestId;
    }
    if (child.upstreamRequestId) {
      this.events.emit(CANCEL_EVENT, { requestId: child.upstreamRequestId });
      return child.upstreamRequestId;
    }
    return null;
  }

  async close(ledger, childId, normalized = {}) {
    let child = await this.refreshChild(ledger, childId);
    if (isTerminalStatus(child.status)) {
      return ledger.updateChild(childId, {
        cleanupState: child.cleanupState === 'closed' ? 'closed' : 'already_closed',
      }, 'child_already_closed');
    }
    try {
      const requestId = await this.requestInterrupt(child, normalized.timeoutMs ?? this.timeoutMs);
      await ledger.appendEvent({ event: 'bridge_close_requested', childId, requestId, upstreamRunId: child.upstreamRunId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/No interrupt-capable run found|already (?:closed|complete|completed|terminal)|not interrupt-capable/i.test(message)) {
        child = await this.refreshChild(ledger, childId);
        if (isTerminalStatus(child.status)) {
          await ledger.appendEvent({
            event: 'bridge_close_already_terminal',
            childId,
            upstreamRunId: child.upstreamRunId,
            ...errorMetadata(message, 'bridge_close_already_terminal'),
          });
          return ledger.updateChild(childId, { cleanupState: 'already_closed' }, 'child_already_closed');
        }
      }
      await ledger.appendEvent({ event: 'bridge_close_error', childId, upstreamRunId: child.upstreamRunId, ...errorMetadata(message, 'bridge_close_error') });
      await ledger.updateChild(childId, { cleanupState: 'close_failed' }, 'child_cleanup_failed');
      throw new Error(`stronk_subagent close failed: ${terminalSummary(message)}`);
    }
    return ledger.updateChild(childId, {
      status: 'closed',
      cleanupState: 'closed',
      ...terminalMetadata('closed', 'closed'),
    }, 'child_closed');
  }

  async interrupt(ledger, childId, normalized = {}) {
    const child = await ledger.getChild(childId);
    if (isTerminalStatus(child.status)) return child;
    try {
      const requestId = await this.requestInterrupt(child, normalized.timeoutMs ?? this.timeoutMs);
      await ledger.appendEvent({ event: 'bridge_interrupt_requested', childId, requestId, upstreamRunId: child.upstreamRunId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ledger.appendEvent({ event: 'bridge_interrupt_error', childId, upstreamRunId: child.upstreamRunId, ...errorMetadata(message, 'bridge_interrupt_error') });
      await ledger.updateChild(childId, { cleanupState: 'interrupt_failed' }, 'child_cleanup_failed');
      throw new Error(`stronk_subagent interrupt failed: ${terminalSummary(message)}`);
    }
    return ledger.updateChild(childId, {
      status: 'interrupted',
      cleanupState: 'interrupted',
      ...terminalMetadata('interrupted', 'interrupted'),
    }, 'child_interrupted');
  }
}
