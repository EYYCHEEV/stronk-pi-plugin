import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, dirname, join, isAbsolute, relative, resolve } from 'node:path';
import { createSubagentFacade, facadeAdapterMode, facadeEnabled, stronkSubagentSchema } from './subagents/facade.mjs';
import { PiSubagentsBridgeAdapter } from './subagents/adapters/pi-subagents-bridge.mjs';

const SAFE_FETCH_TOOL = 'stronk_fetch_content';
const STRONK_SUBAGENT_TOOL = 'stronk_subagent';
const DISABLED_PLUGIN_TOOLS = new Set(['fetch_content']);
const WEB_TOOLS = new Set(['web_search', 'code_search', SAFE_FETCH_TOOL, 'get_search_content']);
const SESSION_TOOLS = new Set(['todowrite', 'todoread', 'question', 'ask_user']);
const INTERCOM_TOOLS = new Set(['intercom', 'contact_supervisor']);
const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'glob', 'todoread']);
const MUTATING_TOOLS = new Set(['bash', 'write', 'edit', 'patch', 'apply_patch', 'multi_edit']);
const PLUGIN_TOOLS = new Set(['mcp', 'subagent', STRONK_SUBAGENT_TOOL, ...WEB_TOOLS, ...SESSION_TOOLS, ...INTERCOM_TOOLS]);
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
const ASSIGNMENT_PATTERN = /(^|[\s;,{])(["']?)([A-Za-z_][A-Za-z0-9_-]*)(["']?)\s*([:=])\s*(["']?)([^"'\s;,}]{4,})(["']?)/g;
const GENERIC_SECRET_ASSIGNMENT_KEYS = new Set(['key']);
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed']);
const TODO_PRIORITIES = new Set(['low', 'medium', 'high']);
const MAX_FETCH_BYTES = 1024 * 1024;
const MAX_FETCH_REDIRECTS = 5;
const MAX_SKILL_SCAN_DEPTH = 6;
const MAX_SKILL_AUTOCOMPLETE_ITEMS = 20;
const MAX_SKILL_METADATA_BYTES = 16 * 1024;
const SKILL_FILENAME = 'SKILL.md';
const SKILL_PATH_PREFIX = 'skill://';
const NON_SKILL_LINK_PREFIXES = ['app://', 'mcp://', 'plugin://'];
const COMMON_ENV_VARS = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'TERM', 'XDG_CONFIG_HOME']);
const SKILL_SCOPE_RANK = new Map([
  ['repo', 0],
  ['user', 1],
  ['system', 2],
  ['admin', 3],
]);
const RESUME_HINT_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const registeredSkillAutocompleteUIs = new WeakSet();
const interactiveResumeHintSessionManagers = new WeakSet();
const CODEX_HOOK_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
]);
const CODEX_HOOK_FAIL_CLOSED_EVENTS = new Set(['UserPromptSubmit', 'PermissionRequest']);
const CODEX_PERMISSION_ALLOW_DECISIONS = new Set(['allow', 'approve', 'approved', 'accept', 'accepted']);
const CODEX_PERMISSION_BLOCK_DECISIONS = new Set(['block', 'deny', 'denied', 'reject', 'rejected', 'ask']);

const emptyObjectSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

const globSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['pattern'],
  properties: {
    pattern: { type: 'string', description: 'Glob pattern such as **/*.ts or src/**/*.md.' },
    path: { type: 'string', description: 'Optional directory inside the current project to search from.' },
    maxResults: { type: 'number', minimum: 1, maximum: 1000, description: 'Maximum results to return. Defaults to 200.' },
    includeHidden: { type: 'boolean', description: 'Include hidden files and directories. Defaults to false.' },
  },
};

const todoItemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['content', 'status'],
  properties: {
    id: { type: 'string' },
    content: { type: 'string' },
    status: { type: 'string', enum: [...TODO_STATUSES] },
    priority: { type: 'string', enum: [...TODO_PRIORITIES] },
  },
};

const todoWriteSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['todos'],
  properties: {
    todos: { type: 'array', maxItems: 100, items: todoItemSchema },
  },
};

const questionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['question'],
  properties: {
    header: { type: 'string', description: 'Short dialog title.' },
    question: { type: 'string', description: 'The question to ask the operator.' },
    options: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label'],
        properties: {
          label: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
    allowFreeform: { type: 'boolean', description: 'Allow text input when no option is selected. Defaults to true.' },
    timeoutMs: { type: 'number', minimum: 1000, maximum: 600000 },
  },
};

const fetchContentSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string', description: 'Single public http(s) URL to fetch.' },
    urls: {
      type: 'array',
      maxItems: 5,
      items: { type: 'string' },
      description: 'Public http(s) URLs to fetch sequentially.',
    },
  },
};

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
    const normalizedKey = normalizeKey(match[3]);
    if (!isSensitiveKey(match[3])) continue;
    if (GENERIC_SECRET_ASSIGNMENT_KEYS.has(normalizedKey)) {
      const assignedValue = match[7];
      if (!SECRET_VALUE_PATTERNS.some((pattern) => matchesPattern(pattern, assignedValue))) continue;
    }
    return true;
  }
  return false;
}

function hasBlockingSensitiveString(text) {
  return SECRET_VALUE_PATTERNS.some((pattern) => matchesPattern(pattern, text));
}

function hasSensitiveContent(value) {
  if (Array.isArray(value)) return value.some(hasSensitiveContent);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, item]) => isSensitiveKey(key) || hasSensitiveContent(item));
  }
  if (typeof value !== 'string') return false;
  return hasSensitiveString(value);
}

function hasBlockingSensitiveContent(value) {
  if (Array.isArray(value)) return value.some(hasBlockingSensitiveContent);
  if (value && typeof value === 'object') {
    return Object.values(value).some(hasBlockingSensitiveContent);
  }
  if (typeof value !== 'string') return false;
  return hasBlockingSensitiveString(value);
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
  text = text.replace(ASSIGNMENT_PATTERN, (match, prefix, keyOpen, key, keyClose, operator, valueOpen, _value, valueClose) => (
    isSensitiveKey(key) ? `${prefix}${keyOpen}${key}${keyClose}${operator}${valueOpen}<redacted>${valueClose}` : match
  ));
  return text.length > 2000 ? `${text.slice(0, 2000)}...<truncated>` : text;
}

function helperArgv(kind) {
  const envKind = kind.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const explicit = process.env[`STRONK_PI_${envKind}_COMMAND_JSON`];
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
        reject(new Error(helperExitMessage(kind, code, stderr, stdout)));
        return;
      }
      resolve(stdout);
    });
    child.stdin.end(input);
  });
}

