import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls']);
const MUTATING_TOOLS = new Set(['bash', 'write', 'edit', 'patch', 'apply_patch', 'multi_edit']);
const PLUGIN_TOOLS = new Set(['mcp', 'subagent']);
const SECRET_KEY_EXACT = new Set(['key', 'auth', 'password', 'passphrase', 'credential', 'credentials', 'cookie']);
const SECRET_KEY_SUFFIXES = [
  'apikey',
  'token',
  'secret',
  'password',
  'passphrase',
  'credential',
  'credentials',
  'cookie',
  'privatekey',
  'secretkey',
];
const SECRET_VALUE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9_]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{16,}/g,
  /(telegram|bot)[-_]?(token)['"=: ]+[A-Za-z0-9:_-]{16,}/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];
const ASSIGNMENT_PATTERN = /(^|[\s;])([A-Za-z_][A-Za-z0-9_-]*)\s*([:=])\s*["']?([^"'\s;]{4,})/g;

function canonical(value) {
  return JSON.stringify(stableJson(value));
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = stableJson(value[key]);
    }
    return out;
  }
  return value;
}

function normalizeKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key) {
  const normalized = normalizeKey(key);
  return SECRET_KEY_EXACT.has(normalized) || SECRET_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function matchesPattern(pattern, text) {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

function hasSensitiveString(text) {
  if (SECRET_VALUE_PATTERNS.some((pattern) => matchesPattern(pattern, text))) return true;
  ASSIGNMENT_PATTERN.lastIndex = 0;
  for (let match = ASSIGNMENT_PATTERN.exec(text); match; match = ASSIGNMENT_PATTERN.exec(text)) {
    if (isSensitiveKey(match[2])) return true;
  }
  return false;
}

function hasSensitiveContent(value) {
  if (Array.isArray(value)) return value.some(hasSensitiveContent);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, item]) => isSensitiveKey(key) || hasSensitiveContent(item));
  }
  if (typeof value !== 'string') return false;
  return hasSensitiveString(value);
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? '<redacted>' : redact(item);
    }
    return out;
  }
  if (typeof value !== 'string') return value;
  let text = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    text = text.replace(pattern, '<redacted>');
  }
  text = text.replace(ASSIGNMENT_PATTERN, (match, prefix, key, operator) => (
    isSensitiveKey(key) ? `${prefix}${key}${operator}<redacted>` : match
  ));
  return text.length > 2000 ? `${text.slice(0, 2000)}...<truncated>` : text;
}

function helperArgv(kind) {
  const explicit = process.env[`STRONK_PI_${kind.toUpperCase()}_COMMAND_JSON`];
  if (explicit) {
    const parsed = JSON.parse(explicit);
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((item) => typeof item === 'string')) {
      throw new Error(`${kind} command must be a non-empty JSON string array`);
    }
    return parsed;
  }

  const guard = process.env.STRONK_PI_GUARD;
  if (!guard) throw new Error('STRONK_PI_GUARD is missing');
  accessSync(guard, constants.X_OK);
  return ['python3', guard, kind];
}

function runHelper(kind, payload) {
  const argv = helperArgv(kind);
  const timeoutMs = Number(process.env.STRONK_PI_GUARD_TIMEOUT_MS || '5000');
  const input = JSON.stringify(redact(payload));

  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${kind} helper timed out`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${kind} helper exited ${code}: ${redact(stderr).trim()}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin.end(input);
  });
}

async function guardedDecision(payload) {
  const stdout = await runHelper('hook', payload);
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('hook helper returned malformed JSON');
  }
  if (typeof parsed.allow !== 'boolean' || typeof parsed.reason !== 'string') {
    throw new Error('hook helper returned missing keys');
  }
  return parsed;
}

function block(reason) {
  return { block: true, reason: String(redact(reason)) };
}

function deniedBashResult(reason) {
  return {
    result: {
      output: `BLOCKED: ${String(redact(reason))}`,
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  };
}

function isUnsupportedMutatingTool(toolName) {
  return MUTATING_TOOLS.has(toolName) && !['bash', 'write', 'edit'].includes(toolName);
}

async function handleToolCall(event) {
  const toolName = event?.toolName;
  if (!toolName) return block('tool_call missing toolName');
  if (isUnsupportedMutatingTool(toolName)) return block(`unsupported mutating tool denied: ${toolName}`);
  if (hasSensitiveContent(event.input ?? {})) return block('sensitive content blocked in tool_call input');

  const before = canonical(event.input ?? {});
  let decision;
  try {
    decision = await guardedDecision({
      event: 'tool_call',
      toolName,
      toolCallId: event.toolCallId,
      input: event.input,
      cwd: event.cwd ?? process.cwd(),
      scratchWrite: process.env.STRONK_PI_SCRATCH_WRITE === '1',
    });
  } catch (error) {
    return block(error?.message ?? String(error));
  }

  if (canonical(event.input ?? {}) !== before) {
    return block('tool_call payload mutated during guard evaluation');
  }
  if (!decision.allow) return block(decision.reason);
  if (!READ_ONLY_TOOLS.has(toolName) && !MUTATING_TOOLS.has(toolName) && !PLUGIN_TOOLS.has(toolName)) {
    return block(`unknown tool denied by default: ${toolName}`);
  }
  return undefined;
}

async function handleUserBash(event) {
  const before = String(event?.command ?? '');
  if (hasSensitiveContent(before)) return deniedBashResult('sensitive content blocked in user_bash command');
  let decision;
  try {
    decision = await guardedDecision({
      event: 'user_bash',
      command: event?.command,
      excludeFromContext: Boolean(event?.excludeFromContext),
      cwd: event?.cwd ?? process.cwd(),
    });
  } catch (error) {
    return deniedBashResult(error?.message ?? String(error));
  }
  if (String(event?.command ?? '') !== before) {
    return deniedBashResult('user_bash payload mutated during guard evaluation');
  }
  return decision.allow ? undefined : deniedBashResult(decision.reason);
}

async function notify(payload) {
  try {
    await runHelper('telegram', redact(payload));
  } catch {
    // Notifications are observability only and must fail open.
  }
}

export default async function stronkPi(pi) {
  pi.on('tool_call', handleToolCall);
  pi.on('user_bash', handleUserBash);

  for (const eventName of ['session_start', 'agent_end', 'turn_end', 'tool_result']) {
    pi.on(eventName, (event) => {
      void notify({ type: eventName, event: redact(event), cwd: process.cwd() });
    });
  }
}

export const internals = {
  canonical,
  hasSensitiveContent,
  redact,
  helperArgv,
  runHelper,
  guardedDecision,
  handleToolCall,
  handleUserBash,
  notify,
};
