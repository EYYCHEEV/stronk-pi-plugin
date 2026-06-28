import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { boundedUtf8, isTerminalStatus, sanitizePublicOutput } from '../ledger.mjs';

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
const OUTPUT_FILE_READ_LIMIT_BYTES = 1024 * 1024;
const TRUNCATION_MARKER = '\n[truncated by Stronk Pi facade]';
const CAPACITY_FAILURE_REASON = 'provider_capacity_retryable';
const CAPACITY_FAILURE_CLASS = 'provider_capacity';
const CAPACITY_RECOMMENDED_ACTION = 'retry_capacity_children_next_batch';
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_TEXT_BYTES = 32768;
const CAPACITY_MESSAGE_PATTERN = /(?:\b(?:http\s*)?429\b|too many requests|rate[-_\s]?limit(?:ed| reached| exceeded)?|concurr(?:ent|ency).{0,64}(?:limit|max|slot|reached|exceeded|in use)|(?:limit|max).{0,64}concurr|slots?\s+in\s+use|no\s+slots?|capacity\s+(?:limit|reached|exceeded|unavailable|full)|temporarily\s+overloaded|overloaded)/i;
const CAPACITY_CODE_PATTERN = /(?:429|rate[-_]?limit|too[-_]?many[-_]?requests|concurr(?:ent|ency)|capacity|overloaded|no[-_]?slots?)/i;

function bytes(text) {
  return Buffer.byteLength(String(text), 'utf8');
}

function sha256(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex');
}

function terminalSummary(text) {
  return sanitizePublicOutput(text || 'subagent completed');
}

function terminalMetadata(text, status) {
  const redacted = sanitizePublicOutput(text || status || '');
  const preview = boundedUtf8(redacted, TERMINAL_RESULT_BYTES, TRUNCATION_MARKER);
  return {
    terminalResult: status,
    terminalOutputPreview: preview.text,
    terminalResultSha256: sha256(preview.text),
    terminalResultBytes: bytes(preview.text),
    childOutputPreview: preview.text,
    childOutputTruncated: preview.truncated,
    childOutputBytes: bytes(preview.text),
    childOutputHash: sha256(preview.text),
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

function isLiveInputDelivery(response) {
  const text = resultText(response);
  return /Delivered follow-up to live async child/i.test(text);
}

function isErrorResponse(response) {
  return response?.isError === true || response?.result?.isError === true;
}

function boundedEvidenceText(text) {
  return boundedUtf8(String(text ?? ''), MAX_EVIDENCE_TEXT_BYTES).text;
}

function evidenceValues(value, path = '', depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined || depth > 6) return [];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [{ path, value }];
  }
  if (typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => evidenceValues(item, `${path}.${index}`, depth + 1, seen));
  }
  return Object.entries(value).flatMap(([key, item]) => {
    const nextPath = path ? `${path}.${key}` : key;
    return evidenceValues(item, nextPath, depth + 1, seen);
  });
}

function finiteNonNegativeNumber(value) {
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function boundedCount(value) {
  const number = finiteNonNegativeNumber(value);
  if (number === null || number > 1000000) return null;
  return Math.trunc(number);
}

function parseRetryAfterMs(path, value) {
  const key = String(path ?? '').toLowerCase();
  if (!/(retry|reset).{0,20}(after|delay|in|ms|millis|milliseconds)|retry-after/.test(key)) return null;
  if (typeof value === 'number') {
    const ms = /(?:ms|milli)/.test(key) ? value : value * 1000;
    return normalizeRetryAfterMs(ms);
  }
  const text = String(value ?? '').trim();
  if (!text) return null;
  const duration = text.match(/(\d+(?:\.\d+)?)\s*(ms|millisecond|milliseconds|s|sec|secs|second|seconds|m|min|mins|minute|minutes)?\b/i);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = (duration[2] || 's').toLowerCase();
    const multiplier = unit.startsWith('ms') || unit.startsWith('milli')
      ? 1
      : unit === 'm' || unit.startsWith('min')
        ? 60000
        : 1000;
    return normalizeRetryAfterMs(amount * multiplier);
  }
  const timestamp = Date.parse(text);
  if (Number.isFinite(timestamp)) {
    return normalizeRetryAfterMs(timestamp - Date.now());
  }
  return null;
}