function helperExitMessage(kind, code, stderr, stdout) {
  const stderrText = String(redact(stderr)).trim();
  const stdoutText = String(redact(stdout)).trim();
  let detail = stderrText;
  if (!detail && stdoutText) {
    try {
      const parsed = JSON.parse(stdoutText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        detail = firstString(parsed.reason, parsed.message, parsed.error) || stdoutText;
      } else {
        detail = stdoutText;
      }
    } catch {
      detail = stdoutText;
    }
  }
  return `${kind} helper exited ${code}${detail ? `: ${detail}` : ''}`;
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

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function nestedString(value, ...path) {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return typeof current === 'string' && current.trim() ? current.trim() : undefined;
}

function piHookContext(event = {}, ctx = {}) {
  const toolUseId = firstString(
    event.toolCallId,
    event.toolUseId,
    event.tool_use_id,
    ctx.toolCallId,
    ctx.toolUseId,
    ctx.tool_use_id,
  );
  return {
    session_id: firstString(
      event.sessionId,
      event.session_id,
      nestedString(event, 'session', 'id'),
      ctx.sessionId,
      ctx.session_id,
      nestedString(ctx, 'session', 'id'),
      process.env.PI_SESSION_ID,
      process.env.STRONK_PI_SWARM_RUN_ID,
    ),
    turn_id: firstString(
      event.turnId,
      event.turn_id,
      ctx.turnId,
      ctx.turn_id,
      process.env.PI_TURN_ID,
      process.env.STRONK_PI_TURN_ID,
    ),
    transcript_path: firstString(
      event.transcriptPath,
      event.transcript_path,
      nestedString(event, 'session', 'transcriptPath'),
      ctx.transcriptPath,
      ctx.transcript_path,
      nestedString(ctx, 'session', 'transcriptPath'),
      process.env.PI_TRANSCRIPT_PATH,
      process.env.STRONK_PI_TRANSCRIPT_PATH,
    ),
    model: firstString(
      event.model,
      event.modelId,
      event.model_id,
      nestedString(event, 'model', 'id'),
      nestedString(event, 'model', 'slug'),
      ctx.model,
      ctx.modelId,
      ctx.model_id,
      nestedString(ctx, 'model', 'id'),
      nestedString(ctx, 'model', 'slug'),
      process.env.PI_MODEL,
      process.env.STRONK_PI_MODEL,
    ),
    permission_mode: firstString(
      event.permissionMode,
      event.permission_mode,
      ctx.permissionMode,
      ctx.permission_mode,
      process.env.PI_PERMISSION_MODE,
      process.env.STRONK_PI_PERMISSION_MODE,
    ),
    tool_use_id: toolUseId,
  };
}

function codexSessionStartSource(event = {}) {
  const reason = firstString(event.reason, event.source, event.sessionStartSource);
  if (reason === 'resume') return 'resume';
  if (reason === 'clear') return 'clear';
  return 'startup';
}

function latestAssistantMessage(event = {}) {
  const direct = firstString(event.lastAssistantMessage, event.last_assistant_message);
  if (direct) return direct;
  const message = event.message;
  if (typeof message === 'string' && message.trim()) return message.trim();
  if (message && typeof message === 'object') {
    const content = message.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .map((item) => (item && typeof item === 'object' && typeof item.text === 'string' ? item.text : ''))
        .filter(Boolean)
        .join('');
      if (text.trim()) return text.trim();
    }
  }
  if (Array.isArray(event.messages)) {
    for (const item of [...event.messages].reverse()) {
      if (!item || typeof item !== 'object' || item.role !== 'assistant') continue;
      const content = item.content;
      if (typeof content === 'string' && content.trim()) return content.trim();
      if (Array.isArray(content)) {
        const text = content
          .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
          .filter(Boolean)
          .join('');
        if (text.trim()) return text.trim();
      }
    }
  }
  return undefined;
}

function codexHookBase(hookEventName, event = {}, ctx = {}) {
  if (!CODEX_HOOK_EVENTS.has(hookEventName)) {
    throw new Error(`unsupported Codex hook event: ${hookEventName}`);
  }
  const context = piHookContext(event, ctx);
  return {
    session_id: context.session_id || 'stronk-pi',
    turn_id: context.turn_id || `stronk-pi-${process.pid}`,
    transcript_path: context.transcript_path || null,
    cwd: firstString(event.cwd, ctx.cwd) || process.cwd(),
    hook_event_name: hookEventName,
    model: context.model || 'stronk-pi',
    permission_mode: context.permission_mode || 'default',
  };
}

function codexToolName(toolName) {
  if (toolName === 'bash') return 'shell_command';
  if (toolName === 'write') return 'Write';
  if (toolName === 'edit') return 'Edit';
  return toolName || '';
}

function codexHookInput(hookEventName, event = {}, ctx = {}) {
  const base = codexHookBase(hookEventName, event, ctx);
  if (hookEventName === 'SessionStart') {
    const { turn_id: _turnId, ...sessionBase } = base;
    return {
      ...sessionBase,
      source: codexSessionStartSource(event),
    };
  }
  if (hookEventName === 'UserPromptSubmit') {
    return {
      ...base,
      prompt: firstString(event.text, event.prompt, event.message) || '',
    };
  }
  if (hookEventName === 'PermissionRequest') {
    const toolName = codexToolName(firstString(event.toolName, event.tool_name));
    return {
      ...base,
      tool_name: toolName,
      tool_input: event.input ?? {},
    };
  }
  if (hookEventName === 'PostToolUse') {
    const toolName = codexToolName(firstString(event.toolName, event.tool_name));
    return {
      ...base,
      tool_name: toolName,
      tool_input: event.input ?? {},
      tool_response: {
        content: event.content ?? [],
        details: event.details ?? null,
        isError: Boolean(event.isError),
      },
      tool_use_id: firstString(event.toolCallId, event.toolUseId, event.tool_use_id) || base.turn_id,
    };
  }
  if (hookEventName === 'Stop') {
    return {
      ...base,
      stop_hook_active: Boolean(event.stopHookActive || event.stop_hook_active),
      last_assistant_message: latestAssistantMessage(event) || null,
    };
  }
  return base;
}

function codexHookSpecific(payload) {
  return payload && typeof payload === 'object' && payload.hookSpecificOutput && typeof payload.hookSpecificOutput === 'object'
    ? payload.hookSpecificOutput
    : {};
}

function codexHookReason(payload, fallback) {
  const specific = codexHookSpecific(payload);
  for (const key of ['reason', 'message', 'permissionDecisionReason', 'additionalContext']) {
    if (typeof specific[key] === 'string' && specific[key].trim()) return specific[key].trim();
  }
  for (const key of ['reason', 'message', 'stopReason', 'systemMessage']) {
    if (typeof payload?.[key] === 'string' && payload[key].trim()) return payload[key].trim();
  }
  return fallback;
}

function hasCodexHookDecision(payload) {
  const specific = codexHookSpecific(payload);
  return typeof payload?.continue === 'boolean'
    || typeof payload?.allow === 'boolean'
    || typeof payload?.decision === 'string'
    || typeof specific.permissionDecision === 'string'
    || typeof specific.additionalContext === 'string'
    || typeof specific.decision?.behavior === 'string';
}

function hasCodexHookAuthorizationDecision(payload) {
  const specific = codexHookSpecific(payload);
  return typeof payload?.continue === 'boolean'
    || typeof payload?.allow === 'boolean'
    || typeof payload?.decision === 'string'
    || typeof specific.permissionDecision === 'string'
    || typeof specific.decision?.behavior === 'string';
}

function codexHookDecisionStrings(payload) {
  const specific = codexHookSpecific(payload);
  return [payload?.decision, specific.permissionDecision, specific.decision?.behavior]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim().toLowerCase());
}

function permissionRequestShouldBlock(payload) {
  if (payload?.continue === false || payload?.allow === false) return true;

  let explicitlyAllowed = payload?.continue === true || payload?.allow === true;
  for (const decision of codexHookDecisionStrings(payload)) {
    if (CODEX_PERMISSION_BLOCK_DECISIONS.has(decision)) return true;
    if (CODEX_PERMISSION_ALLOW_DECISIONS.has(decision)) {
      explicitlyAllowed = true;
      continue;
    }
    throw new Error(`PermissionRequest helper returned unknown authorization decision: ${decision}`);
  }

  if (explicitlyAllowed) return false;
  throw new Error('PermissionRequest helper returned missing authorization decision');
}

