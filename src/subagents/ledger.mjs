import { randomUUID, createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';

const SCHEMA_VERSION = 1;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'closed', 'interrupted', 'stale', 'dry-run']);
const OUTPUT_ARTIFACT_CAP_BYTES = 1024 * 1024;
const pathLocks = new Map();
const SECRET_VALUE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9_]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const SECRET_ASSIGNMENT_PATTERN = /(\b(?:key|password|token|secret|[A-Za-z_][A-Za-z0-9_-]*(?:key|password|token|secret)[A-Za-z0-9_-]*)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const QUOTED_FILE_URL_PATTERN = /(["'])(file:\/\/\/[^"'`\n]+)\1/g;
const FILE_URL_PATTERN = /file:\/\/\/[^\s"'`\n),;}>]*/g;
const QUOTED_LOCAL_PATH_PATTERN = /(["'])((?:\/Users|\/home|\/tmp|\/private\/tmp|\/var\/folders|\/private\/var|\/root|\/etc)\/[^"'`\n]*)\1/g;
const LOCAL_PATH_PATTERN = /(^|[\s([{<])((?:\/Users|\/home|\/tmp|\/private\/tmp|\/var\/folders|\/private\/var|\/root|\/etc)(?:\/[^\s"'`\n),;}>]*)?)/g;
const SSH_PATH_PATTERN = /(^|[\s([{<])([^\s"'`\n),;}>]*\.ssh[^\s"'`\n),;}>]*)/g;

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function bytes(text) {
  return Buffer.byteLength(String(text), 'utf8');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sanitizePublicOutput(text, extraPaths = []) {
  let value = String(text ?? '');
  for (const pattern of SECRET_VALUE_PATTERNS) {
    value = value.replace(pattern, '<redacted>');
  }
  value = value.replace(SECRET_ASSIGNMENT_PATTERN, '$1<redacted>');
  for (const rawPath of [stateRoot(), ...extraPaths]) {
    if (!rawPath) continue;
    value = value.replace(new RegExp(escapeRegExp(resolve(String(rawPath))), 'g'), '<redacted-path>');
  }
  value = value.replace(QUOTED_FILE_URL_PATTERN, '$1<redacted-path>$1');
  value = value.replace(FILE_URL_PATTERN, '<redacted-path>');
  value = value.replace(QUOTED_LOCAL_PATH_PATTERN, '$1<redacted-path>$1');
  value = value.replace(LOCAL_PATH_PATTERN, '$1<redacted-path>');
  value = value.replace(SSH_PATH_PATTERN, '$1<redacted-path>');
  return value;
}

export function boundedUtf8(text, maxBytes, marker = '') {
  const value = String(text ?? '');
  if (bytes(value) <= maxBytes) return { text: value, bytes: bytes(value), chars: [...value].length, truncated: false };
  const markerBytes = bytes(marker);
  const contentBudget = Math.max(0, maxBytes - markerBytes);
  let used = 0;
  let output = '';
  for (const char of value) {
    const charBytes = bytes(char);
    if (used + charBytes > contentBudget) break;
    output += char;
    used += charBytes;
  }
  const textOut = `${output}${marker}`;
  return { text: textOut, bytes: bytes(textOut), chars: [...textOut].length, truncated: true };
}

function recommendedNextAction(child) {
  if (child.recommendedNextAction) return child.recommendedNextAction;
  if (child.status === 'running' || child.status === 'spawned') return 'wait_again';
  if (child.status === 'completed') return 'close_child';
  if (child.failureClass === 'provider_capacity' || child.retryReason === 'provider_capacity') return 'retry_capacity_children_next_batch';
  if (child.status === 'failed') return 'inspect_error';
  if (child.status === 'stale') return 'run_diagnose';
  if (child.status === 'interrupted') return 'inspect_error';
  return null;
}

function nowIso() {
  return new Date().toISOString();
}

function stateRoot() {
  return resolve(process.env.STRONK_PI_STATE_ROOT || join(homedir(), '.stronk-pi'));
}

export function createFacadeRunId() {
  return `facade-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function runId(value) {
  return value || process.env.STRONK_PI_FACADE_RUN_ID || createFacadeRunId();
}

function repoHash(cwd) {
  const anchor = resolve(cwd || process.cwd());
  return sha256(anchor).slice(0, 16);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writePrivateFile(path, contents) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tmp, contents, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  await chmod(path, 0o600);
}

async function writePrivateFileIfMissing(path, contents) {
  await withPathLock(path, async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    try {
      await writeFile(path, contents, { mode: 0o600, flag: 'wx' });
      await chmod(path, 0o600);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        await chmod(path, 0o600);
        return;
      }
      throw error;
    }
  });
}

async function withPathLock(path, action) {
  const key = resolve(path);
  const previous = pathLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolveRelease) => {
    release = resolveRelease;
  });
  pathLocks.set(key, previous.catch(() => {}).then(() => current));
  await previous.catch(() => {});
  try {
    return await action();
  } finally {
    release();
  }
}

function hasOutputArtifact(child) {
  return Boolean(child.childOutputPreview || child.childOutputHandle);
}

function outputArtifactKind(child) {
  if (!hasOutputArtifact(child)) return 'none';
  if (child.outputArtifactKind) return child.outputArtifactKind;
  if (child.status === 'completed') return 'findings';
  if (child.status === 'failed') return 'failure-summary';
  return 'terminal-summary';
}

function publicChild(child) {
  const artifactKind = outputArtifactKind(child);
  return {
    childId: child.childId,
    projectRef: child.projectRef ?? null,
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
    terminalOutputPreview: child.terminalOutputPreview ?? child.childOutputPreview ?? null,
    terminalResultSha256: child.terminalResultSha256 ?? null,
    terminalResultBytes: child.terminalResultBytes ?? null,
    childOutputPreview: child.childOutputPreview ?? null,
    childOutputTruncated: Boolean(child.childOutputTruncated),
    childOutputBytes: child.childOutputBytes ?? 0,
    childOutputHash: child.childOutputHash ?? null,
    childOutputHandle: child.childOutputHandle ?? null,
    childOutputFullBytes: child.childOutputFullBytes ?? null,
    childOutputFullChars: child.childOutputFullChars ?? null,
    childOutputFullHash: child.childOutputFullHash ?? null,
    childOutputArtifactTruncated: Boolean(child.childOutputArtifactTruncated),
    failureReason: child.failureReason ?? null,
    failureClass: child.failureClass ?? null,
    retryable: Boolean(child.retryable),
    retryReason: child.retryReason ?? null,
    retryAfterMs: typeof child.retryAfterMs === 'number' ? child.retryAfterMs : null,
    capacityBlocked: Boolean(child.capacityBlocked),
    concurrencyInUse: typeof child.concurrencyInUse === 'number' ? child.concurrencyInUse : null,
    concurrencyLimit: typeof child.concurrencyLimit === 'number' ? child.concurrencyLimit : null,
    outputArtifactKind: artifactKind,
    outputUsableForSynthesis: child.outputUsableForSynthesis ?? artifactKind === 'findings',
    errorSummary: child.errorSummary ?? null,
    closeError: child.closeError ? sanitizePublicOutput(child.closeError, [child.cwd]) : null,
    timedOut: Boolean(child.timedOut),
    elapsedMs: typeof child.elapsedMs === 'number' ? child.elapsedMs : null,
    timeoutMs: typeof child.timeoutMs === 'number' ? child.timeoutMs : null,
    recommendedNextAction: recommendedNextAction(child),
    closeRequested: Boolean(child.closeRequested),
    cleanupState: child.cleanupState ?? 'none',
    processLive: child.processLive ?? null,
    cleanupVerified: Boolean(child.cleanupVerified),
    inputAccepted: Boolean(child.inputAccepted),
    inputLinkedChildId: child.inputLinkedChildId ?? null,
    createdAt: child.createdAt,
    updatedAt: child.updatedAt,
  };
}

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function containedOutputPath(outputDir, artifactPath) {
  if (!artifactPath) return null;
  const outputRoot = resolve(outputDir);
  const target = resolve(String(artifactPath));
  return target.startsWith(`${outputRoot}/`) ? target : null;
}

async function removeContainedOutput(outputDir, artifactPath) {
  const target = containedOutputPath(outputDir, artifactPath);
  if (!target) return false;
  await rm(target, { force: true });
  return true;
}

export class SubagentLedger {
  constructor({ cwd = process.cwd(), mode = 'dry-run', maxChildren = 6, facadeRunId } = {}) {
    this.cwd = resolve(cwd || process.cwd());
    this.projectHash = repoHash(this.cwd);
    this.runId = runId(facadeRunId);
    this.dir = join(stateRoot(), 'projects', this.projectHash, 'facade-runs', this.runId);
    this.manifestPath = join(this.dir, 'manifest.json');
    this.childrenPath = join(this.dir, 'children.json');
    this.eventsPath = join(this.dir, 'events.ndjson');
    this.outputDir = join(this.dir, 'outputs');
    this.mode = mode;
    this.maxChildren = maxChildren;
  }

  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const manifest = {
      schema_version: SCHEMA_VERSION,
      runtime: 'pi',
      facade_run_id: this.runId,
      repo_root: this.cwd,
      project_hash: this.projectHash,
      mode: this.mode,
      max_children: this.maxChildren,
      created_at: nowIso(),
    };
    await writePrivateFileIfMissing(this.manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    await writePrivateFileIfMissing(this.childrenPath, JSON.stringify({ children: [] }, null, 2) + '\n');
    await writePrivateFileIfMissing(this.eventsPath, '');
    return this;
  }

  async children() {
    const data = await readJson(this.childrenPath, { children: [] });
    return Array.isArray(data.children) ? data.children : [];
  }

  async saveChildren(children) {
    await withPathLock(this.childrenPath, () => writePrivateFile(this.childrenPath, JSON.stringify({ children }, null, 2) + '\n'));
  }

  async mutateChildren(mutator) {
    return withPathLock(this.childrenPath, async () => {
      const data = await readJson(this.childrenPath, { children: [] });
      const children = Array.isArray(data.children) ? data.children : [];
      const result = await mutator(children);
      await writePrivateFile(this.childrenPath, JSON.stringify({ children }, null, 2) + '\n');
      return result;
    });
  }

  async appendEvent(event) {
    const line = JSON.stringify({ schema_version: SCHEMA_VERSION, at: nowIso(), ...event }) + '\n';
    await withPathLock(this.eventsPath, async () => {
      await mkdir(dirname(this.eventsPath), { recursive: true, mode: 0o700 });
      await chmod(dirname(this.eventsPath), 0o700);
      await appendFile(this.eventsPath, line, { mode: 0o600 });
      await chmod(this.eventsPath, 0o600);
    });
  }

  async createChild({
    role,
    cwd = this.cwd,
    task,
    previousChildId = null,
    roleRequested = role,
    roleUsed = role,
    aliasResolved = false,
    aliasMessage = null,
  }) {
    const at = nowIso();
    const child = await this.mutateChildren((children) => {
      const activeChildren = children.filter((item) => !isTerminalStatus(item.status));
      if (activeChildren.length >= this.maxChildren) {
        throw new Error(`stronk_subagent child limit exceeded: ${activeChildren.length}>${this.maxChildren - 1}`);
      }
      const nextChild = {
        childId: `sp-child-${randomUUID()}`,
        projectRef: this.projectHash,
        role,
        roleRequested,
        roleUsed,
        aliasResolved: Boolean(aliasResolved),
        aliasMessage,
        cwd: resolve(cwd || this.cwd),
        status: 'spawned',
        previousChildId,
        upstreamSessionId: null,
        upstreamRunId: null,
        upstreamAsyncDir: null,
        upstreamResultPath: null,
        upstreamMode: null,
        upstreamState: null,
        upstreamRequestId: null,
        intercomTarget: null,
        pid: null,
        processGroup: null,
        terminalResult: null,
        terminalResultSha256: null,
        terminalResultBytes: 0,
        terminalOutputPreview: null,
        childOutputPreview: null,
        childOutputTruncated: false,
        childOutputBytes: 0,
        childOutputHash: null,
        childOutputHandle: null,
        childOutputArtifactPath: null,
        childOutputFullBytes: null,
        childOutputFullChars: null,
        childOutputFullHash: null,
        childOutputArtifactTruncated: false,
        outputArtifactKind: null,
        failureReason: null,
        failureClass: null,
        retryable: false,
        retryReason: null,
        retryAfterMs: null,
        capacityBlocked: false,
        concurrencyInUse: null,
        concurrencyLimit: null,
        outputUsableForSynthesis: null,
        errorSummary: null,
        timedOut: false,
        elapsedMs: null,
        timeoutMs: null,
        recommendedNextAction: 'wait_again',
        closeRequested: false,
        cleanupState: 'none',
        processLive: null,
        cleanupVerified: false,
        inputAccepted: false,
        inputLinkedChildId: null,
        taskSha256: sha256(task),
        taskBytes: bytes(task),
        createdAt: at,
        updatedAt: at,
      };
      children.push(nextChild);
      return nextChild;
    });
    await this.appendEvent({
      event: 'child_spawned',
      childId: child.childId,
      role,
      status: child.status,
      previousChildId,
      taskSha256: child.taskSha256,
      taskBytes: child.taskBytes,
    });
    return child;
  }

  async getChild(childId) {
    const child = (await this.children()).find((item) => item.childId === childId);
    if (!child) throw new Error(`stronk_subagent child not found: ${childId}`);
    return child;
  }

  async updateChild(childId, patch, event = 'child_updated') {
    const child = await this.mutateChildren((children) => {
      const index = children.findIndex((item) => item.childId === childId);
      if (index < 0) throw new Error(`stronk_subagent child not found: ${childId}`);
      const nextChild = {
        ...children[index],
        ...patch,
        updatedAt: nowIso(),
      };
      children[index] = nextChild;
      return nextChild;
    });
    await this.appendEvent({ event, childId, status: child.status, cleanupState: child.cleanupState });
    return child;
  }

  publicChild(child) {
    return publicChild(child);
  }

  artifactPaths() {
    return {
      runDir: this.dir,
      manifest: this.manifestPath,
      children: this.childrenPath,
      events: this.eventsPath,
    };
  }

  outputPathForHandle(handle) {
    return join(this.outputDir, `${handle}.txt`);
  }

  async storeChildOutput(childId, rawText, {
    outputArtifactKind = null,
    outputUsableForSynthesis = null,
  } = {}) {
    const child = await this.getChild(childId);
    if (child.childOutputArtifactPath) {
      await removeContainedOutput(this.outputDir, child.childOutputArtifactPath).catch(() => {});
    }
    const sanitized = sanitizePublicOutput(rawText, [this.cwd, this.dir]);
    const capped = boundedUtf8(sanitized, OUTPUT_ARTIFACT_CAP_BYTES);
    const handle = `subagent-output-${randomUUID()}`;
    const artifactPath = this.outputPathForHandle(handle);
    await writePrivateFile(artifactPath, capped.text);
    return this.updateChild(childId, {
      childOutputHandle: handle,
      childOutputArtifactPath: artifactPath,
      childOutputFullBytes: capped.bytes,
      childOutputFullChars: capped.chars,
      childOutputFullHash: sha256(capped.text),
      childOutputArtifactTruncated: capped.truncated,
      outputArtifactKind,
      outputUsableForSynthesis,
    }, 'child_output_stored');
  }

  async clearChildOutput(childId) {
    const child = await this.getChild(childId);
    if (child.childOutputArtifactPath) {
      await removeContainedOutput(this.outputDir, child.childOutputArtifactPath).catch(() => {});
    }
    return this.updateChild(childId, {
      childOutputHandle: null,
      childOutputArtifactPath: null,
      childOutputFullBytes: null,
      childOutputFullChars: null,
      childOutputFullHash: null,
      childOutputArtifactTruncated: false,
      outputArtifactKind: null,
      outputUsableForSynthesis: null,
    }, 'child_output_removed');
  }

  async readOutput(handle, { offset = 0, maxChars = 12000 } = {}) {
    const children = await this.children();
    const child = children.find((item) => item.childOutputHandle === handle);
    if (!child || !child.childOutputArtifactPath) {
      throw new Error('stronk_subagent output handle denied');
    }
    const artifactPath = containedOutputPath(this.outputDir, child.childOutputArtifactPath);
    if (!artifactPath) {
      throw new Error('stronk_subagent output handle denied');
    }
    const text = await readFile(artifactPath, 'utf8');
    const chars = [...text];
    if (offset > chars.length) {
      throw new Error('offset exceeds output length');
    }
    const chunk = chars.slice(offset, offset + maxChars).join('');
    const nextOffset = offset + [...chunk].length;
    return {
      handle,
      childId: child.childId,
      chunk,
      offset,
      nextOffset,
      totalChars: chars.length,
      eof: nextOffset >= chars.length,
      artifactTruncated: Boolean(child.childOutputArtifactTruncated),
      redacted: true,
      bytes: bytes(text),
      hash: sha256(text),
    };
  }

  publicDiagnostics() {
    return {
      facadeRunId: this.runId,
      projectRef: this.projectHash,
      mode: this.mode,
      maxChildren: this.maxChildren,
    };
  }
}