function parseRetryAfterFromText(text) {
  const match = String(text ?? '').match(/retry[-_\s]?after\s*:?\s*(\d+(?:\.\d+)?)\s*(ms|millisecond|milliseconds|s|sec|secs|second|seconds|m|min|mins|minute|minutes)?/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  const multiplier = unit.startsWith('ms') || unit.startsWith('milli')
    ? 1
    : unit === 'm' || unit.startsWith('min')
      ? 60000
      : 1000;
  return normalizeRetryAfterMs(amount * multiplier);
}

function normalizeRetryAfterMs(value) {
  const number = finiteNonNegativeNumber(value);
  if (number === null) return null;
  return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, Math.ceil(number)));
}

function concurrencyFromEntries(entries) {
  let concurrencyInUse = null;
  let concurrencyLimit = null;
  for (const { path, value } of entries) {
    const key = String(path ?? '').toLowerCase();
    const count = boundedCount(value);
    if (count === null) continue;
    const capacityKey = /(concurr|slot|capacity|rate.?limit)/.test(key);
    if (!capacityKey) continue;
    if (/(in.?use|used|active|current|running)/.test(key)) concurrencyInUse ??= count;
    if (/(limit|max|total|cap)/.test(key)) concurrencyLimit ??= count;
  }
  return { concurrencyInUse, concurrencyLimit };
}

function concurrencyFromText(text) {
  const value = String(text ?? '');
  const slash = value.match(/\b(\d{1,6})\s*\/\s*(\d{1,6})\s*(?:slots?|concurrent|concurrency|requests?)\b/i);
  if (slash) {
    return {
      concurrencyInUse: boundedCount(slash[1]),
      concurrencyLimit: boundedCount(slash[2]),
    };
  }
  const of = value.match(/\b(\d{1,6})\s+of\s+(\d{1,6})\s+(?:slots?|concurrent|concurrency|requests?)\b/i);
  if (of) {
    return {
      concurrencyInUse: boundedCount(of[1]),
      concurrencyLimit: boundedCount(of[2]),
    };
  }
  return { concurrencyInUse: null, concurrencyLimit: null };
}

function hasCapacityCode(entries) {
  return entries.some(({ path, value }) => {
    const key = String(path ?? '').toLowerCase();
    if (/(status|statuscode|http|code|errorcode|error_code)/.test(key) && String(value) === '429') return true;
    if (/(code|error|reason|type|status)/.test(key) && CAPACITY_CODE_PATTERN.test(String(value))) return true;
    return false;
  });
}

function providerCapacityMetadata({ response, status, result, error, text } = {}) {
  const sources = [response, status, result, error, text].filter((item) => item !== null && item !== undefined);
  const entries = sources.flatMap((source) => evidenceValues(source));
  const combinedText = boundedEvidenceText(entries
    .map(({ path, value }) => `${path}:${String(value)}`)
    .join('\n'));
  const codeMatched = hasCapacityCode(entries);
  const textMatched = CAPACITY_MESSAGE_PATTERN.test(combinedText);
  if (!codeMatched && !textMatched) return null;

  const retryAfterFromEntry = entries
    .map(({ path, value }) => parseRetryAfterMs(path, value))
    .find((value) => value !== null);
  const retryAfterMs = retryAfterFromEntry ?? parseRetryAfterFromText(combinedText);
  const structuredConcurrency = concurrencyFromEntries(entries);
  const textConcurrency = concurrencyFromText(combinedText);
  return {
    failureReason: CAPACITY_FAILURE_REASON,
    failureClass: CAPACITY_FAILURE_CLASS,
    retryable: true,
    retryReason: CAPACITY_FAILURE_CLASS,
    retryAfterMs,
    capacityBlocked: true,
    concurrencyInUse: structuredConcurrency.concurrencyInUse ?? textConcurrency.concurrencyInUse,
    concurrencyLimit: structuredConcurrency.concurrencyLimit ?? textConcurrency.concurrencyLimit,
    outputUsableForSynthesis: false,
    recommendedNextAction: CAPACITY_RECOMMENDED_ACTION,
  };
}

function capacityFailurePatch(capacity) {
  return {
    terminalResult: 'failed',
    terminalOutputPreview: null,
    terminalResultSha256: null,
    terminalResultBytes: 0,
    childOutputPreview: null,
    childOutputTruncated: false,
    childOutputBytes: 0,
    childOutputHash: null,
    childOutputHandle: null,
    childOutputFullBytes: null,
    childOutputFullChars: null,
    childOutputFullHash: null,
    childOutputArtifactTruncated: false,
    errorSummary: null,
    ...capacity,
  };
}

function clearCapacityPatch() {
  return {
    failureClass: null,
    retryable: false,
    retryReason: null,
    retryAfterMs: null,
    capacityBlocked: false,
    concurrencyInUse: null,
    concurrencyLimit: null,
    outputUsableForSynthesis: null,
  };
}