function parseCodexHookStdout(stdout, hookEventName) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) {
    if (CODEX_HOOK_FAIL_CLOSED_EVENTS.has(hookEventName)) {
      throw new Error(`${hookEventName} helper returned missing keys`);
    }
    return { block: false, reason: '', additionalContext: [] };
  }
  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    throw new Error(`${hookEventName} helper returned malformed JSON`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${hookEventName} helper returned non-object JSON`);
  }
  if (CODEX_HOOK_FAIL_CLOSED_EVENTS.has(hookEventName) && !hasCodexHookDecision(payload)) {
    throw new Error(`${hookEventName} helper returned missing keys`);
  }
  if (hookEventName === 'PermissionRequest' && !hasCodexHookAuthorizationDecision(payload)) {
    throw new Error(`${hookEventName} helper returned missing authorization decision`);
  }
  const specific = codexHookSpecific(payload);
  const additionalContext = [];
  if (typeof specific.additionalContext === 'string' && specific.additionalContext.trim()) {
    additionalContext.push(specific.additionalContext.trim());
  }
  if (hookEventName === 'PermissionRequest') {
    const shouldBlock = permissionRequestShouldBlock(payload);
    return {
      block: shouldBlock,
      reason: codexHookReason(payload, `${hookEventName} hook blocked processing`),
      additionalContext,
    };
  }
  const decision = String(payload.decision || specific.decision?.behavior || specific.permissionDecision || '').toLowerCase();
  const shouldBlock = payload.continue === false || payload.allow === false || ['block', 'deny', 'ask'].includes(decision);
  return {
    block: shouldBlock,
    reason: codexHookReason(payload, `${hookEventName} hook blocked processing`),
    additionalContext,
  };
}

async function emitCodexHook(hookEventName, event = {}, ctx = {}) {
  const payload = codexHookInput(hookEventName, event, ctx);
  try {
    const stdout = await runHelper('codex-hook', payload);
    return parseCodexHookStdout(stdout, hookEventName);
  } catch (error) {
    if (CODEX_HOOK_FAIL_CLOSED_EVENTS.has(hookEventName)) {
      const reason = `${hookEventName} hook failed: ${error?.message ?? String(error)}`;
      return { block: true, reason, additionalContext: [], error: error?.message ?? String(error) };
    }
    // Non-safety lifecycle hooks are best-effort. PreToolUse remains fail-closed
    // through handleToolCall/handleUserBash and the Python guard.
    return { block: false, reason: '', additionalContext: [], error: error?.message ?? String(error) };
  }
}

function notifyBlock(ctx, reason) {
  if (ctx?.hasUI && ctx.ui && typeof ctx.ui.notify === 'function') {
    try {
      ctx.ui.notify(reason, 'warning');
    } catch {
      // UI notifications are advisory.
    }
  }
}

function pathIsInside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function parseSkillRoots(raw = process.env.STRONK_PI_SKILL_ROOTS) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('STRONK_PI_SKILL_ROOTS must be a JSON array');
  }
  if (!Array.isArray(parsed)) throw new Error('STRONK_PI_SKILL_ROOTS must be a JSON array');
  const roots = [];
  const seen = new Set();
  for (const item of parsed) {
    const path = typeof item === 'string' ? item : item?.path;
    const scope = typeof item === 'object' && typeof item?.scope === 'string' ? item.scope : 'user';
    if (typeof path !== 'string' || !path.trim()) continue;
    let resolved;
    try {
      resolved = realpathSync(path);
      if (!statSync(resolved).isDirectory()) continue;
    } catch {
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    roots.push({ path: resolved, scope: SKILL_SCOPE_RANK.has(scope) ? scope : 'user' });
  }
  return roots;
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseSkillMetadata(contents, skillPath) {
  const frontmatter = contents.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const metadata = {
    name: basename(resolve(skillPath, '..')),
    description: undefined,
  };
  if (frontmatter) {
    const nameMatch = frontmatter[1].match(/^name:\s*(.+?)\s*$/m);
    if (nameMatch) {
      const name = stripQuotes(nameMatch[1]);
      if (name) metadata.name = name;
    }
    const descriptionMatch = frontmatter[1].match(/^description:\s*(.+?)\s*$/m);
    if (descriptionMatch) {
      const description = stripQuotes(descriptionMatch[1]);
      if (description) metadata.description = description;
    }
  }
  return metadata;
}

function readSkillMetadataSnippet(skillPath) {
  const fd = openSync(skillPath, 'r');
  try {
    const buffer = Buffer.alloc(MAX_SKILL_METADATA_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const snippet = buffer.toString('utf8', 0, bytesRead);
    const frontmatter = snippet.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
    return frontmatter ? frontmatter[0] : '';
  } finally {
    closeSync(fd);
  }
}

function discoverSkillsFromRoot(root, { includeContents = true } = {}) {
  const skills = [];
  const queue = [{ dir: root.path, depth: 0 }];
  const visited = new Set([root.path]);
  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const candidate = join(dir, entry.name);
      let resolved;
      let stats;
      try {
        resolved = realpathSync(candidate);
        stats = statSync(candidate);
      } catch {
        continue;
      }
      const visiblePath = resolve(candidate);
      const visibleInsideRoot = pathIsInside(root.path, visiblePath);
      const resolvedInsideRoot = pathIsInside(root.path, resolved);
      if (!visibleInsideRoot) continue;
      if (stats.isDirectory()) {
        if (!resolvedInsideRoot) continue;
        if (depth >= MAX_SKILL_SCAN_DEPTH || visited.has(resolved)) continue;
        visited.add(resolved);
        queue.push({ dir: resolved, depth: depth + 1 });
        continue;
      }
      if (!stats.isFile() || entry.name !== SKILL_FILENAME) continue;
      if (!resolvedInsideRoot && root.scope !== 'user') continue;
      let contents;
      try {
        contents = includeContents ? readFileSync(visiblePath, 'utf8') : readSkillMetadataSnippet(visiblePath);
      } catch {
        continue;
      }
      const metadata = parseSkillMetadata(contents, visiblePath);
      const skill = {
        ...metadata,
        path: visiblePath,
        realPath: resolved,
        scope: root.scope,
      };
      if (includeContents) skill.contents = contents;
      skills.push(skill);
    }
  }
  return skills;
}

function loadSkillInventory(rawRoots = process.env.STRONK_PI_SKILL_ROOTS) {
  const roots = parseSkillRoots(rawRoots);
  const skills = [];
  const seenPaths = new Set();
  for (const root of roots) {
    for (const skill of discoverSkillsFromRoot(root)) {
      if (seenPaths.has(skill.path)) continue;
      seenPaths.add(skill.path);
      skills.push(skill);
    }
  }
  skills.sort((a, b) => {
    const scopeDelta = (SKILL_SCOPE_RANK.get(a.scope) ?? 1) - (SKILL_SCOPE_RANK.get(b.scope) ?? 1);
    if (scopeDelta !== 0) return scopeDelta;
    const nameDelta = a.name.localeCompare(b.name);
    if (nameDelta !== 0) return nameDelta;
    return a.path.localeCompare(b.path);
  });
  return { roots, skills };
}

function loadSkillCatalog(rawRoots = process.env.STRONK_PI_SKILL_ROOTS) {
  const roots = parseSkillRoots(rawRoots);
  const skills = [];
  const seenPaths = new Set();
  for (const root of roots) {
    for (const skill of discoverSkillsFromRoot(root, { includeContents: false })) {
      if (seenPaths.has(skill.path)) continue;
      seenPaths.add(skill.path);
      skills.push(skill);
    }
  }
  skills.sort((a, b) => {
    const scopeDelta = (SKILL_SCOPE_RANK.get(a.scope) ?? 1) - (SKILL_SCOPE_RANK.get(b.scope) ?? 1);
    if (scopeDelta !== 0) return scopeDelta;
    const nameDelta = a.name.localeCompare(b.name);
    if (nameDelta !== 0) return nameDelta;
    return a.path.localeCompare(b.path);
  });
  return { roots, skills };
}

function isMentionNameChar(ch) {
  return Boolean(ch) && /[A-Za-z0-9_:-]/.test(ch);
}

function isCommonEnvVar(name) {
  return COMMON_ENV_VARS.has(String(name).toUpperCase());
}

function isWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isNonSkillLinkPath(path) {
  return NON_SKILL_LINK_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function normalizeSkillPathPrefix(path) {
  return path.startsWith(SKILL_PATH_PREFIX) ? path.slice(SKILL_PATH_PREFIX.length) : path;
}

function canonicalizePossiblyMissingPath(absolutePath) {
  try {
    return realpathSync(absolutePath);
  } catch {
    // Canonicalize the nearest existing ancestor so macOS /var-style symlinks do
    // not make a missing child under an allowed root look like an escape.
  }
  const missingParts = [];
  let current = absolutePath;
  while (current && dirname(current) !== current) {
    missingParts.unshift(basename(current));
    current = dirname(current);
    try {
      return resolve(realpathSync(current), ...missingParts);
    } catch {
      // Keep walking toward the filesystem root.
    }
  }
  return absolutePath;
}

function parseLinkedToolMention(text, start) {
  if (text[start] !== '[' || text[start + 1] !== '$') return undefined;
  let index = start + 2;
  if (!isMentionNameChar(text[index])) return undefined;
  const nameStart = index;
  while (isMentionNameChar(text[index])) index += 1;
  const name = text.slice(nameStart, index);
  if (text[index] !== ']') return undefined;
  index += 1;
  while (isWhitespace(text[index])) index += 1;
  if (text[index] !== '(') return undefined;
  index += 1;
  const pathStart = index;
  while (index < text.length && text[index] !== ')') index += 1;
  if (text[index] !== ')') return undefined;
  const path = text.slice(pathStart, index).trim();
  if (!path) return undefined;
  return { name, path, endIndex: index + 1 };
}

function extractToolMentions(text) {
  const names = new Set();
  const paths = new Set();
  const plainNames = new Set();
  const linkedMentions = [];
  let index = 0;
  while (index < text.length) {
    const linked = parseLinkedToolMention(text, index);
    if (linked) {
      linkedMentions.push(linked);
      if (!isCommonEnvVar(linked.name)) {
        if (!isNonSkillLinkPath(linked.path)) names.add(linked.name);
        paths.add(linked.path);
      }
      index = linked.endIndex;
      continue;
    }
    if (text[index] !== '$') {
      index += 1;
      continue;
    }
    const nameStart = index + 1;
    if (!isMentionNameChar(text[nameStart])) {
      index += 1;
      continue;
    }
    let nameEnd = nameStart + 1;
    while (isMentionNameChar(text[nameEnd])) nameEnd += 1;
    const name = text.slice(nameStart, nameEnd);
    if (!isCommonEnvVar(name)) {
      names.add(name);
      plainNames.add(name);
    }
    index = nameEnd;
  }
  return { names, paths, plainNames, linkedMentions };
}

function normalizeLinkedSkillPath(rawPath, roots, cwd) {
  if (isNonSkillLinkPath(rawPath)) return undefined;
  const withoutPrefix = normalizeSkillPathPrefix(rawPath);
  const absolute = isAbsolute(withoutPrefix) ? resolve(withoutPrefix) : resolve(cwd, withoutPrefix);
  if (basename(absolute).toLowerCase() !== SKILL_FILENAME.toLowerCase()) {
    throw new Error(`linked skill path must target ${SKILL_FILENAME}: ${rawPath}`);
  }
  const visibleRoot = roots.find((root) => pathIsInside(root.path, absolute));
  if (visibleRoot) {
    const resolved = canonicalizePossiblyMissingPath(absolute);
    if (pathIsInside(visibleRoot.path, resolved)) return resolved;
    const resolvedParent = canonicalizePossiblyMissingPath(dirname(absolute));
    if (visibleRoot.scope === 'user' && pathIsInside(visibleRoot.path, resolvedParent)) {
      return absolute;
    }
    throw new Error(`linked skill path is outside controlled skill roots: ${rawPath}`);
  }
  const resolved = canonicalizePossiblyMissingPath(absolute);
  if (!roots.some((root) => pathIsInside(root.path, resolved))) {
    throw new Error(`linked skill path is outside controlled skill roots: ${rawPath}`);
  }
  return resolved;
}

function selectMentionedSkills(text, inventory, cwd = process.cwd()) {
  const mentions = extractToolMentions(text);
  if (mentions.names.size === 0 && mentions.paths.size === 0) return [];
  const linkedSkillNamesByPath = new Map();
  for (const mention of mentions.linkedMentions) {
    const normalized = normalizeLinkedSkillPath(mention.path, inventory.roots, cwd);
    if (!normalized) continue;
    let names = linkedSkillNamesByPath.get(normalized);
    if (!names) {
      names = new Set();
      linkedSkillNamesByPath.set(normalized, names);
    }
    names.add(mention.name);
  }

  const selected = [];
  const seenPaths = new Set();
  const seenNames = new Set();
  const nameCounts = new Map();
  for (const skill of inventory.skills) {
    nameCounts.set(skill.name, (nameCounts.get(skill.name) ?? 0) + 1);
  }

  for (const skill of inventory.skills) {
    const linkedNames = linkedSkillNamesByPath.get(skill.path);
    if (!linkedNames || seenPaths.has(skill.path)) continue;
    if (!linkedNames.has(skill.name) || linkedNames.size !== 1) {
      throw new Error(`linked mention display name mismatch for ${skill.path}`);
    }
    seenPaths.add(skill.path);
    seenNames.add(skill.name);
    selected.push(skill);
  }

  for (const skill of inventory.skills) {
    if (seenPaths.has(skill.path)) continue;
    if (!mentions.plainNames.has(skill.name)) continue;
    if ((nameCounts.get(skill.name) ?? 0) !== 1) continue;
    if (!seenNames.has(skill.name)) {
      seenNames.add(skill.name);
      seenPaths.add(skill.path);
      selected.push(skill);
    }
  }
  return selected;
}

function formatSkillBlock(skill) {
  return `<skill>\n<name>${skill.name}</name>\n<path>${skill.path}</path>\n${skill.contents}\n</skill>`;
}

function buildSkillInjectionContext(text, options = {}) {
  if (typeof text !== 'string' || !text.includes('$')) return { blocks: [], warnings: [] };
  const inventory = loadSkillInventory(options.rootsJson ?? process.env.STRONK_PI_SKILL_ROOTS);
  const selected = selectMentionedSkills(text, inventory, resolve(options.cwd || process.cwd()));
  const blocks = [];
  const warnings = [];
  for (const skill of selected) {
    if (hasSensitiveString(skill.contents)) {
      warnings.push(`Skipped skill ${skill.name} because ${SKILL_FILENAME} contains secret-like content`);
      continue;
    }
    blocks.push(formatSkillBlock(skill));
  }
  return { blocks, warnings };
}

function extractSkillAutocompleteContext(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  let tokenStart = text.length;
  while (tokenStart > 0 && !isWhitespace(text[tokenStart - 1])) tokenStart -= 1;
  const token = text.slice(tokenStart);
  if (!token.startsWith('$')) return null;
  if (!/^\$[A-Za-z0-9_:-]*$/.test(token)) return null;
  const partial = token.slice(1);
  return {
    prefix: token,
    partial,
    suppressed: partial.length > 0 && isCommonEnvVar(partial),
  };
}

function formatSkillAutocompleteDescription(skill, isDuplicate) {
  const parts = [];
  if (isDuplicate) parts.push(skill.scope);
  if (skill.description) parts.push(skill.description);
  parts.push(skill.path);
  return parts.join(' · ');
}

function buildSkillAutocompleteSuggestions(textBeforeCursor, options = {}) {
  const context = extractSkillAutocompleteContext(textBeforeCursor);
  if (!context || context.suppressed) return null;

  let catalog;
  try {
    catalog = loadSkillCatalog(options.rootsJson ?? process.env.STRONK_PI_SKILL_ROOTS);
  } catch {
    return null;
  }
  if (!catalog.skills.length) return null;

  const query = context.partial.toLowerCase();
  const nameCounts = new Map();
  for (const skill of catalog.skills) {
    nameCounts.set(skill.name, (nameCounts.get(skill.name) ?? 0) + 1);
  }

  const items = [];
  for (const skill of catalog.skills) {
    if (query && !skill.name.toLowerCase().startsWith(query)) continue;

    const isDuplicate = (nameCounts.get(skill.name) ?? 0) > 1;
    items.push({
      value: isDuplicate ? `[$${skill.name}](skill://${skill.path}) ` : `$${skill.name} `,
      label: isDuplicate ? `${skill.name} [${skill.scope}]` : skill.name,
      description: formatSkillAutocompleteDescription(skill, isDuplicate),
    });

    if (items.length >= MAX_SKILL_AUTOCOMPLETE_ITEMS) break;
  }

  if (!items.length) return null;
  return { items, prefix: context.prefix };
}

