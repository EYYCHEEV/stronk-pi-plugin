import { randomUUID, createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';

const SCHEMA_VERSION = 1;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'closed', 'interrupted', 'stale', 'dry-run']);
const pathLocks = new Map();

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function bytes(text) {
  return Buffer.byteLength(String(text), 'utf8');
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

function publicChild(child) {
  return {
    childId: child.childId,
    role: child.role,
    cwd: child.cwd,
    status: child.status,
    previousChildId: child.previousChildId ?? null,
    upstreamRunId: child.upstreamRunId ?? null,
    intercomTarget: child.intercomTarget ?? null,
    pid: child.pid ?? null,
    terminalResult: child.terminalResult ?? null,
    terminalResultSha256: child.terminalResultSha256 ?? null,
    terminalResultBytes: child.terminalResultBytes ?? null,
    cleanupState: child.cleanupState ?? 'none',
    createdAt: child.createdAt,
    updatedAt: child.updatedAt,
  };
}

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
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

  async createChild({ role, cwd = this.cwd, task, previousChildId = null }) {
    const at = nowIso();
    const child = await this.mutateChildren((children) => {
      if (children.length >= this.maxChildren) {
        throw new Error(`stronk_subagent child limit exceeded: ${children.length}>${this.maxChildren - 1}`);
      }
      const nextChild = {
        childId: `sp-child-${randomUUID()}`,
        role,
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
        cleanupState: 'none',
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
}