function capacityEventMetadata(capacity) {
  return {
    failureClass: capacity.failureClass,
    retryable: Boolean(capacity.retryable),
    retryAfterMs: capacity.retryAfterMs ?? null,
    concurrencyInUse: capacity.concurrencyInUse ?? null,
    concurrencyLimit: capacity.concurrencyLimit ?? null,
  };
}

function sessionFileFromResponse(response) {
  const details = response?.result?.details;
  const first = Array.isArray(details?.results) ? details.results[0] : undefined;
  return first?.sessionFile || details?.sessionFile || null;
}

function resultFromResponse(response) {
  const result = response?.result ?? {};
  const details = result?.details ?? {};
  return {
    ...details,
    state: details.state ?? result.state,
    success: details.success ?? result.success,
    exitCode: details.exitCode ?? result.exitCode,
    error: details.error ?? result.error,
    summary: details.summary ?? result.summary,
    results: Array.isArray(details.results) ? details.results : result.results,
  };
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

function deriveConsumedResultPath(resultPath) {
  if (!resultPath) return null;
  const dir = dirname(resultPath);
  return join(dirname(dir), `${basename(dir)}-consumed`, basename(resultPath));
}

function parentModelHint(runtime) {
  const model = runtime?.parentModel;
  return typeof model === 'string' && model.trim() ? model.trim() : undefined;
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

async function readTrustedStatusOutput(child, status) {
  if (!status?.outputFile || !child?.upstreamAsyncDir) return '';
  try {
    const target = await realpath(status.outputFile);
    const derivedResultPath = deriveResultPath(child.upstreamAsyncDir, child.upstreamRunId);
    const trustedRoots = [
      child.upstreamAsyncDir,
      child.upstreamResultPath ? dirname(child.upstreamResultPath) : null,
      derivedResultPath ? dirname(derivedResultPath) : null,
    ].filter(Boolean).map((item) => resolve(item));
    if (!trustedRoots.some((root) => target.startsWith(`${root}/`))) return '';
    const info = await stat(target);
    if (!info.isFile() || info.size > OUTPUT_FILE_READ_LIMIT_BYTES) return '';
    return readText(target);
  } catch {
    return '';
  }
}

async function readStatus(child) {
  if (!child.upstreamAsyncDir) return null;
  return readJson(join(child.upstreamAsyncDir, 'status.json'));
}

async function readResult(child) {
  const resultPath = child.upstreamResultPath || deriveResultPath(child.upstreamAsyncDir, child.upstreamRunId);
  if (!resultPath) return null;
  return await readJson(resultPath) ?? readJson(deriveConsumedResultPath(resultPath));
}

function hasPositiveResultOutput(result) {
  if (typeof result?.summary === 'string' && result.summary.trim()) return true;
  if (!Array.isArray(result?.results)) return false;
  return result.results.some((item) => (
    typeof item?.output === 'string' && item.output.trim()
  ) || (
    typeof item?.finalOutput === 'string' && item.finalOutput.trim()
  ));
}

function outputStoreOptions(kind) {
  return {
    outputArtifactKind: kind,
    outputUsableForSynthesis: kind === 'findings',
  };
}

function mapStatus(status, result, child) {
  const state = status?.state ?? result?.state;
  if (child?.status === 'closed') return 'closed';
  const reason = failureReason(status, result);
  if (state === 'complete' && reason === 'upstream_step_failed' && result?.success === true && hasPositiveResultOutput(result)) {
    return 'completed';
  }
  if (reason) return 'failed';
  if (state === 'complete') return 'completed';
  if (state === 'failed') return 'failed';
  if (state === 'paused') return 'interrupted';
  if (state === 'queued' || state === 'running') return 'running';
  return child?.status ?? 'running';
}

function failedResultRow(result) {
  if (!Array.isArray(result?.results)) return null;
  return result.results.find((item) => (
    item?.success === false
    || item?.status === 'failed'
    || item?.state === 'failed'
    || (typeof item?.exitCode === 'number' && item.exitCode !== 0)
    || Boolean(item?.error)
  )) ?? null;
}

function failedStep(status) {
  if (!Array.isArray(status?.steps)) return null;
  return status.steps.find((step) => (
    step?.status === 'failed'
    || step?.state === 'failed'
    || (typeof step?.exitCode === 'number' && step.exitCode !== 0)
    || Boolean(step?.error)
  )) ?? null;
}

function failureReason(status, result) {
  if (result?.success === false) return 'upstream_success_false';
  if (typeof result?.exitCode === 'number' && result.exitCode !== 0) return 'upstream_exit_code';
  if (result?.error) return 'upstream_error';
  if (failedResultRow(result)) return 'upstream_result_failed';
  if (status?.error) return 'upstream_status_error';
  if (failedStep(status)) return 'upstream_step_failed';
  return null;
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

function errorSummary(text) {
  return boundedUtf8(sanitizePublicOutput(text || 'subagent failed'), 1024, TRUNCATION_MARKER).text;
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

function processLiveFromPid(pid) {
  if (typeof pid !== 'number' || pid <= 0) return null;
  return isPidLive(pid);
}

function cleanupVerifiedFromProcess(processLive) {
  return processLive === false;
}

function timedOut(startedAt, timeoutMs) {
  return Date.now() - startedAt >= timeoutMs;
}

export class PiSubagentsBridgeAdapter {
  constructor({ events, timeoutMs = DEFAULT_TIMEOUT_MS, startTimeoutMs = START_TIMEOUT_MS } = {}) {
    this.events = eventBus(events);
    this.timeoutMs = timeoutMs;
    this.startTimeoutMs = startTimeoutMs;
    this.retryPayloads = new Map();
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
        finish(() => reject(new Error('stronk_subagent bridge did not start within timeout')));
      }, this.startTimeoutMs);
      const responseTimer = setTimeout(() => {
        this.events.emit(CANCEL_EVENT, { requestId });
        finish(() => reject(new Error('stronk_subagent bridge response timed out')));
      }, timeoutMs);

      this.events.emit(REQUEST_EVENT, { requestId, params });
    });
  }

  bridgeParams(normalized, ledger, runtime = {}, pinnedModel = null) {
    const model = pinnedModel || parentModelHint(runtime);
    return {
      agent: normalized.role,
      task: normalized.task,
      cwd: ledger.cwd,
      context: 'fresh',
      async: true,
      progress: true,
      artifacts: true,
      ...(model ? { model } : {}),
    };
  }

  rememberRetryPayload(childId, normalized, runtime = {}) {
    this.retryPayloads.set(childId, {
      normalized: {
        role: normalized.role,
        roleRequested: normalized.roleRequested ?? normalized.role,
        roleUsed: normalized.roleUsed ?? normalized.role,
        aliasResolved: Boolean(normalized.aliasResolved),
        aliasMessage: normalized.aliasMessage ?? null,
        task: normalized.task,
        timeoutMs: normalized.timeoutMs,
      },
      model: parentModelHint(runtime) ?? null,
      createdAt: Date.now(),
    });
  }

  async spawn(ledger, normalized, runtime = {}) {
    const child = await ledger.createChild(normalized);
    this.rememberRetryPayload(child.childId, normalized, runtime);
    const requestId = `sp-bridge-${randomUUID()}`;
    const startedAt = Date.now();
    await ledger.updateChild(child.childId, {
      status: 'running',
      upstreamRequestId: requestId,
      timedOut: false,
      elapsedMs: null,
      timeoutMs: normalized.timeoutMs ?? this.timeoutMs,
      recommendedNextAction: 'wait_again',
    }, 'child_running');
    await ledger.appendEvent({ event: 'bridge_request', childId: child.childId, requestId, role: normalized.role });

    try {
      const bridge = await this.request(requestId, this.bridgeParams(normalized, ledger, runtime), normalized.timeoutMs);
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
          processLive: processLiveFromPid(typeof asyncStart?.pid === 'number' ? asyncStart.pid : child.pid),
          cleanupVerified: false,
          timedOut: false,
          recommendedNextAction: 'wait_again',
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

      const immediateResult = resultFromResponse(response);
      const immediateFailureReason = failed ? 'upstream_error_response' : failureReason(null, immediateResult);
      const immediateFailed = failed || Boolean(immediateFailureReason);
      const capacity = immediateFailed
        ? providerCapacityMetadata({ response, result: immediateResult, text: resultText(response) })
        : null;
      if (capacity) {
        const finalChild = await ledger.updateChild(child.childId, {
          status: 'failed',
          upstreamSessionId: sessionFileFromResponse(response),
          upstreamMode: detailsMode(response),
          ...capacityFailurePatch(capacity),
          timedOut: false,
          elapsedMs: Date.now() - startedAt,
          timeoutMs: normalized.timeoutMs ?? this.timeoutMs,
          cleanupState: 'none',
        }, 'child_failed');
        await ledger.appendEvent({
          event: 'bridge_capacity_blocked',
          childId: child.childId,
          requestId,
          mode: detailsMode(response),
          updateCount: bridge.updates.length,
          ...capacityEventMetadata(capacity),
        });
        return finalChild;
      }
      const responseText = resultText(response);
      const text = resultSummary(null, immediateResult, responseText || (immediateFailed ? 'subagent failed' : 'subagent completed'));
      const artifactKind = immediateFailed
        ? 'failure-summary'
        : hasPositiveResultOutput(immediateResult) || (responseText && text !== 'subagent completed')
          ? 'findings'
          : 'terminal-summary';
      const finalChild = await ledger.updateChild(child.childId, {
        status: immediateFailed ? 'failed' : 'completed',
        upstreamSessionId: sessionFileFromResponse(response),
        upstreamMode: detailsMode(response),
        ...terminalMetadata(text, immediateFailed ? 'failed' : 'completed'),
        failureReason: immediateFailed ? immediateFailureReason : null,
        ...clearCapacityPatch(),
        errorSummary: immediateFailed ? errorSummary(text) : null,
        timedOut: false,
        elapsedMs: Date.now() - startedAt,
        timeoutMs: normalized.timeoutMs ?? this.timeoutMs,
        recommendedNextAction: immediateFailed ? 'inspect_error' : 'close_child',
        cleanupState: 'none',
      }, immediateFailed ? 'child_failed' : 'child_completed');
      const outputChild = await ledger.storeChildOutput(finalChild.childId, text, outputStoreOptions(artifactKind));
      await ledger.appendEvent({
        event: 'bridge_response',
        childId: child.childId,
        requestId,
        isError: immediateFailed,
        mode: detailsMode(response),
        updateCount: bridge.updates.length,
        resultBytes: bytes(text),
      });
      return outputChild;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const startTimeout = /did not start/i.test(message);
      const responseTimeout = /response timed out/i.test(message);
      const timeoutMs = startTimeout ? this.startTimeoutMs : (normalized.timeoutMs ?? this.timeoutMs);
      const reason = startTimeout ? 'bridge_start_timeout' : responseTimeout ? 'bridge_response_timeout' : 'bridge_error';
      await ledger.appendEvent({ event: 'bridge_error', childId: child.childId, requestId, ...errorMetadata(message, 'bridge_error') });
      const capacity = providerCapacityMetadata({ error: message, text: message });
      if (capacity) {
        return ledger.updateChild(child.childId, {
          status: 'failed',
          ...capacityFailurePatch(capacity),
          timedOut: false,
          elapsedMs: Date.now() - startedAt,
          timeoutMs,
          cleanupState: 'none',
        }, 'child_failed');
      }
      const failedChild = await ledger.updateChild(child.childId, {
        status: 'failed',
        ...terminalMetadata(message, 'failed'),
        failureReason: reason,
        errorSummary: errorSummary(message),
        timedOut: startTimeout || responseTimeout,
        elapsedMs: Date.now() - startedAt,
        timeoutMs,
        recommendedNextAction: startTimeout ? 'run_diagnose' : 'inspect_error',
        cleanupState: 'none',
      }, 'child_failed');
      return ledger.storeChildOutput(failedChild.childId, message, outputStoreOptions('failure-summary'));
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
    const processLive = processLiveFromPid(typeof status?.pid === 'number' ? status.pid : child.pid);
    const reason = failureReason(status, result);
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
      processLive,
      cleanupVerified: cleanupVerifiedFromProcess(processLive) && (child.closeRequested || child.cleanupState === 'closed'),
      recommendedNextAction: nextStatus === 'running' ? 'wait_again' : child.recommendedNextAction,
    };

    let terminalTextForArtifact = null;
    if (terminal) {
      const capacity = nextStatus === 'failed'
        ? providerCapacityMetadata({ status, result })
        : null;
      if (capacity) {
        Object.assign(patch, {
          terminalResult: nextStatus,
          ...capacityFailurePatch(capacity),
          timedOut: false,
        });
        terminalTextForArtifact = null;
      } else {
        const fallbackSummary = resultSummary(
          status,
          result,
          nextStatus === 'interrupted' ? 'interrupted' : nextStatus === 'failed' ? 'subagent failed' : 'subagent completed',
        );
        const statusOutput = fallbackSummary === 'subagent completed' || fallbackSummary === 'subagent failed' || fallbackSummary === 'interrupted'
          ? await readTrustedStatusOutput(child, status)
          : '';
        const outputFileSummary = statusOutput ? terminalSummary(statusOutput) : '';
        const terminalText = staleMessage || outputFileSummary || fallbackSummary;
        terminalTextForArtifact = terminalText;
        patch.outputArtifactKind = nextStatus === 'completed' && (hasPositiveResultOutput(result) || Boolean(outputFileSummary))
          ? 'findings'
          : nextStatus === 'failed'
            ? 'failure-summary'
            : 'terminal-summary';
        patch.outputUsableForSynthesis = patch.outputArtifactKind === 'findings';
        patch.terminalResult = nextStatus;
        Object.assign(patch, terminalMetadata(terminalText, nextStatus));
        patch.failureReason = nextStatus === 'failed' ? (reason || 'upstream_failed') : null;
        patch.errorSummary = nextStatus === 'failed' ? errorSummary(terminalText) : null;
        patch.timedOut = false;
        patch.recommendedNextAction = nextStatus === 'completed'
          ? 'close_child'
          : nextStatus === 'failed'
            ? 'inspect_error'
            : nextStatus === 'stale'
              ? 'run_diagnose'
              : 'inspect_error';
        Object.assign(patch, clearCapacityPatch());
      }
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
    if (terminal && terminalTextForArtifact !== null) {
      return ledger.storeChildOutput(updated.childId, terminalTextForArtifact, outputStoreOptions(updated.outputArtifactKind || patch.outputArtifactKind));
    }
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
    const elapsedMs = Date.now() - startedAt;
    if (!isTerminalStatus(child.status) && elapsedMs >= timeoutMs) {
      return ledger.updateChild(childId, {
        timedOut: true,
        elapsedMs,
        timeoutMs,
        recommendedNextAction: 'wait_again',
      }, 'child_wait_timeout');
    }
    return child;
  }

  async status(ledger, childId) {
    return this.refreshChild(ledger, childId);
  }

  async startInputContinuation(ledger, child, normalized, runtime = {}) {
    const requestId = `sp-input-${randomUUID()}`;
    await ledger.updateChild(child.childId, {
      status: 'running',
      upstreamRequestId: requestId,
      upstreamRunId: null,
      upstreamAsyncDir: null,
      upstreamResultPath: null,
      upstreamMode: null,
      upstreamState: null,
      intercomTarget: null,
      pid: null,
      processGroup: null,
      terminalResult: null,
      terminalOutputPreview: null,
      terminalResultSha256: null,
      terminalResultBytes: 0,
      childOutputPreview: null,
      childOutputTruncated: false,
      childOutputBytes: 0,
      childOutputHash: null,
      failureReason: null,
      ...clearCapacityPatch(),
      errorSummary: null,
      timedOut: false,
      elapsedMs: null,
      timeoutMs: normalized.timeoutMs ?? this.timeoutMs,
      recommendedNextAction: 'wait_again',
      cleanupState: 'none',
      processLive: null,
      cleanupVerified: false,
      inputAccepted: true,
      inputLinkedChildId: child.childId,
    }, 'child_input_continuation_starting');

    const bridge = await this.request(requestId, this.bridgeParams({
      role: child.role,
      task: normalized.message,
      timeoutMs: normalized.timeoutMs,
    }, ledger, runtime), normalized.timeoutMs ?? this.timeoutMs);
    const response = bridge.response;
    const failed = isErrorResponse(response);
    const asyncId = asyncIdFromResponse(response);
    const asyncDir = asyncDirFromResponse(response);
    if (failed || !asyncId || !asyncDir) {
      const text = terminalSummary(resultText(response) || 'send_input continuation failed');
      throw new Error(`stronk_subagent send_input failed: ${text}`);
    }

    const asyncStart = bridge.asyncStarts.find((item) => item?.id === asyncId || item?.asyncId === asyncId);
    const intercomTarget = resolveSubagentIntercomTarget(asyncId, child.role, 0);
    const continued = await ledger.updateChild(child.childId, {
      status: 'running',
      upstreamRunId: asyncId,
      upstreamAsyncDir: asyncDir,
      upstreamResultPath: deriveResultPath(asyncDir, asyncId),
      upstreamMode: detailsMode(response) || 'single',
      upstreamState: 'running',
      upstreamSessionId: sessionFileFromResponse(response),
      intercomTarget,
      pid: typeof asyncStart?.pid === 'number' ? asyncStart.pid : null,
      processGroup: typeof asyncStart?.pid === 'number' ? asyncStart.pid : null,
      processLive: processLiveFromPid(typeof asyncStart?.pid === 'number' ? asyncStart.pid : null),
      cleanupState: 'none',
      cleanupVerified: false,
      recommendedNextAction: 'wait_again',
    }, 'child_input_continuation_running');
    await ledger.appendEvent({
      event: 'bridge_send_input_continuation_started',
      childId: child.childId,
      requestId,
      previousUpstreamRunId: child.upstreamRunId,
      asyncId,
      intercomTarget,
      pid: typeof asyncStart?.pid === 'number' ? asyncStart.pid : null,
    });
    return this.refreshChild(ledger, continued.childId);
  }

  async sendInput(ledger, childId, normalized, runtime = {}) {
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
    if (!isLiveInputDelivery(response)) {
      throw new Error(`stronk_subagent send_input failed: upstream did not deliver follow-up to live child: ${terminalSummary(resultText(response) || 'resume did not deliver live follow-up')}`);
    }
    try {
      await this.request(`sp-input-interrupt-${randomUUID()}`, {
        action: 'interrupt',
        id: child.upstreamRunId,
      }, Math.min(normalized.timeoutMs ?? this.timeoutMs, 5000));
    } catch (error) {
      await ledger.appendEvent({
        event: 'bridge_send_input_interrupt_failed',
        childId,
        upstreamRunId: child.upstreamRunId,
        ...errorMetadata(error instanceof Error ? error.message : String(error), 'interrupt_failed'),
      });
    }
    await ledger.appendEvent({
      event: 'bridge_send_input',
      childId,
      requestId,
      upstreamRunId: child.upstreamRunId,
      resultBytes: bytes(resultText(response)),
    });
    return this.startInputContinuation(ledger, child, normalized, runtime);
  }

  async retryCapacityChild(ledger, previous, normalized, runtime = {}) {
    const payload = this.retryPayloads.get(previous.childId);
    const task = payload?.normalized?.task || normalized.task;
    if (!task) {
      throw new Error('stronk_subagent revive denied: capacity retry payload unavailable; provide task to retry');
    }
    const retryNormalized = {
      role: previous.role,
      roleRequested: previous.roleRequested ?? previous.role,
      roleUsed: previous.roleUsed ?? previous.role,
      aliasResolved: Boolean(previous.aliasResolved),
      aliasMessage: previous.aliasMessage ?? null,
      task,
      timeoutMs: normalized.timeoutMs ?? payload?.normalized?.timeoutMs,
      previousChildId: previous.childId,
    };
    const model = payload?.model || parentModelHint(runtime) || null;
    await ledger.appendEvent({
      event: 'bridge_capacity_retry',
      previousChildId: previous.childId,
      retryReason: CAPACITY_FAILURE_CLASS,
      modelPinned: Boolean(model),
    });
    return this.spawn(ledger, retryNormalized, model ? { ...runtime, parentModel: model } : runtime);
  }

  async revive(ledger, childId, normalized, runtime = {}) {
    const previous = await ledger.getChild(childId);
    if (previous.failureClass === CAPACITY_FAILURE_CLASS || previous.retryReason === CAPACITY_FAILURE_CLASS) {
      return this.retryCapacityChild(ledger, previous, normalized, runtime);
    }
    const revived = await ledger.createChild({
      role: previous.role,
      roleRequested: previous.roleRequested ?? previous.role,
      roleUsed: previous.roleUsed ?? previous.role,
      aliasResolved: Boolean(previous.aliasResolved),
      aliasMessage: previous.aliasMessage ?? null,
      cwd: previous.cwd,
      task: normalized.task || `revive:${previous.childId}`,
      previousChildId: previous.childId,
    });
    const requestId = `sp-revive-${randomUUID()}`;
    await ledger.updateChild(revived.childId, { status: 'running', upstreamRequestId: requestId }, 'child_running');

    try {
      const model = parentModelHint(runtime);
      const bridge = await this.request(requestId, {
        action: 'resume',
        id: previous.upstreamRunId,
        message: normalized.task || `Continue from facade child ${previous.childId}.`,
        context: 'fresh',
        artifacts: true,
        ...(model ? { model } : {}),
      }, normalized.timeoutMs ?? this.timeoutMs);
      const response = bridge.response;
      const asyncId = asyncIdFromResponse(response);
      const asyncDir = asyncDirFromResponse(response);
      if (isErrorResponse(response) || !asyncId || !asyncDir) {
        const capacity = providerCapacityMetadata({ response, text: resultText(response) });
        if (capacity) {
          return ledger.updateChild(revived.childId, {
            status: 'failed',
            ...capacityFailurePatch(capacity),
            recommendedNextAction: CAPACITY_RECOMMENDED_ACTION,
            cleanupState: 'none',
          }, 'child_failed');
        }
        const text = terminalSummary(resultText(response) || 'revive failed');
        const failedChild = await ledger.updateChild(revived.childId, {
          status: 'failed',
          ...terminalMetadata(text, 'failed'),
          failureReason: 'upstream_error_response',
          ...clearCapacityPatch(),
          errorSummary: errorSummary(text),
          recommendedNextAction: 'inspect_error',
          cleanupState: 'none',
        }, 'child_failed');
        return ledger.storeChildOutput(failedChild.childId, text, outputStoreOptions('failure-summary'));
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
        processLive: processLiveFromPid(typeof asyncStart?.pid === 'number' ? asyncStart.pid : null),
        cleanupVerified: false,
        recommendedNextAction: 'wait_again',
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
      const capacity = providerCapacityMetadata({ error: message, text: message });
      if (capacity) {
        return ledger.updateChild(revived.childId, {
          status: 'failed',
          ...capacityFailurePatch(capacity),
          timedOut: false,
          timeoutMs: normalized.timeoutMs ?? this.timeoutMs,
          recommendedNextAction: CAPACITY_RECOMMENDED_ACTION,
          cleanupState: 'none',
        }, 'child_failed');
      }
      const failedChild = await ledger.updateChild(revived.childId, {
        status: 'failed',
        ...terminalMetadata(message, 'failed'),
        failureReason: /did not start/i.test(message) ? 'bridge_start_timeout' : 'bridge_revive_error',
        ...clearCapacityPatch(),
        errorSummary: errorSummary(message),
        timedOut: /timed out|did not start/i.test(message),
        timeoutMs: /did not start/i.test(message) ? this.startTimeoutMs : (normalized.timeoutMs ?? this.timeoutMs),
        recommendedNextAction: /did not start/i.test(message) ? 'run_diagnose' : 'inspect_error',
        cleanupState: 'none',
      }, 'child_failed');
      return ledger.storeChildOutput(failedChild.childId, message, outputStoreOptions('failure-summary'));
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
      const processLive = processLiveFromPid(child.pid);
      const updated = await ledger.updateChild(childId, {
        cleanupState: child.cleanupState === 'closed' ? 'closed' : 'already_closed',
        closeRequested: false,
        processLive,
        cleanupVerified: cleanupVerifiedFromProcess(processLive),
      }, 'child_already_closed');
      return ledger.clearChildOutput(updated.childId);
    }
    let requestId = null;
    try {
      requestId = await this.requestInterrupt(child, normalized.timeoutMs ?? this.timeoutMs);
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
          const processLive = processLiveFromPid(child.pid);
          const updated = await ledger.updateChild(childId, {
            cleanupState: 'already_closed',
            closeRequested: false,
            processLive,
            cleanupVerified: cleanupVerifiedFromProcess(processLive),
          }, 'child_already_closed');
          return ledger.clearChildOutput(updated.childId);
        }
      }
      await ledger.appendEvent({ event: 'bridge_close_error', childId, upstreamRunId: child.upstreamRunId, ...errorMetadata(message, 'bridge_close_error') });
      await ledger.updateChild(childId, {
        cleanupState: 'close_failed',
        closeRequested: true,
        processLive: processLiveFromPid(child.pid),
        cleanupVerified: false,
      }, 'child_cleanup_failed');
      throw new Error(`stronk_subagent close failed: ${terminalSummary(message)}`);
    }
    const processLive = processLiveFromPid(child.pid);
    const closed = await ledger.updateChild(childId, {
      status: 'closed',
      cleanupState: 'closed',
      closeRequested: Boolean(requestId),
      processLive,
      cleanupVerified: cleanupVerifiedFromProcess(processLive),
      recommendedNextAction: null,
      ...terminalMetadata('closed', 'closed'),
    }, 'child_closed');
    return ledger.clearChildOutput(closed.childId);
  }

  async interrupt(ledger, childId, normalized = {}) {
    const child = await ledger.getChild(childId);
    if (isTerminalStatus(child.status)) return child;
    let requestId = null;
    try {
      requestId = await this.requestInterrupt(child, normalized.timeoutMs ?? this.timeoutMs);
      await ledger.appendEvent({ event: 'bridge_interrupt_requested', childId, requestId, upstreamRunId: child.upstreamRunId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ledger.appendEvent({ event: 'bridge_interrupt_error', childId, upstreamRunId: child.upstreamRunId, ...errorMetadata(message, 'bridge_interrupt_error') });
      await ledger.updateChild(childId, {
        cleanupState: 'interrupt_failed',
        closeRequested: true,
        processLive: processLiveFromPid(child.pid),
        cleanupVerified: false,
      }, 'child_cleanup_failed');
      throw new Error(`stronk_subagent interrupt failed: ${terminalSummary(message)}`);
    }
    const processLive = processLiveFromPid(child.pid);
    return ledger.updateChild(childId, {
      status: 'interrupted',
      cleanupState: 'interrupted',
      closeRequested: Boolean(requestId),
      processLive,
      cleanupVerified: cleanupVerifiedFromProcess(processLive),
      recommendedNextAction: 'inspect_error',
      ...terminalMetadata('interrupted', 'interrupted'),
    }, 'child_interrupted');
  }
}