function applySkillAutocompleteCompletion(lines, cursorLine, cursorCol, item, prefix) {
  const currentLine = lines[cursorLine] || '';
  const tokenStart = Math.max(0, cursorCol - prefix.length);
  let tokenEnd = cursorCol;
  while (tokenEnd < currentLine.length && isMentionNameChar(currentLine[tokenEnd])) tokenEnd += 1;
  const beforeToken = currentLine.slice(0, tokenStart);
  const afterToken = currentLine.slice(tokenEnd);
  const newLine = `${beforeToken}${item.value}${afterToken}`;
  const newLines = [...lines];
  newLines[cursorLine] = newLine;
  return {
    lines: newLines,
    cursorLine,
    cursorCol: beforeToken.length + item.value.length,
  };
}

function createSkillAutocompleteProvider(current, options = {}) {
  const rootsJson = options.rootsJson ?? process.env.STRONK_PI_SKILL_ROOTS;
  return {
    triggerCharacters: ['$'],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const currentLine = lines[cursorLine] || '';
      const textBeforeCursor = currentLine.slice(0, cursorCol);
      const context = extractSkillAutocompleteContext(textBeforeCursor);
      if (!context) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }
      if (context.suppressed) return null;
      return buildSkillAutocompleteSuggestions(textBeforeCursor, { ...options, rootsJson }) ?? null;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (extractSkillAutocompleteContext(prefix)) {
        return applySkillAutocompleteCompletion(lines, cursorLine, cursorCol, item, prefix);
      }
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      const currentLine = lines[cursorLine] || '';
      const context = extractSkillAutocompleteContext(currentLine.slice(0, cursorCol));
      if (context) return !context.suppressed;
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

function installSkillAutocompleteProvider(ctx = {}) {
  if (!ctx?.hasUI || !ctx.ui || typeof ctx.ui.addAutocompleteProvider !== 'function') return false;
  if (registeredSkillAutocompleteUIs.has(ctx.ui)) return false;
  const rootsJson = process.env.STRONK_PI_SKILL_ROOTS;
  ctx.ui.addAutocompleteProvider((current) => createSkillAutocompleteProvider(current, { rootsJson }));
  registeredSkillAutocompleteUIs.add(ctx.ui);
  return true;
}

async function handleInput(event, ctx = {}) {
  const before = canonical(event ?? {});
  const decision = await emitCodexHook('UserPromptSubmit', event, ctx);
  if (canonical(event ?? {}) !== before) {
    notifyBlock(ctx, 'UserPromptSubmit payload mutated during hook evaluation');
    return { action: 'handled' };
  }
  if (decision.block) {
    notifyBlock(ctx, decision.reason);
    return { action: 'handled' };
  }
  if (typeof event?.text !== 'string') return undefined;

  let skillContext;
  try {
    skillContext = buildSkillInjectionContext(event.text, {
      cwd: firstString(event.cwd, ctx.cwd) || process.cwd(),
    });
  } catch (error) {
    const reason = error?.message ?? String(error);
    notifyBlock(ctx, reason);
    return { action: 'handled' };
  }

  const appendedContexts = [];
  if (decision.additionalContext.length > 0) {
    appendedContexts.push(`Additional context from Stronk Pi hooks:\n${decision.additionalContext.join('\n\n')}`);
  }
  appendedContexts.push(...skillContext.blocks);

  if (appendedContexts.length > 0) {
    return {
      action: 'transform',
      text: `${event.text}\n\n${appendedContexts.join('\n\n')}`,
      images: event.images,
    };
  }
  return undefined;
}

async function handleSessionStart(event, ctx = {}) {
  rememberInteractiveResumeHintSession(ctx);
  installSkillAutocompleteProvider(ctx);
  await emitCodexHook('SessionStart', event, ctx);
  await notify({ type: 'session_start', event: redact(event), cwd: process.cwd() });
}

async function handleToolResult(event, ctx = {}) {
  const decision = await emitCodexHook('PostToolUse', event, ctx);
  await notify({ type: 'tool_result', event: redact(event), cwd: process.cwd() });
  if (!decision.block) return undefined;
  const text = `Stronk Pi PostToolUse hook blocked processing: ${decision.reason}`;
  return {
    content: [...(Array.isArray(event.content) ? event.content : []), { type: 'text', text }],
    details: event.details,
    isError: true,
  };
}

async function handleAgentEnd(event, ctx = {}) {
  const decision = await emitCodexHook('Stop', event, ctx);
  if (decision.block) notifyBlock(ctx, decision.reason);
  await notify({ type: 'agent_end', event: redact(event), cwd: process.cwd() });
}

async function handlePermissionRequest(event, ctx = {}) {
  const before = canonical(event ?? {});
  const decision = await emitCodexHook('PermissionRequest', event, ctx);
  if (canonical(event ?? {}) !== before) {
    return { block: true, reason: 'PermissionRequest payload mutated during hook evaluation' };
  }
  if (!decision.block) return undefined;
  return { block: true, reason: decision.reason };
}

function toolResult(text, details = {}) {
  return {
    content: [{ type: 'text', text }],
    details,
  };
}

function normalizeToolArgs(args) {
  if (args.length >= 5) {
    return {
      toolCallId: args[0],
      params: args[1] ?? {},
      signal: args[2],
      onUpdate: args[3],
      ctx: args[4] ?? {},
    };
  }
  return {
    toolCallId: '',
    params: args[0] ?? {},
    signal: args[1],
    onUpdate: args[2],
    ctx: args[3] ?? {},
  };
}

function normalizedString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.startsWith('@') ? value.slice(1) : value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function cwdFromContext(ctx) {
  return realpathSync(resolve(String(ctx?.cwd || process.cwd())));
}

function resolveInsideCwd(cwd, candidate = '.') {
  const cleaned = typeof candidate === 'string' && candidate.startsWith('@') ? candidate.slice(1) : candidate;
  const target = isAbsolute(cleaned) ? resolve(cleaned) : resolve(cwd, cleaned || '.');
  const lexicalRel = relative(cwd, target);
  if (lexicalRel === '..' || lexicalRel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(lexicalRel)) {
    throw new Error(`path escapes current project: ${candidate}`);
  }
  const resolvedTarget = realpathSync(target);
  const realRel = relative(cwd, resolvedTarget);
  if (realRel === '..' || realRel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(realRel)) {
    throw new Error(`path escapes current project: ${candidate}`);
  }
  return resolvedTarget;
}

function spawnCollect(command, args, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 5000);
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener?.('abort', onAbort);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      child.kill('SIGTERM');
      finishReject(new Error(`${command} was aborted`));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finishReject(new Error(`${command} timed out`));
    }, timeoutMs);

    options.signal?.addEventListener?.('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', finishReject);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveProcess({ code, stdout, stderr });
    });
  });
}

function globPatternToRegex(pattern) {
  const normalized = pattern.replace(/\\/g, '/');
  let source = normalized.includes('/') ? '^' : '^(?:.*/)?';
  for (let index = 0; index < normalized.length;) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        if (normalized[index + 2] === '/') {
          source += '(?:[^/]+/)*';
          index += 3;
        } else {
          source += '.*';
          index += 2;
        }
        continue;
      }
      source += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }
    source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    index += 1;
  }
  source += '$';
  return new RegExp(source);
}

function hasHiddenPathSegment(relPath) {
  return relPath.split('/').some((segment) => segment.startsWith('.'));
}

function fallbackGlobFiles(searchRoot, pattern, includeHidden, options = {}) {
  const matcher = globPatternToRegex(pattern);
  const deadline = Date.now() + (Number.isFinite(options.timeoutMs) ? options.timeoutMs : 5000);
  const files = [];
  const stack = ['.'];
  while (stack.length > 0) {
    if (options.signal?.aborted) throw new Error('glob fallback aborted');
    if (Date.now() > deadline) throw new Error('glob fallback timed out');
    const relDir = stack.pop();
    const absDir = relDir === '.' ? searchRoot : join(searchRoot, relDir);
    const entries = readdirSync(absDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries.reverse()) {
      if (entry.name === '.git') continue;
      if (!includeHidden && entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) continue;
      const relPath = relDir === '.' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        stack.push(relPath);
        continue;
      }
      if (entry.isFile() && matcher.test(relPath)) {
        files.push(relPath);
      }
    }
  }
  return files.sort();
}

async function executeGlobWithCommand(params, signal, ctx, command) {
  const cwd = cwdFromContext(ctx);
  const pattern = normalizedString(params.pattern, 'glob pattern');
  const searchRoot = resolveInsideCwd(cwd, params.path || '.');
  accessSync(searchRoot, constants.R_OK);
  const maxResults = Math.max(1, Math.min(Number(params.maxResults || 200), 1000));
  const args = ['--files', '--glob', pattern, '--glob', '!.git/**', '--sort', 'path'];
  if (params.includeHidden) args.unshift('--hidden');
  let rawFiles;
  try {
    const proc = await spawnCollect(command, args, { cwd: searchRoot, signal, timeoutMs: 5000 });
    if (proc.code !== 0 && proc.stdout.trim() === '') {
      throw new Error(`glob failed: ${redact(proc.stderr).trim() || `rg exited ${proc.code}`}`);
    }
    rawFiles = proc.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => params.includeHidden || !hasHiddenPathSegment(line));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    rawFiles = fallbackGlobFiles(searchRoot, pattern, Boolean(params.includeHidden), {
      maxResults,
      signal,
      timeoutMs: 5000,
    });
  }
  const rootRel = relative(cwd, searchRoot);
  const files = rawFiles
    .map((line) => (rootRel ? `${rootRel}/${line}` : line))
    .slice(0, maxResults);
  const output = files.length ? files.join('\n') : '(no matches)';
  return toolResult(output, {
    pattern,
    path: rootRel || '.',
    count: files.length,
    truncated: rawFiles.length > files.length,
  });
}

async function executeGlob(params, signal, ctx) {
  return executeGlobWithCommand(params, signal, ctx, 'rg');
}

function normalizeTodoItem(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`todo ${index + 1} must be an object`);
  }
  const content = requiredString(item.content, `todo ${index + 1} content`).trim();
  const status = item.status || 'pending';
  const priority = item.priority || 'medium';
  if (!TODO_STATUSES.has(status)) throw new Error(`todo ${index + 1} has invalid status: ${status}`);
  if (!TODO_PRIORITIES.has(priority)) throw new Error(`todo ${index + 1} has invalid priority: ${priority}`);
  const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `todo-${index + 1}`;
  return { id, content, status, priority };
}

function normalizeTodos(rawTodos) {
  if (!Array.isArray(rawTodos)) throw new Error('todos must be an array');
  if (rawTodos.length > 100) throw new Error('todos must contain 100 items or fewer');
  return rawTodos.map(normalizeTodoItem);
}

function formatTodos(todos) {
  if (!todos.length) return '(no todos)';
  return todos
    .map((todo) => `- [${todo.status}] (${todo.priority}) ${todo.id}: ${todo.content}`)
    .join('\n');
}

function executeTodoWrite(params, state) {
  const todos = normalizeTodos(params.todos);
  state.todos = todos;
  return toolResult(formatTodos(todos), { todos: [...todos], count: todos.length });
}

function executeTodoRead(state) {
  const todos = state.todos || [];
  return toolResult(formatTodos(todos), { todos: [...todos], count: todos.length });
}

async function executeQuestion(params, _signal, ctx) {
  const question = requiredString(params.question, 'question');
  const header = typeof params.header === 'string' && params.header.trim() ? params.header.trim() : 'Question';
  const options = Array.isArray(params.options)
    ? params.options
      .filter((option) => option && typeof option === 'object' && typeof option.label === 'string' && option.label.trim())
      .map((option) => option.description ? `${option.label.trim()} - ${option.description.trim()}` : option.label.trim())
      .slice(0, 8)
    : [];
  const timeout = Number(params.timeoutMs || 0);
  const dialogOptions = timeout > 0 ? { timeout } : undefined;

  if (!ctx?.hasUI || !ctx.ui) {
    return toolResult(
      `QUESTION: ${question}\n\nNo interactive Pi UI is available in this mode. Ask the operator directly in chat.`,
      { question, answer: undefined, ui: false },
    );
  }

  let answer;
  if (options.length > 0) {
    answer = await ctx.ui.select(header, options, dialogOptions);
  }
  if ((answer === undefined || answer === '') && params.allowFreeform !== false) {
    answer = await ctx.ui.input(header, question, dialogOptions);
  }
  return toolResult(answer ? `ANSWER: ${answer}` : 'ANSWER: <no response>', {
    question,
    answer,
    ui: true,
  });
}

async function checkPublicUrl(url) {
  const stdout = await runHelper('url-check', { url });
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('url-check helper returned malformed JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('url-check helper returned non-object JSON');
  }
  if (parsed.allow !== true) {
    throw new Error(parsed.reason || 'URL denied by Stronk Pi guard');
  }
  if (typeof parsed.url !== 'string' || !Array.isArray(parsed.addresses) || parsed.addresses.length === 0) {
    throw new Error('url-check helper returned missing keys');
  }
  const address = parsed.addresses.find((item) => (
    item
    && typeof item.address === 'string'
    && (item.family === 4 || item.family === 6)
  ));
  if (!address) throw new Error('url-check helper returned no usable address');
  return { url: parsed.url, address };
}

function requestUrlWithCheckedAddress(checked, signal) {
  return new Promise((resolveRequest, reject) => {
    const url = new URL(checked.url);
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const req = request({
      protocol: url.protocol,
      hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      servername: hostname,
      headers: {
        Host: url.host,
        'User-Agent': 'Stronk-Pi/1.0 (+https://github.com/EYYCHEEV/stronk-pi)',
        Accept: 'text/html,text/plain,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'identity',
      },
      lookup: (_lookupHost, options, callback) => {
        if (options?.all) {
          callback(null, [{ address: checked.address.address, family: checked.address.family }]);
          return;
        }
        callback(null, checked.address.address, checked.address.family);
      },
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      const location = response.headers.location;
      if (statusCode >= 300 && statusCode < 400 && typeof location === 'string' && location.trim()) {
        response.resume();
        resolveRequest({
          redirect: new URL(location, checked.url).toString(),
          statusCode,
        });
        return;
      }

      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_FETCH_BYTES) {
          req.destroy(new Error(`${SAFE_FETCH_TOOL} response exceeds ${MAX_FETCH_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        resolveRequest({
          statusCode,
          statusMessage: response.statusMessage || '',
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => req.destroy(new Error(`${SAFE_FETCH_TOOL} was aborted`));
    const timer = setTimeout(() => req.destroy(new Error(`${SAFE_FETCH_TOOL} timed out`)), 15000);

    signal?.addEventListener?.('abort', onAbort, { once: true });
    req.on('error', fail);
    req.on('close', cleanup);
    req.end();
  });
}

async function safeFetchUrl(rawUrl, signal) {
  let current = requiredString(rawUrl, 'url');
  const visited = [];
  for (let redirects = 0; redirects <= MAX_FETCH_REDIRECTS; redirects += 1) {
    const checked = await checkPublicUrl(current);
    visited.push(checked.url);
    const result = await requestUrlWithCheckedAddress(checked, signal);
    if (result.redirect) {
      current = result.redirect;
      continue;
    }
    return {
      ...result,
      finalUrl: checked.url,
      redirects: visited.slice(0, -1),
    };
  }
  throw new Error(`${SAFE_FETCH_TOOL} exceeded ${MAX_FETCH_REDIRECTS} redirects`);
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function htmlToText(html) {
  return decodeHtmlEntities(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function extractTitle(body, fallbackUrl) {
  const match = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return fallbackUrl;
  const title = decodeHtmlEntities(match[1].replace(/\s+/g, ' ').trim());
  return title || fallbackUrl;
}

function formatFetchedContent(result) {
  const contentType = String(result.headers?.['content-type'] || '');
  const isHtml = /html|xml/i.test(contentType);
  const title = isHtml ? extractTitle(result.body, result.finalUrl) : result.finalUrl;
  const text = isHtml ? htmlToText(result.body) : result.body.trim();
  const body = text.length > 0 ? text : '(empty response)';
  return {
    title,
    text: `# ${title}\n\nSource: ${result.finalUrl}\n\n${body}`,
  };
}

function normalizeFetchUrls(params) {
  const urls = Array.isArray(params.urls) ? params.urls : (params.url ? [params.url] : []);
  if (urls.length === 0) throw new Error(`${SAFE_FETCH_TOOL} requires url or urls`);
  if (urls.length > 5) throw new Error(`${SAFE_FETCH_TOOL} accepts at most 5 URLs`);
  return urls.map((url, index) => requiredString(url, `url ${index + 1}`));
}

async function executeFetchContent(params, signal, onUpdate) {
  const urls = normalizeFetchUrls(params);
  const results = [];
  for (let index = 0; index < urls.length; index += 1) {
    onUpdate?.({
      content: [{ type: 'text', text: `Fetching ${index + 1}/${urls.length}: ${urls[index]}` }],
      details: { phase: 'fetch', progress: index / urls.length, url: urls[index] },
    });
    try {
      const raw = await safeFetchUrl(urls[index], signal);
      if (raw.statusCode < 200 || raw.statusCode >= 300) {
        throw new Error(`HTTP ${raw.statusCode}: ${raw.statusMessage || 'request failed'}`);
      }
      const formatted = formatFetchedContent(raw);
      results.push({
        url: urls[index],
        finalUrl: raw.finalUrl,
        statusCode: raw.statusCode,
        title: formatted.title,
        content: formatted.text,
        redirects: raw.redirects,
      });
    } catch (error) {
      results.push({
        url: urls[index],
        error: error?.message ?? String(error),
      });
    }
  }

  const successful = results.filter((result) => !result.error).length;
  if (urls.length === 1) {
    const result = results[0];
    if (result.error) {
      return toolResult(`Error: ${result.error}`, { urls, successful: 0, error: result.error });
    }
    return toolResult(result.content, {
      urls,
      finalUrl: result.finalUrl,
      statusCode: result.statusCode,
      title: result.title,
      redirects: result.redirects,
      successful: 1,
    });
  }

  const output = results.map((result) => {
    if (result.error) return `## ${result.url}\n\nError: ${result.error}`;
    return `## ${result.title}\n\nSource: ${result.finalUrl}\n\n${result.content}`;
  }).join('\n\n---\n\n');
  return toolResult(output, { urls, successful, total: urls.length, results });
}

function registerStronkTools(pi, state = { todos: [] }) {
  if (typeof pi.registerTool !== 'function') return;
  if (facadeEnabled()) {
    const adapter = facadeAdapterMode() === 'intercom'
      ? new PiSubagentsBridgeAdapter({ events: pi.events })
      : undefined;
    const executeFacade = createSubagentFacade(adapter ? { adapter } : {});
    pi.registerTool({
      name: STRONK_SUBAGENT_TOOL,
      label: STRONK_SUBAGENT_TOOL,
      description: 'Run Stronk-managed Pi subagent lifecycle actions through a closed schema and private ledger.',
      promptSnippet: 'Run a guarded Stronk Pi subagent action',
      promptGuidelines: [
        'Use stronk_subagent for Stronk-owned subagent lifecycle actions.',
        'Raw upstream subagent management fields, model/tool overrides, worktrees, chains, and output-path hints are denied.',
      ],
      parameters: stronkSubagentSchema,
      execute: async (...args) => {
        const { params } = normalizeToolArgs(args);
        const result = await executeFacade(params);
        return toolResult(result.text, result.details);
      },
    });
  }
  pi.registerTool({
    name: 'glob',
    label: 'glob',
    description: 'Find files by glob pattern inside the current project. This is the Stronk Pi OpenCode-compatible glob tool.',
    promptSnippet: 'Find files by glob pattern',
    promptGuidelines: ['Use glob when you need to find files by pattern, such as **/*.ts or docs/**/*.md.'],
    parameters: globSchema,
    execute: async (...args) => {
      const { params, signal, ctx } = normalizeToolArgs(args);
      return executeGlob(params, signal, ctx);
    },
  });
  pi.registerTool({
    name: 'todowrite',
    label: 'todowrite',
    description: 'Create or replace the current session todo list for multi-step coding work.',
    promptSnippet: 'Track task progress',
    promptGuidelines: ['Use todowrite to keep visible progress on complex multi-step tasks.'],
    parameters: todoWriteSchema,
    execute: async (...args) => {
      const { params } = normalizeToolArgs(args);
      return executeTodoWrite(params, state);
    },
  });
  pi.registerTool({
    name: 'todoread',
    label: 'todoread',
    description: 'Read the current Stronk Pi session todo list.',
    promptSnippet: 'Read task progress',
    parameters: emptyObjectSchema,
    execute: async () => executeTodoRead(state),
  });
  pi.registerTool({
    name: 'question',
    label: 'question',
    description: 'Ask the operator a structured question with optional choices and freeform fallback.',
    promptSnippet: 'Ask the operator a question',
    promptGuidelines: ['Use question only when operator input is needed to resolve ambiguity or choose between real tradeoffs.'],
    parameters: questionSchema,
    execute: async (...args) => {
      const { params, signal, ctx } = normalizeToolArgs(args);
      return executeQuestion(params, signal, ctx);
    },
  });
  pi.registerTool({
    name: SAFE_FETCH_TOOL,
    label: SAFE_FETCH_TOOL,
    description: 'Fetch public http(s) URLs through the Stronk Pi redirect-aware SSRF guard and return readable text.',
    promptSnippet: 'Fetch readable content from a public URL',
    promptGuidelines: [
      `Use ${SAFE_FETCH_TOOL} for public web pages only.`,
      'Local files, localhost, private networks, metadata endpoints, and unsafe redirects are denied.',
    ],
    parameters: fetchContentSchema,
    execute: async (...args) => {
      const { params, signal, onUpdate } = normalizeToolArgs(args);
      return executeFetchContent(params, signal, onUpdate);
    },
  });
}

function isUnsupportedMutatingTool(toolName) {
  return MUTATING_TOOLS.has(toolName) && !['bash', 'write', 'edit'].includes(toolName);
}

async function handleToolCall(event, ctx = {}) {
  const toolName = event?.toolName;
  if (!toolName) return block('tool_call missing toolName');
  if (isUnsupportedMutatingTool(toolName)) return block(`unsupported mutating tool denied: ${toolName}`);
  if (DISABLED_PLUGIN_TOOLS.has(toolName)) return block(`disabled upstream tool denied: ${toolName}; use ${SAFE_FETCH_TOOL}`);
  if (hasBlockingSensitiveContent(event.input ?? {})) return block('secret literal blocked in tool_call input');

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
      hookContext: piHookContext(event, ctx),
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

async function handleUserBash(event, ctx = {}) {
  const before = String(event?.command ?? '');
  if (hasBlockingSensitiveContent(before)) return deniedBashResult('secret literal blocked in user_bash command');
  let decision;
  try {
    decision = await guardedDecision({
      event: 'user_bash',
      command: event?.command,
      excludeFromContext: Boolean(event?.excludeFromContext),
      cwd: event?.cwd ?? process.cwd(),
      hookContext: piHookContext(event, ctx),
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

function contextHasUI(ctx = {}) {
  try {
    return ctx.hasUI === true;
  } catch {
    return false;
  }
}

function contextSessionManager(ctx = {}) {
  try {
    const sessionManager = ctx?.sessionManager;
    return sessionManager && typeof sessionManager === 'object' ? sessionManager : undefined;
  } catch {
    return undefined;
  }
}

function rememberInteractiveResumeHintSession(ctx = {}) {
  const sessionManager = contextSessionManager(ctx);
  if (!sessionManager || !contextHasUI(ctx)) return false;
  interactiveResumeHintSessionManagers.add(sessionManager);
  return true;
}

function shouldShowSessionResumeHint(ctx = {}) {
  if (contextHasUI(ctx)) return true;
  const sessionManager = contextSessionManager(ctx);
  return Boolean(sessionManager && interactiveResumeHintSessionManagers.has(sessionManager));
}

function sessionManagerString(ctx = {}, methodName) {
  try {
    const sessionManager = contextSessionManager(ctx);
    const method = sessionManager?.[methodName];
    if (typeof method !== 'function') return undefined;
    return firstString(method.call(sessionManager));
  } catch {
    return undefined;
  }
}

function hasReadableSessionFile(sessionFile) {
  if (!sessionFile) return false;
  try {
    accessSync(sessionFile, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function buildSessionResumeHint(event = {}, ctx = {}) {
  if (event?.reason !== 'quit') return undefined;
  if (!shouldShowSessionResumeHint(ctx)) return undefined;

  const sessionId = sessionManagerString(ctx, 'getSessionId');
  if (!sessionId || !RESUME_HINT_SESSION_ID_PATTERN.test(sessionId)) return undefined;

  const sessionFile = sessionManagerString(ctx, 'getSessionFile');
  if (!hasReadableSessionFile(sessionFile)) return undefined;

  return `To continue this session, run pi --session ${sessionId}`;
}

function writeSessionResumeHint(message) {
  process.stderr.write(`${message}\n`);
}

function handleSessionShutdown(event, ctx = {}, write = writeSessionResumeHint) {
  const message = buildSessionResumeHint(event, ctx);
  if (!message) return undefined;
  try {
    write(message);
  } catch {
    // Resume hints are best-effort and must not block shutdown.
  }
  return message;
}

export default async function stronkPi(pi) {
  registerStronkTools(pi);
  pi.on('tool_call', handleToolCall);
  pi.on('user_bash', handleUserBash);
  pi.on('input', handleInput);
  pi.on('session_start', handleSessionStart);
  pi.on('session_shutdown', handleSessionShutdown);
  pi.on('tool_result', handleToolResult);
  pi.on('agent_end', handleAgentEnd);
  pi.on('permission_request', handlePermissionRequest);
  pi.on('turn_end', (event) => {
    void notify({ type: 'turn_end', event: redact(event), cwd: process.cwd() });
  });
}

export const internals = {
  canonical,
  hasSensitiveContent,
  hasBlockingSensitiveContent,
  redact,
  helperArgv,
  runHelper,
  guardedDecision,
  piHookContext,
  codexHookInput,
  parseCodexHookStdout,
  emitCodexHook,
  parseSkillRoots,
  loadSkillInventory,
  loadSkillCatalog,
  extractToolMentions,
  selectMentionedSkills,
  buildSkillInjectionContext,
  extractSkillAutocompleteContext,
  buildSkillAutocompleteSuggestions,
  applySkillAutocompleteCompletion,
  createSkillAutocompleteProvider,
  installSkillAutocompleteProvider,
  registerStronkTools,
  executeGlobWithCommand,
  executeGlob,
  normalizeTodos,
  executeTodoWrite,
  executeTodoRead,
  executeQuestion,
  checkPublicUrl,
  requestUrlWithCheckedAddress,
  safeFetchUrl,
  executeFetchContent,
  createSubagentFacade,
  PiSubagentsBridgeAdapter,
  handleToolCall,
  handleUserBash,
  handleInput,
  handleSessionStart,
  buildSessionResumeHint,
  handleSessionShutdown,
  rememberInteractiveResumeHintSession,
  writeSessionResumeHint,
  handleToolResult,
  handleAgentEnd,
  handlePermissionRequest,
  notify,
};
