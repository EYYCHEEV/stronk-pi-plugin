import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { basename, dirname, join, isAbsolute, relative, resolve } from 'node:path';
import { createSubagentFacade, facadeAdapterMode, facadeEnabled, stronkSubagentSchema } from './subagents/facade.mjs';
import { PiSubagentsBridgeAdapter } from './subagents/adapters/pi-subagents-bridge.mjs';

const SAFE_FETCH_TOOL = 'fetch_content';
const WEB_SEARCH_TOOL = 'web_search';
const CODE_SEARCH_TOOL = 'code_search';
const STRONK_SUBAGENT_TOOL = 'stronk_subagent';
const DISABLED_PLUGIN_TOOLS = new Set(['get_search_content']);
const WEB_TOOLS = new Set([WEB_SEARCH_TOOL, CODE_SEARCH_TOOL, SAFE_FETCH_TOOL]);
const SESSION_TOOLS = new Set(['todowrite', 'todoread', 'question', 'ask_user']);
const INTERCOM_TOOLS = new Set(['intercom', 'contact_supervisor']);
const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'glob', 'todoread']);
const MUTATING_TOOLS = new Set(['bash', 'write', 'edit', 'patch', 'apply_patch', 'multi_edit']);
const PLUGIN_TOOLS = new Set(['mcp', 'subagent', STRONK_SUBAGENT_TOOL, ...WEB_TOOLS, ...SESSION_TOOLS, ...INTERCOM_TOOLS]);
const SEARCH_PROVIDERS = ['exa', 'brave', 'tavily', 'gemini'];
const SEARCH_WORKFLOWS = ['auto', 'summary-review', 'none'];
const SEARCH_WORKFLOW_SET = new Set(SEARCH_WORKFLOWS);
const SEARCH_REVIEW_ACTIONS = ['keep', 'dismiss', 'fetch', 'fetch-kept', 'follow-up', 'finish', 'status'];
const SEARCH_REVIEW_ACTION_SET = new Set(SEARCH_REVIEW_ACTIONS);
const SEARCH_PROVIDER_KEY_ENV = {
  exa: 'EXA_API_KEY',
  brave: 'BRAVE_SEARCH_API_KEY',
  tavily: 'TAVILY_API_KEY',
  gemini: 'GEMINI_API_KEY',
};
const DEFAULT_SEARCH_RESULTS = 5;
const MAX_SEARCH_RESULTS = 10;
const MAX_SEARCH_QUERIES = 15;
const DEFAULT_SEARCH_CONCURRENCY = 3;
const MAX_SEARCH_CONCURRENCY = 3;
const DEFAULT_BROWSER_CURATOR_TIMEOUT_MS = 20000;
const MAX_FETCH_URLS = 5;
const MAX_CURATOR_REQUEST_BYTES = 64 * 1024;
const MAX_CURATOR_PREVIEW_CHARS = 6000;
const MAX_BULK_REVIEW_SELECTORS = 25;
const DEFAULT_GEMINI_SEARCH_MODEL = 'gemini-2.5-flash';
const CODE_SEARCH_HINT = 'source code implementation example repository GitHub';
const FETCH_FRICTION_HOSTS = new Set([
  'medium.com',
  'towardsdatascience.com',
]);
const KNOWN_OFFICIAL_DOC_HOSTS = new Set([
  'developer.mozilla.org',
  'docs.cypress.io',
  'docs.github.com',
  'nodejs.org',
  'playwright.dev',
  'react.dev',
  'vite.dev',
  'vitest.dev',
]);
const SEARCH_URL_PATTERN = /\bhttps?:\/\/[^\s'"<>`]+/gi;
const SEARCH_LOCAL_PATH_PATTERN = /(^|[\s("'`])(?:~\/|\.\.\/|\/(?:Users|home|root|private|var|etc|tmp|Volumes)\b|file:)/i;
const SEARCH_PROTECTED_PATH_PATTERN = /(^|[\s/])(?:\.env(?:\.|$)|\.ssh\b|id_rsa\b|id_ed25519\b)/i;
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
const FETCH_BODY_DETAIL_KEYS = new Set(['content', 'body', 'text', 'html', 'markdown', 'rawcontent']);
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
      maxItems: MAX_FETCH_URLS,
      items: { type: 'string' },
      description: 'Public http(s) URLs to fetch sequentially.',
    },
  },
};

const webSearchSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', description: 'Search query text.' },
    q: { type: 'string', description: 'Search query text alias.' },
    search: { type: 'string', description: 'Search query text alias.' },
    queries: {
      type: 'array',
      maxItems: MAX_SEARCH_QUERIES,
      items: { type: 'string' },
      description: 'Optional set of varied search query angles. For research, comparisons, current facts, or uncertainty, prefer 5-10 non-overlapping queries with workflow=summary-review.',
    },
    count: { type: 'number', minimum: 1, maximum: MAX_SEARCH_RESULTS, description: 'Maximum result count. Defaults to 5, maximum 10.' },
    maxResults: { type: 'number', minimum: 1, maximum: MAX_SEARCH_RESULTS, description: 'Maximum result count alias.' },
    numResults: { type: 'number', minimum: 1, maximum: MAX_SEARCH_RESULTS, description: 'Maximum result count alias.' },
    workflow: {
      type: 'string',
      enum: SEARCH_WORKFLOWS,
      description: 'Search workflow. Use summary-review for research-quality answers with Pi CLI review; use none only for quick deterministic/headless lookup. Omitted auto selects summary-review with Pi UI/update support and none without UI.',
    },
    curatorAction: {
      type: 'string',
      enum: SEARCH_REVIEW_ACTIONS,
      description: 'Curator action for an existing summary-review session.',
    },
    reviewId: { type: 'string', description: 'Summary-review session id returned by web_search.' },
    searchResultUrl: { type: 'string', description: 'Public search result URL selected for a curator action.' },
    resultUrl: { type: 'string', description: 'Alias for searchResultUrl.' },
    resultRank: { type: 'number', minimum: 1, description: 'Rank number of a result in the current review, usable instead of searchResultUrl.' },
    resultId: { type: 'string', description: 'Stable result id printed in review output, such as result-1.' },
    searchResultUrls: {
      type: 'array',
      maxItems: MAX_BULK_REVIEW_SELECTORS,
      items: { type: 'string' },
      description: 'Bulk public search result URL selectors for keep/dismiss only.',
    },
    resultRanks: {
      type: 'array',
      maxItems: MAX_BULK_REVIEW_SELECTORS,
      items: { type: 'number', minimum: 1 },
      description: 'Bulk result rank selectors for keep/dismiss only.',
    },
    resultIds: {
      type: 'array',
      maxItems: MAX_BULK_REVIEW_SELECTORS,
      items: { type: 'string' },
      description: 'Bulk result id selectors for keep/dismiss only.',
    },
    followUpQuery: { type: 'string', description: 'Additional query to run from an active curator session.' },
    includeContent: { type: 'boolean', description: `Must be false. Use ${SAFE_FETCH_TOOL} for page content.` },
  },
};

const codeSearchSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', description: 'Code search query text.' },
    q: { type: 'string', description: 'Code search query text alias.' },
    search: { type: 'string', description: 'Code search query text alias.' },
    language: { type: 'string', description: 'Optional programming language hint.' },
    repo: { type: 'string', description: 'Optional repository hint such as owner/name.' },
    repository: { type: 'string', description: 'Optional repository hint alias.' },
    path: { type: 'string', description: 'Optional file or directory path hint.' },
    count: { type: 'number', minimum: 1, maximum: MAX_SEARCH_RESULTS, description: 'Maximum result count. Defaults to 5, maximum 10.' },
    maxResults: { type: 'number', minimum: 1, maximum: MAX_SEARCH_RESULTS, description: 'Maximum result count alias.' },
    numResults: { type: 'number', minimum: 1, maximum: MAX_SEARCH_RESULTS, description: 'Maximum result count alias.' },
    fallbackToWeb: { type: 'boolean', description: 'When true or omitted, fall back to web_search provider routing if EXA_API_KEY is unset.' },
    workflow: {
      type: 'string',
      enum: SEARCH_WORKFLOWS,
      description: 'Progress workflow. Use summary-review for code research when UI/update support is available; use none only for quick deterministic/headless lookup. Omitted auto selects live updates with Pi UI/update support and none without UI.',
    },
    includeContent: { type: 'boolean', description: `Must be false. Use ${SAFE_FETCH_TOOL} for page content.` },
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

function redactUrlForPreview(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const redacted = redact(text);
  try {
    const url = new URL(redacted);
    const suffix = `${url.search ? '?<redacted>' : ''}${url.hash ? '#<redacted>' : ''}`;
    return `${url.origin}${url.pathname}${suffix}`;
  } catch {
    return compactCliText(redacted, 160);
  }
}

function metadataOnlyFetchDetails(value) {
  const clean = (item) => {
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === 'object') {
      const out = {};
      for (const [key, child] of Object.entries(item)) {
        if (FETCH_BODY_DETAIL_KEYS.has(key.toLowerCase().replace(/[-_]/g, ''))) continue;
        out[key] = clean(child);
      }
      return out;
    }
    return item;
  };
  return redact(clean(value ?? {}));
}

function sanitizeExternalText(value) {
  return sanitizeRenderText(String(redact(value ?? '')));
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

function normalizeSearchProvider(env = process.env) {
  const raw = typeof env.STRONK_PI_SEARCH_PROVIDER === 'string' ? env.STRONK_PI_SEARCH_PROVIDER.trim().toLowerCase() : '';
  if (!raw) {
    throw new Error(`STRONK_PI_SEARCH_PROVIDER is required; choose one of: ${SEARCH_PROVIDERS.join(', ')}`);
  }
  if (!SEARCH_PROVIDERS.includes(raw)) {
    throw new Error(`unsupported STRONK_PI_SEARCH_PROVIDER: ${raw}; choose one of: ${SEARCH_PROVIDERS.join(', ')}`);
  }
  return raw;
}

function searchProviderKey(provider, env = process.env) {
  const envName = SEARCH_PROVIDER_KEY_ENV[provider];
  const value = typeof env[envName] === 'string' ? env[envName].trim() : '';
  if (!value) {
    throw new Error(`missing ${envName} for STRONK_PI_SEARCH_PROVIDER=${provider}`);
  }
  return value;
}

function optionalSearchProviderKey(provider, env = process.env) {
  const envName = SEARCH_PROVIDER_KEY_ENV[provider];
  return typeof env[envName] === 'string' ? env[envName].trim() : '';
}

function normalizeSearchCount(params, toolName = WEB_SEARCH_TOOL) {
  const raw = params.count ?? params.maxResults ?? params.numResults ?? DEFAULT_SEARCH_RESULTS;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`${toolName} result count must be a positive integer`);
  }
  if (count > MAX_SEARCH_RESULTS) return MAX_SEARCH_RESULTS;
  return count;
}

function compactSearchQuery(value) {
  if (typeof value !== 'string') return undefined;
  const query = value.trim().replace(/\s+/g, ' ');
  return query || undefined;
}

function assertSafeSearchText(value, toolName, fieldName) {
  if (typeof value !== 'string' || !value.trim()) return;
  for (const match of value.matchAll(SEARCH_URL_PATTERN)) {
    const rawUrl = match[0].replace(/[).,;]+$/g, '');
    if (!searchResultUrl(rawUrl)) {
      throw new Error(`${toolName} ${fieldName} must not contain local/private URLs`);
    }
  }
  if (SEARCH_LOCAL_PATH_PATTERN.test(value) || SEARCH_PROTECTED_PATH_PATTERN.test(value)) {
    throw new Error(`${toolName} ${fieldName} must not contain local paths`);
  }
}

function normalizeSearchQueries(params, toolName = WEB_SEARCH_TOOL) {
  const queries = [];
  const direct = compactSearchQuery(firstString(params.query, params.q, params.search));
  if (direct) queries.push(direct);
  if (params.queries !== undefined) {
    if (!Array.isArray(params.queries)) {
      throw new Error(`${toolName} queries must be an array of strings`);
    }
    for (const item of params.queries) {
      const query = compactSearchQuery(item);
      if (query && !queries.includes(query)) queries.push(query);
    }
  }
  if (queries.length === 0) throw new Error(`${toolName} requires query text`);
  if (queries.length > MAX_SEARCH_QUERIES) {
    throw new Error(`${toolName} supports at most ${MAX_SEARCH_QUERIES} queries`);
  }
  for (const query of queries) assertSafeSearchText(query, toolName, 'query');
  return queries;
}

function normalizeSearchWorkflow(value, toolName = WEB_SEARCH_TOOL) {
  if (value === undefined) return 'auto';
  if (typeof value !== 'string') {
    throw new Error(`${toolName} workflow must be one of: ${SEARCH_WORKFLOWS.join(', ')}`);
  }
  const workflow = value.trim().toLowerCase();
  if (!SEARCH_WORKFLOW_SET.has(workflow)) {
    throw new Error(`${toolName} workflow must be one of: ${SEARCH_WORKFLOWS.join(', ')}`);
  }
  return workflow;
}

function normalizeReviewId(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('web_search reviewId must be a non-empty string');
  }
  const reviewId = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(reviewId)) {
    throw new Error('web_search reviewId contains unsupported characters');
  }
  return reviewId;
}

function normalizeReviewUrlValue(value, action) {
  const url = value;
  if (typeof url !== 'string') {
    throw new Error(`web_search curatorAction=${action} requires searchResultUrl`);
  }
  const safeUrl = searchResultUrl(url);
  if (!safeUrl) {
    throw new Error('web_search searchResultUrl must be a public http(s) URL');
  }
  return safeUrl;
}

function normalizeReviewUrl(params, action) {
  return normalizeReviewUrlValue(firstString(params.searchResultUrl, params.resultUrl), action);
}

function normalizeReviewResultRank(value) {
  if (value === undefined) return undefined;
  const rank = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(rank) || rank < 1) {
    throw new Error('web_search resultRank must be a positive integer');
  }
  return rank;
}

function normalizeReviewResultId(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('web_search resultId must be a non-empty string');
  }
  const resultId = value.trim();
  if (!/^result-\d+$/.test(resultId)) {
    throw new Error('web_search resultId must look like result-1');
  }
  return resultId;
}

function normalizeReviewArray(value, fieldName) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BULK_REVIEW_SELECTORS) {
    throw new Error(`web_search ${fieldName} must contain 1-${MAX_BULK_REVIEW_SELECTORS} values`);
  }
  return value;
}

function normalizeBulkReviewSelectors(params, action) {
  const selectors = [];
  const urls = normalizeReviewArray(params.searchResultUrls, 'searchResultUrls')
    .map((url) => ({ searchResultUrl: normalizeReviewUrlValue(url, action) }));
  const ranks = normalizeReviewArray(params.resultRanks, 'resultRanks')
    .map((rank) => ({ resultRank: normalizeReviewResultRank(rank) }));
  const ids = normalizeReviewArray(params.resultIds, 'resultIds')
    .map((resultId) => ({ resultId: normalizeReviewResultId(resultId) }));
  selectors.push(...urls, ...ranks, ...ids);
  const hasPlural = selectors.length > 0;
  const hasSingle = params.searchResultUrl !== undefined
    || params.resultUrl !== undefined
    || params.resultRank !== undefined
    || params.resultId !== undefined;
  if (hasPlural && hasSingle) {
    selectors.push(normalizeReviewResultSelector(params, action));
  }
  return selectors;
}

function normalizeReviewResultSelector(params, action) {
  const selector = {};
  const url = firstString(params.searchResultUrl, params.resultUrl);
  if (typeof url === 'string') selector.searchResultUrl = normalizeReviewUrl(params, action);
  const resultRank = normalizeReviewResultRank(params.resultRank);
  if (resultRank !== undefined) selector.resultRank = resultRank;
  const resultId = normalizeReviewResultId(params.resultId);
  if (resultId !== undefined) selector.resultId = resultId;
  if (!selector.searchResultUrl && selector.resultRank === undefined && !selector.resultId) {
    throw new Error(`web_search curatorAction=${action} requires searchResultUrl, resultRank, or resultId`);
  }
  return selector;
}

function normalizeCuratorActionParams(params, workflow) {
  const rawAction = params.curatorAction;
  if (rawAction === undefined) return undefined;
  if (typeof rawAction !== 'string') {
    throw new Error(`web_search curatorAction must be one of: ${SEARCH_REVIEW_ACTIONS.join(', ')}`);
  }
  const curatorAction = rawAction.trim().toLowerCase();
  if (!SEARCH_REVIEW_ACTION_SET.has(curatorAction)) {
    throw new Error(`web_search curatorAction must be one of: ${SEARCH_REVIEW_ACTIONS.join(', ')}`);
  }
  const reviewId = normalizeReviewId(params.reviewId);
  const action = { curatorAction, reviewId, workflow };
  if (['keep', 'dismiss'].includes(curatorAction)) {
    const selectors = normalizeBulkReviewSelectors(params, curatorAction);
    if (selectors.length > 0) {
      action.selectors = selectors;
    } else {
      Object.assign(action, normalizeReviewResultSelector(params, curatorAction));
    }
  }
  if (curatorAction === 'fetch') {
    if (params.searchResultUrls !== undefined || params.resultRanks !== undefined || params.resultIds !== undefined) {
      throw new Error('web_search bulk selectors are only supported for keep/dismiss; use fetch-kept for batch fetching kept results');
    }
    Object.assign(action, normalizeReviewResultSelector(params, curatorAction));
  }
  if (curatorAction === 'follow-up') {
    const followUpQuery = compactSearchQuery(params.followUpQuery);
    if (!followUpQuery) throw new Error('web_search curatorAction=follow-up requires followUpQuery');
    assertSafeSearchText(followUpQuery, WEB_SEARCH_TOOL, 'followUpQuery');
    action.followUpQuery = followUpQuery;
  }
  return action;
}

function normalizeWebSearchParams(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('web_search payload must be an object');
  }
  if (hasSensitiveContent(params)) {
    throw new Error('web_search payload contains secret-like content');
  }
  if (params.includeContent === true) {
    throw new Error(`web_search includeContent denied; use guarded ${SAFE_FETCH_TOOL} for page fetches`);
  }
  const workflow = normalizeSearchWorkflow(params.workflow, WEB_SEARCH_TOOL);
  const curatorAction = normalizeCuratorActionParams(params, workflow);
  if (curatorAction) return curatorAction;
  const queries = normalizeSearchQueries(params, WEB_SEARCH_TOOL);
  return {
    query: queries[0],
    queries,
    count: normalizeSearchCount(params, WEB_SEARCH_TOOL),
    workflow,
  };
}

function compactHint(value, maxLength = 120) {
  if (typeof value !== 'string') return undefined;
  const hint = value.trim().replace(/\s+/g, ' ');
  return hint ? hint.slice(0, maxLength) : undefined;
}

function searchHint(params, fieldName, toolName, maxLength, ...values) {
  const hint = compactHint(firstString(...values), maxLength);
  if (hint) assertSafeSearchText(hint, toolName, fieldName);
  return hint;
}

function normalizeCodeSearchParams(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('code_search payload must be an object');
  }
  if (hasSensitiveContent(params)) {
    throw new Error('code_search payload contains secret-like content');
  }
  if (params.includeContent === true) {
    throw new Error(`code_search includeContent denied; use guarded ${SAFE_FETCH_TOOL} for page fetches`);
  }
  const workflow = normalizeSearchWorkflow(params.workflow, CODE_SEARCH_TOOL);
  const queries = normalizeSearchQueries(params, CODE_SEARCH_TOOL);
  if (queries.length > 1) throw new Error('code_search accepts exactly one query');
  return {
    query: queries[0],
    count: normalizeSearchCount(params, CODE_SEARCH_TOOL),
    language: searchHint(params, 'language', CODE_SEARCH_TOOL, 80, params.language),
    repository: searchHint(params, 'repository', CODE_SEARCH_TOOL, 120, params.repository, params.repo),
    path: searchHint(params, 'path', CODE_SEARCH_TOOL, 160, params.path),
    fallbackToWeb: params.fallbackToWeb !== false,
    workflow,
  };
}

function buildCodeSearchQuery(search) {
  const parts = [search.query];
  if (search.language) parts.push(`${search.language} code`);
  if (search.repository) parts.push(`repository ${search.repository}`);
  if (search.path) parts.push(`path ${search.path}`);
  parts.push(CODE_SEARCH_HINT);
  return parts.join(' ');
}

function searchFetch(options = {}, toolName = WEB_SEARCH_TOOL) {
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error(`${toolName} requires a fetch implementation`);
  }
  return fetchFn;
}

function redactSearchError(text, secretValues = []) {
  let detail = String(redact(text));
  for (const secret of secretValues) {
    if (typeof secret === 'string' && secret) {
      detail = detail.split(secret).join('<redacted>');
    }
  }
  return detail.slice(0, 300).trim();
}

function redactProviderText(text, maxLength = 1200) {
  return sanitizeExternalText(text).slice(0, maxLength).trim();
}

async function fetchSearchJson(provider, url, init, options = {}, signal, toolName = WEB_SEARCH_TOOL, secretValues = []) {
  if (signal?.aborted) {
    throw (signal.reason instanceof Error ? signal.reason : new Error(`${provider} ${toolName} was aborted`));
  }
  const fetchFn = searchFetch(options, toolName);
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs ?? 15000);
  const timer = setTimeout(() => controller.abort(new Error(`${provider} ${toolName} timed out`)), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason instanceof Error ? signal.reason : new Error(`${provider} ${toolName} was aborted`));
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    const response = await fetchFn(url, {
      ...init,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = redactSearchError(text, secretValues);
      throw new Error(`${provider} ${toolName} HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`${provider} ${toolName} returned malformed JSON`);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

function searchResultUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return undefined;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
  if (parsed.username || parsed.password) return undefined;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || hostname.includes('%')) return undefined;
  if (isBlockedSearchHostname(hostname) || isBlockedSearchIpLiteral(hostname)) return undefined;
  for (const [key, value] of parsed.searchParams.entries()) {
    if (isSensitiveKey(key) || hasSensitiveString(value)) return undefined;
  }
  if (!hostname.includes('.') && !hostname.includes(':')) return undefined;
  return parsed.toString();
}

function isBlockedSearchHostname(hostname) {
  return (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.lan')
    || hostname.endsWith('.home.arpa')
    || hostname === 'metadata.google.internal'
    || hostname === 'metadata'
    || hostname === 'instance-data.ec2.internal'
  );
}

function isBlockedSearchIpLiteral(hostname) {
  const family = isIP(hostname);
  if (family === 4) return !isPublicSearchIPv4(hostname);
  if (family === 6) return !isPublicSearchIPv6(hostname);
  if (/^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){0,3}$/i.test(hostname)) return true;
  return false;
}

function isPublicSearchIPv4(hostname) {
  const ipv4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;
  if (octets[0] === 0) return false;
  if (octets[0] === 10) return false;
  if (octets[0] === 127) return false;
  if (octets[0] === 192 && octets[1] === 168) return false;
  if (octets[0] === 169 && octets[1] === 254) return false;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return false;
  if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return false;
  if (octets[0] === 198 && octets[1] >= 18 && octets[1] <= 19) return false;
  if (octets[0] >= 224) return false;
  return hostname !== '169.254.169.254' && hostname !== '100.100.100.200';
}

function isPublicSearchIPv6(hostname) {
  const normalized = hostname.toLowerCase();
  if (
    normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('::ffff:')
    || normalized.startsWith('fe80:')
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('ff')
    || normalized === '2001:db8::'
    || normalized.startsWith('2001:db8:')
  ) {
    return false;
  }
  return true;
}

function normalizeSearchResult(provider, item, index) {
  if (!item || typeof item !== 'object') return undefined;
  const rawUrl = firstString(item.url, item.link, item.href, item.uri, nestedString(item, 'web', 'uri'));
  const url = searchResultUrl(rawUrl);
  if (!url) return undefined;
  const rawSnippet = firstString(
    item.description,
    item.snippet,
    Array.isArray(item.highlights) ? item.highlights.join(' ') : undefined,
    item.content,
    item.summary,
    item.text,
  );
  const snippet = rawSnippet ? sanitizeExternalText(htmlToText(rawSnippet)).slice(0, 600) : '';
  const title = firstString(item.title, item.name, nestedString(item, 'web', 'title')) || url;
  const publishedDate = firstString(item.publishedDate, item.age, item.date);
  const result = {
    title: sanitizeExternalText(htmlToText(title)).slice(0, 200) || url,
    url,
    snippet,
    provider,
    rank: index + 1,
  };
  if (publishedDate) result.publishedDate = publishedDate;
  if (typeof item.score === 'number') result.score = item.score;
  return result;
}

function normalizeSearchResults(provider, items, limit) {
  if (!Array.isArray(items)) return [];
  const results = [];
  for (let index = 0; index < items.length && results.length < limit; index += 1) {
    const result = normalizeSearchResult(provider, items[index], index);
    if (result) results.push({ ...result, rank: results.length + 1 });
  }
  return results;
}

async function searchExa(search, key, options, signal) {
  const data = await fetchSearchJson('exa', 'https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
    },
    body: JSON.stringify({
      query: search.query,
      type: 'auto',
      numResults: search.count,
      contents: {
        highlights: true,
      },
    }),
  }, options, signal, WEB_SEARCH_TOOL, [key]);
  return {
    results: normalizeSearchResults('exa', data.results, search.count),
    requestId: firstString(data.requestId),
  };
}

async function searchExaCode(search, key, options, signal) {
  const effectiveQuery = buildCodeSearchQuery(search);
  const data = await fetchSearchJson('exa', 'https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
    },
    body: JSON.stringify({
      query: effectiveQuery,
      type: 'auto',
      numResults: search.count,
      contents: {
        highlights: true,
      },
    }),
  }, options, signal, CODE_SEARCH_TOOL, [key]);
  return {
    results: normalizeSearchResults('exa', data.results, search.count),
    requestId: firstString(data.requestId),
    effectiveQuery,
  };
}

async function searchBrave(search, key, options, signal) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', search.query);
  url.searchParams.set('count', String(search.count));
  const data = await fetchSearchJson('brave', url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': key,
    },
  }, options, signal, WEB_SEARCH_TOOL, [key]);
  return {
    results: normalizeSearchResults('brave', data.web?.results, search.count),
  };
}

async function searchTavily(search, key, options, signal) {
  const data = await fetchSearchJson('tavily', 'https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      query: search.query,
      search_depth: 'basic',
      max_results: search.count,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_favicon: true,
    }),
  }, options, signal, WEB_SEARCH_TOOL, [key]);
  return {
    results: normalizeSearchResults('tavily', data.results, search.count),
    requestId: firstString(data.request_id),
  };
}

function geminiSearchModel(env = process.env) {
  const model = typeof env.STRONK_PI_GEMINI_SEARCH_MODEL === 'string' ? env.STRONK_PI_GEMINI_SEARCH_MODEL.trim() : '';
  return model || DEFAULT_GEMINI_SEARCH_MODEL;
}

function geminiAnswer(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return redactProviderText(parts
    .map((part) => (part && typeof part.text === 'string' ? part.text.trim() : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim());
}

function geminiGroundingChunks(data) {
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks;
  return Array.isArray(chunks) ? chunks : [];
}

function geminiWebSearchQueries(data) {
  const queries = data?.candidates?.[0]?.groundingMetadata?.webSearchQueries;
  return Array.isArray(queries) ? queries.filter((query) => typeof query === 'string' && query.trim()) : [];
}

async function searchGemini(search, key, options, signal, env = process.env) {
  const model = geminiSearchModel(env);
  const data = await fetchSearchJson('gemini', `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': key,
    },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [{
          text: `Search the web for this query and return concise source-backed web results. Do not include full page content.\n\nQuery: ${search.query}`,
        }],
      }],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.2,
      },
    }),
  }, options, signal, WEB_SEARCH_TOOL, [key]);
  const answer = geminiAnswer(data);
  const results = normalizeSearchResults(
    'gemini',
    geminiGroundingChunks(data).map((chunk) => ({
      title: nestedString(chunk, 'web', 'title'),
      url: nestedString(chunk, 'web', 'uri'),
      description: answer,
    })),
    search.count,
  );
  return {
    results,
    answer,
    webSearchQueries: geminiWebSearchQueries(data),
    model,
  };
}

const SEARCH_HANDLERS = {
  exa: searchExa,
  brave: searchBrave,
  tavily: searchTavily,
  gemini: searchGemini,
};

function searchUiAvailable(ctx, onUpdate) {
  return contextHasUI(ctx) && typeof onUpdate === 'function';
}

function resolveSearchWorkflow(requestedWorkflow = 'auto', ctx = {}, onUpdate) {
  const uiAvailable = searchUiAvailable(ctx, onUpdate);
  if (requestedWorkflow === 'none') {
    return { requestedWorkflow, workflow: 'none', uiAvailable, emitUpdates: false };
  }
  if (uiAvailable) {
    return { requestedWorkflow, workflow: 'summary-review', uiAvailable, emitUpdates: true };
  }
  return {
    requestedWorkflow,
    workflow: 'none',
    uiAvailable,
    emitUpdates: false,
    fallbackReason: `${requestedWorkflow}-without-ui`,
  };
}

function searchConcurrency(options = {}, total = 1) {
  const raw = Number(options.maxConcurrency ?? options.concurrency ?? DEFAULT_SEARCH_CONCURRENCY);
  const requested = Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_SEARCH_CONCURRENCY;
  return Math.max(1, Math.min(MAX_SEARCH_CONCURRENCY, requested, Math.max(1, total)));
}

function querySnapshot(queryStates) {
  return queryStates.map((query) => ({
    id: query.id,
    index: query.index,
    query: query.query,
    status: query.status,
    ...(typeof query.resultCount === 'number' ? { resultCount: query.resultCount } : {}),
    ...(query.error ? { error: query.error } : {}),
  }));
}

const RENDER_GRAPHEME_SEGMENTER = typeof Intl?.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;
const ANSI_ESCAPE_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\)|_[\s\S]*?(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const FORMAT_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2060-\u206f]/g;

function sanitizeRenderText(value) {
  return String(value ?? '')
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(FORMAT_CONTROL_PATTERN, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ');
}

function renderSegments(value) {
  const text = sanitizeRenderText(value);
  if (!RENDER_GRAPHEME_SEGMENTER) return Array.from(text);
  return Array.from(RENDER_GRAPHEME_SEGMENTER.segment(text), ({ segment }) => segment);
}

function isZeroWidthRenderCodePoint(codePoint) {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0x200d
  );
}

function isWideRenderCodePoint(codePoint) {
  return (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f000 && codePoint <= 0x1faff)
    )
  );
}

function renderSegmentWidth(segment) {
  if (segment === '\t') return 3;
  if (segment.includes('\u200d') || segment.includes('\ufe0f')) return 2;
  for (const char of segment) {
    const codePoint = char.codePointAt(0);
    if (!codePoint || codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) continue;
    if (isZeroWidthRenderCodePoint(codePoint)) continue;
    if (isWideRenderCodePoint(codePoint)) return 2;
    return 1;
  }
  return 0;
}

function renderVisibleWidth(value) {
  return renderSegments(value).reduce((width, segment) => width + renderSegmentWidth(segment), 0);
}

function truncateRenderTextToWidth(value, maxWidth) {
  const widthLimit = Math.max(0, Math.floor(Number(maxWidth) || 0));
  if (widthLimit <= 0) return '';
  let output = '';
  let width = 0;
  for (const segment of renderSegments(value)) {
    const segmentWidth = renderSegmentWidth(segment);
    if (segmentWidth === 0) {
      output += segment;
      continue;
    }
    if (segmentWidth > widthLimit && width === 0) return '.';
    if (width + segmentWidth > widthLimit) break;
    output += segment;
    width += segmentWidth;
  }
  return output;
}

function compactCliText(value, max = 160) {
  const widthLimit = Math.max(1, Math.floor(Number(max) || 160));
  const text = sanitizeRenderText(String(value ?? '').replace(/\s+/g, ' ').trim());
  if (renderVisibleWidth(text) <= widthLimit) return text;
  const suffix = widthLimit >= 3 ? '...' : '.'.repeat(widthLimit);
  const prefix = truncateRenderTextToWidth(text, widthLimit - renderVisibleWidth(suffix)).trimEnd();
  return `${prefix}${suffix}`;
}

function wrapRenderLine(line, width = 80) {
  const maxWidth = Math.max(1, Math.floor(Number(width) || 80));
  const segments = renderSegments(line);
  if (segments.length === 0) return [''];
  const chunks = [];
  let index = 0;
  while (index < segments.length) {
    if (chunks.length > 0) {
      while (index < segments.length && /^\s$/u.test(segments[index])) index += 1;
    }
    const start = index;
    let currentWidth = 0;
    let end = index;
    let lastBreak = -1;
    let sawNonSpace = false;
    while (end < segments.length) {
      const segment = segments[end];
      const segmentWidth = renderSegmentWidth(segment);
      if (currentWidth + segmentWidth > maxWidth) break;
      currentWidth += segmentWidth;
      end += 1;
      if (/^\s$/u.test(segment)) {
        if (sawNonSpace) lastBreak = end;
      } else if (segmentWidth > 0) {
        sawNonSpace = true;
      }
    }
    if (end >= segments.length) {
      chunks.push(segments.slice(index).join('').trimEnd());
      break;
    }
    if (end === start) {
      chunks.push('.');
      index += 1;
      continue;
    }
    const breakChunk = lastBreak > start ? segments.slice(index, lastBreak).join('').trimEnd() : '';
    if (breakChunk) {
      chunks.push(breakChunk);
      index = lastBreak;
      continue;
    }
    chunks.push(segments.slice(index, end).join('').trimEnd());
    index = end;
  }
  return (chunks.length > 0 ? chunks : ['']).map((chunk) => truncateRenderTextToWidth(chunk, maxWidth));
}

class PlainTextRenderComponent {
  constructor(text = '') {
    this.setText(text);
  }

  setText(text = '') {
    this.text = String(text ?? '');
  }

  invalidate() {}

  render(width = 80) {
    return this.text.split(/\r?\n/).flatMap((line) => wrapRenderLine(line, width));
  }
}

function renderTextComponent(text, context = {}) {
  const previous = context?.lastComponent;
  if (previous && typeof previous.render === 'function' && typeof previous.setText === 'function') {
    previous.setText(text);
    return previous;
  }
  return new PlainTextRenderComponent(text);
}

function formatQueryStateLine(query) {
  const count = typeof query.resultCount === 'number' ? ` results=${query.resultCount}` : '';
  const error = query.error ? ` error=${compactCliText(query.error, 90)}` : '';
  return `- ${query.id || 'query'} [${query.status || 'unknown'}]${count}${error}`;
}

function readableQualitySignal(signal) {
  const text = String(signal || '');
  let match = /^same-host-(\d+)$/.exec(text);
  if (match) return `same host x${match[1]}`;
  match = /^possible-duplicate-of-rank-(\d+)$/.exec(text);
  if (match) return `possible duplicate of #${match[1]}`;
  return text.replace(/-/g, ' ');
}

function formatQualitySignals(signals) {
  if (!Array.isArray(signals) || signals.length === 0) return '';
  return signals.map((signal) => compactCliText(readableQualitySignal(signal), 80)).filter(Boolean).join(', ');
}

function summarizeSearchResults(results = []) {
  const summary = {
    count: Array.isArray(results) ? results.length : 0,
    duplicateCount: 0,
    sourceSummary: {},
  };
  if (!Array.isArray(results)) return summary;
  for (const result of results) {
    if (result?.duplicateOfRank) summary.duplicateCount += 1;
    const key = result?.sourceReliability || 'unknown';
    summary.sourceSummary[key] = (summary.sourceSummary[key] || 0) + 1;
  }
  return summary;
}

function formatSourceSummary(sourceSummary) {
  if (!sourceSummary || typeof sourceSummary !== 'object') return '';
  return Object.entries(sourceSummary)
    .filter(([, count]) => Number(count) > 0)
    .map(([name, count]) => `${compactCliText(name, 40)}:${count}`)
    .join(', ');
}

function formatResultSelectorRange(resultsOrCount) {
  const count = Array.isArray(resultsOrCount) ? resultsOrCount.length : Number(resultsOrCount) || 0;
  if (count <= 0) return '';
  return count === 1 ? 'resultRank 1 / resultId result-1' : `resultRank 1-${count} / resultId result-<rank>`;
}

function formatSearchResultSummaryLines(results = [], options = {}) {
  const summary = summarizeSearchResults(results);
  const lines = [];
  if (summary.count > 0) {
    const sourceSummary = formatSourceSummary(summary.sourceSummary);
    if (sourceSummary) lines.push(`Source summary: ${sourceSummary}`);
    if (summary.duplicateCount > 0) lines.push(`Possible duplicates: ${summary.duplicateCount}`);
    if (options.includeSelectors !== false) {
      lines.push(`Result selectors: ${formatResultSelectorRange(summary.count)}`);
    }
  }
  return lines;
}

function modelRecordText(value, max = 1000) {
  const text = redactProviderText(sanitizeRenderText(String(value ?? '').replace(/\s+/g, ' ').trim()));
  if (!text) return '';
  const limit = Math.max(1, Math.floor(Number(max) || 1000));
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}...` : text;
}

function formatSearchResultRecordLines(results = [], options = {}) {
  if (!Array.isArray(results) || results.length === 0) return [];
  const heading = options.heading || 'Result records for model:';
  const lines = [heading];
  for (const result of results) {
    const rank = result.rank ?? '?';
    lines.push(`- resultRank=${rank} resultId=${reviewResultId(result)}`);
    const title = modelRecordText(result.title, 240);
    const url = modelRecordText(result.url, 1200);
    const snippet = modelRecordText(result.snippet, 700);
    const query = modelRecordText(result.query, 240);
    if (title) lines.push(`  title: ${title}`);
    if (url) lines.push(`  searchResultUrl: ${url}`);
    if (result.sourceKind || result.sourceReliability) {
      lines.push(`  source: ${modelRecordText(result.sourceKind || 'web', 80)} (${modelRecordText(result.sourceReliability || 'unknown', 80)})`);
    }
    if (result.sourceAccessibility) lines.push(`  sourceAccessibility: ${modelRecordText(result.sourceAccessibility, 80)}`);
    if (result.contentStatus) lines.push(`  contentStatus: ${modelRecordText(result.contentStatus, 80)}`);
    if (result.fetchRecommendedBeforeUse) lines.push('  fetchRecommendedBeforeUse: true');
    if (Array.isArray(result.qualitySignals) && result.qualitySignals.length > 0) {
      lines.push(`  signals: ${formatQualitySignals(result.qualitySignals)}`);
    }
    if (result.publishedDate) lines.push(`  publishedDate: ${modelRecordText(result.publishedDate, 80)}`);
    if (result.duplicateOfRank) lines.push(`  duplicateOfRank: ${result.duplicateOfRank}`);
    if (query) lines.push(`  matchedQuery: ${query}`);
    if (snippet) lines.push(`  snippet: ${snippet}`);
  }
  return lines;
}

function formatResultCliLine(result) {
  const source = result.sourceKind ? ` source=${result.sourceKind}/${result.sourceReliability || 'unknown'}` : '';
  const accessibility = result.sourceAccessibility ? ` access=${result.sourceAccessibility}` : '';
  const duplicate = result.duplicateOfRank ? ` duplicate-of=#${result.duplicateOfRank}` : '';
  const signals = formatQualitySignals(result.qualitySignals);
  const signalText = signals ? ` signals=${signals}` : '';
  const rank = result.rank ?? '?';
  return `- #${rank} resultId: ${reviewResultId(result)}${source}${accessibility}${duplicate}${signalText}`;
}

function formatSearchUpdateText(update) {
  const tool = update.tool || 'search';
  const lines = [`${tool} ${update.state || 'progress'} provider=${update.provider || 'unknown'} workflow=${update.workflow || 'unknown'}`];
  if (update.state === 'start') {
    lines.push(`queries=${update.queryCount ?? 0} requested=${update.requestedCount ?? 'default'} concurrency=${update.concurrency ?? 1}`);
  }
  if (update.query?.status) {
    lines.push(formatQueryStateLine(update.query));
  }
  if (Array.isArray(update.queries) && update.queries.length > 0) {
    const shown = update.queries.slice(0, 6);
    lines.push('query state:');
    lines.push(...shown.map(formatQueryStateLine));
    if (update.queries.length > shown.length) lines.push(`- ... ${update.queries.length - shown.length} more query state(s)`);
  }
  if (update.state === 'result' && typeof update.resultCount === 'number') {
    lines.push(`resultCount=${update.resultCount}`);
    if (Array.isArray(update.results)) {
      lines.push(`resultBatch=${update.results.length}`);
      lines.push(...formatSearchResultSummaryLines(update.results, { includeSelectors: false }));
    }
  }
  if (update.state === 'completed') {
    lines.push(`resultCount=${update.resultCount ?? 0} errorCount=${update.errorCount ?? 0}`);
    if (update.reviewId) lines.push(`reviewId=${update.reviewId}`);
    if (Array.isArray(update.cancelledQueryIds) && update.cancelledQueryIds.length > 0) {
      lines.push(`cancelled=${update.cancelledQueryIds.join(',')}`);
    }
  }
  if (update.state === 'error') {
    lines.push(`error=${compactCliText(update.error || 'error', 140)}`);
  }
  return lines.join('\n');
}

function searchRenderDetails(result) {
  if (!result || typeof result !== 'object') return {};
  if (result.details && typeof result.details === 'object') return result.details;
  return result;
}

function renderScalar(value, fallback = '', maxWidth = 80) {
  const text = compactCliText(value ?? fallback, maxWidth);
  return text || fallback;
}

function formatSearchRenderCall(toolName, params = {}) {
  const safe = redact(params && typeof params === 'object' ? params : {});
  if (safe.curatorAction) {
    const action = renderScalar(safe.curatorAction, '(required)', 40);
    const reviewId = renderScalar(safe.reviewId, '(required)', 80);
    const lines = [
      `${toolName} review action=${action}`,
      `reviewId=${reviewId}`,
    ];
    if (['keep', 'dismiss', 'fetch'].includes(String(safe.curatorAction))) {
      if (safe.resultRank !== undefined) lines.push(`resultRank=${renderScalar(safe.resultRank, '', 20)}`);
      if (safe.resultId) lines.push(`resultId=${renderScalar(safe.resultId, '', 80)}`);
      lines.push(`searchResultUrl=${redactUrlForPreview(safe.searchResultUrl || safe.resultUrl) || '(or use resultRank/resultId)'}`);
    }
    if (safe.curatorAction === 'follow-up') lines.push(`followUpQuery=${renderScalar(safe.followUpQuery, '(required)', 120)}`);
    if (safe.curatorAction === 'fetch-kept') lines.push(`fetch_content=batch kept URLs max=${MAX_FETCH_URLS}`);
    return lines.join('\n');
  }
  const queries = Array.isArray(safe.queries)
    ? safe.queries
    : [safe.query || safe.q || safe.search || ''];
  const lines = [
    `${toolName} workflow=${renderScalar(safe.workflow, 'auto', 40)} count=${renderScalar(safe.count || safe.maxResults || safe.numResults || DEFAULT_SEARCH_RESULTS, String(DEFAULT_SEARCH_RESULTS), 20)}`,
    `queries=${queries.filter(Boolean).length || 1}`,
  ];
  for (const [index, query] of queries.filter(Boolean).slice(0, 6).entries()) {
    lines.push(`- q${index + 1} ${compactCliText(query, 100)}`);
  }
  if (queries.length > 6) lines.push(`- ... ${queries.length - 6} more quer${queries.length - 6 === 1 ? 'y' : 'ies'}`);
  return lines.join('\n');
}

function formatSearchRenderResult(toolName, result = {}) {
  const details = searchRenderDetails(result);
  const review = details.review && typeof details.review === 'object' ? details.review : {};
  const provider = renderScalar(details.provider || review.provider || details.mode, 'unknown', 40);
  const workflow = renderScalar(details.workflow || review.workflow, 'unknown', 40);
  const count = renderScalar(details.count ?? details.results?.length ?? review.resultCount ?? review.keptCount ?? 0, '0', 20);
  const lines = [
    `${toolName} completed provider=${provider} workflow=${workflow} results=${count}`,
  ];
  lines.push(`contentFetchTool=${renderScalar(details.contentFetchTool, SAFE_FETCH_TOOL, 40)}`);
  if (Array.isArray(details.results) && details.results.length > 0) {
    lines.push(...formatSearchResultSummaryLines(details.results));
    lines.push('Structured result details: details.results');
  }
  if (details.review || details.reviewId) {
    lines.push(...formatReviewStateLines(details.review || { reviewId: details.reviewId }, { includeActions: true }));
  }
  if (Array.isArray(details.queryStates) && details.queryStates.length > 0) {
    lines.push('query state:');
    lines.push(...details.queryStates.slice(0, 6).map(formatQueryStateLine));
    if (details.queryStates.length > 6) lines.push(`- ... ${details.queryStates.length - 6} more query state(s)`);
  }
  if (Array.isArray(details.errors) && details.errors.length > 0) {
    lines.push('errors:');
    for (const error of details.errors.slice(0, 5)) lines.push(`- ${compactCliText(error.message || error, 120)}`);
  }
  return lines.join('\n');
}

function emitSearchUpdate(run, update) {
  if (!run.emitUpdates || run.updatesClosed) return;
  const details = redact({
    tool: run.toolName,
    provider: run.provider,
    workflow: run.workflow,
    requestedWorkflow: run.requestedWorkflow,
    ...update,
  });
  run.curator?.pushUpdate?.(details);
  if (typeof run.onUpdate !== 'function') return;
  const envelope = {
    content: [{ type: 'text', text: formatSearchUpdateText(details) }],
    details,
  };
  try {
    const maybePromise = run.onUpdate(envelope);
    if (maybePromise && typeof maybePromise.catch === 'function') {
      maybePromise.catch(() => {});
    }
  } catch {
    // Progress updates are best-effort and must not alter search results.
  }
}

function curatorTimeoutMs(options = {}) {
  const value = Number(options.browserCuratorTimeoutMs ?? DEFAULT_BROWSER_CURATOR_TIMEOUT_MS);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_BROWSER_CURATOR_TIMEOUT_MS;
  return value;
}

function sendCuratorJson(response, statusCode, payload) {
  const body = JSON.stringify(redact(payload));
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendCuratorError(response, statusCode, error) {
  sendCuratorJson(response, statusCode, {
    ok: false,
    error: redactSearchError(error?.message ?? String(error)),
  });
}

function sendCuratorEvent(response, event, payload) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(redact(payload))}\n\n`);
}

function readCuratorJson(request) {
  return new Promise((resolveRead, rejectRead) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_CURATOR_REQUEST_BYTES) {
        settle(rejectRead, new Error('curator request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        settle(resolveRead, {});
        return;
      }
      try {
        settle(resolveRead, JSON.parse(text));
      } catch {
        settle(rejectRead, new Error('curator request body must be JSON'));
      }
    });
    request.on('error', (error) => settle(rejectRead, error));
  });
}

function curatorHtml(token) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Stronk Search Curator</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f4;
      --ink: #202422;
      --muted: #64706b;
      --line: #d8ddd7;
      --panel: #ffffff;
      --accent: #176b5b;
      --blue: #225c8f;
      --danger: #9e342f;
      --warn: #8a5b12;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
      letter-spacing: 0;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 12px 18px;
      border-bottom: 1px solid var(--line);
      background: rgba(246, 247, 244, 0.97);
    }
    h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 700;
    }
    .meta {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 12px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 2px 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #fff;
      color: var(--ink);
      white-space: nowrap;
    }
    main {
      display: grid;
      grid-template-columns: minmax(220px, 280px) minmax(0, 1fr) minmax(280px, 360px);
      gap: 14px;
      padding: 14px;
      min-height: calc(100vh - 57px);
    }
    section {
      min-width: 0;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    .panel h2 {
      margin: 0;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      font-size: 13px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
    }
    .query {
      display: grid;
      grid-template-columns: 70px minmax(0, 1fr);
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      font-size: 13px;
    }
    .status {
      color: var(--blue);
      font-weight: 700;
      white-space: nowrap;
    }
    .status.failed, .status.cancelled { color: var(--danger); }
    .status.complete, .status.results { color: var(--accent); }
    .result {
      padding: 12px;
      border-bottom: 1px solid var(--line);
      background: #fff;
    }
    .result.dismissed {
      opacity: 0.55;
      background: #fafafa;
    }
    .result.kept {
      border-left: 4px solid var(--accent);
    }
    .title {
      margin: 0 0 4px;
      font-size: 15px;
      font-weight: 700;
      line-height: 1.3;
    }
    .url {
      margin: 0 0 8px;
      color: var(--blue);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .snippet {
      margin: 0;
      color: #3d4742;
      font-size: 13px;
      line-height: 1.45;
    }
    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 10px;
    }
    button, input {
      font: inherit;
      letter-spacing: 0;
    }
    button {
      min-height: 30px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      padding: 4px 10px;
      cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    button.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: #fff;
    }
    button.danger {
      border-color: var(--danger);
      color: var(--danger);
    }
    button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    form {
      display: flex;
      gap: 8px;
      padding: 12px;
      border-bottom: 1px solid var(--line);
    }
    input {
      width: 100%;
      min-height: 34px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 5px 9px;
      color: var(--ink);
      background: #fff;
    }
    pre {
      margin: 0;
      padding: 12px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 12px;
      line-height: 1.45;
      color: #2f3834;
    }
    .empty {
      padding: 12px;
      color: var(--muted);
      font-size: 13px;
    }
    .footer-actions {
      display: flex;
      justify-content: flex-end;
      padding: 12px;
      border-top: 1px solid var(--line);
    }
    @media (max-width: 980px) {
      main { grid-template-columns: 1fr; }
      header { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Stronk Search Curator</h1>
    <div class="meta" id="meta"></div>
  </header>
  <main>
    <section class="panel">
      <h2>Queries</h2>
      <div id="queries"></div>
    </section>
    <section class="panel">
      <h2>Results</h2>
      <div id="results"></div>
    </section>
    <section class="panel">
      <h2>Review</h2>
      <form id="followup">
        <input id="followup-query" autocomplete="off" placeholder="Follow-up query">
        <button class="primary" type="submit">Search</button>
      </form>
      <div class="footer-actions">
        <button class="primary" id="finish" type="button">Finish</button>
      </div>
      <pre id="preview"></pre>
    </section>
  </main>
  <script>
    const TOKEN = ${JSON.stringify(token)};
    let state = {};
    let preview = '';

    function esc(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[char]);
    }

    function stateUrl(path) {
      return path + '?token=' + encodeURIComponent(TOKEN);
    }

    async function postAction(action, payload = {}) {
      const response = await fetch(stateUrl('/action'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'curator action failed');
      if (data.state) state = data.state;
      if (action === 'fetch') preview = data.text || '';
      if (data.error) preview = data.error;
      render();
    }

    function renderMeta() {
      const items = [
        ['Provider', state.provider],
        ['Workflow', state.workflow],
        ['Concurrency', state.concurrency],
        ['Review', state.review?.reviewId || 'pending'],
        ['Results', state.results?.length || 0]
      ];
      document.getElementById('meta').innerHTML = items
        .map(([label, value]) => '<span class="pill">' + esc(label) + ': ' + esc(value) + '</span>')
        .join('');
    }

    function renderQueries() {
      const queries = state.queries || [];
      document.getElementById('queries').innerHTML = queries.length
        ? queries.map((query) => '<div class="query"><div class="status ' + esc(query.status) + '">' + esc(query.status) + '</div><div>' + esc(query.query) + '</div></div>').join('')
        : '<div class="empty">Waiting for queries</div>';
    }

    function renderResults() {
      const results = state.results || [];
      const kept = new Set(state.review?.keptUrls || []);
      const dismissed = new Set(state.review?.dismissedUrls || []);
      document.getElementById('results').innerHTML = results.length
        ? results.map((result) => {
          const classes = ['result'];
          if (kept.has(result.url)) classes.push('kept');
          if (dismissed.has(result.url)) classes.push('dismissed');
          const disabled = state.review?.finished ? ' disabled' : '';
          return '<article class="' + classes.join(' ') + '">'
            + '<h3 class="title">' + esc(result.rank) + '. ' + esc(result.title) + '</h3>'
            + '<p class="url">' + esc(result.url) + '</p>'
            + (result.snippet ? '<p class="snippet">' + esc(result.snippet) + '</p>' : '')
            + '<div class="actions">'
            + '<button data-action="keep" data-url="' + esc(result.url) + '"' + disabled + '>Keep</button>'
            + '<button class="danger" data-action="dismiss" data-url="' + esc(result.url) + '"' + disabled + '>Dismiss</button>'
            + '<button data-action="fetch" data-url="' + esc(result.url) + '"' + disabled + '>Fetch</button>'
            + '</div>'
            + '</article>';
        }).join('')
        : '<div class="empty">Waiting for results</div>';
    }

    function renderReview() {
      document.getElementById('preview').textContent = preview || (state.review?.finished ? 'Review finished.' : '');
      document.getElementById('finish').disabled = Boolean(state.review?.finished || !state.review?.reviewId);
    }

    function render() {
      renderMeta();
      renderQueries();
      renderResults();
      renderReview();
    }

    document.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      button.disabled = true;
      try {
        await postAction(button.dataset.action, { searchResultUrl: button.dataset.url });
      } catch (error) {
        preview = error.message;
        render();
      }
    });

    document.getElementById('finish').addEventListener('click', async () => {
      try {
        await postAction('finish');
      } catch (error) {
        preview = error.message;
        render();
      }
    });

    document.getElementById('followup').addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = document.getElementById('followup-query');
      const followUpQuery = input.value.trim();
      if (!followUpQuery) return;
      input.value = '';
      preview = '';
      render();
      try {
        await postAction('follow-up', { followUpQuery });
      } catch (error) {
        preview = error.message;
        render();
      }
    });

    async function loadState() {
      const response = await fetch(stateUrl('/state'));
      const data = await response.json();
      state = data.state || {};
      render();
    }

    const events = new EventSource(stateUrl('/events'));
    for (const eventName of ['state', 'update', 'review', 'action', 'timeout', 'closed']) {
      events.addEventListener(eventName, (event) => {
        const data = JSON.parse(event.data || '{}');
        if (data.state) state = data.state;
        if (eventName === 'closed') events.close();
        render();
      });
    }
    events.onerror = () => {};
    loadState().catch((error) => {
      preview = error.message;
      render();
    });
  </script>
</body>
</html>`;
}

function openSearchCuratorUrl(url, options = {}) {
  if (typeof options.openUrl === 'function') {
    return options.openUrl(url);
  }
  return false;
}

function shouldStartBrowserCurator(workflowInfo, options = {}) {
  return options.browserCurator === true
    && options.browserCuratorTestOnly === true
    && workflowInfo.workflow === 'summary-review'
    && workflowInfo.uiAvailable;
}

function curatorActionPayload(result) {
  const text = redactProviderText(result?.content?.[0]?.text ?? '', MAX_CURATOR_PREVIEW_CHARS);
  return {
    ok: true,
    text,
    details: redact(result?.details ?? {}),
  };
}

async function startSearchCuratorSession({ provider, search, workflowInfo, concurrency, queryStates, signal, onUpdate, options }) {
  const token = randomUUID();
  const clients = new Set();
  let finishResolve;
  let closed = false;
  let finishedResult;
  let server;
  const timeoutMs = curatorTimeoutMs(options);
  const state = {
    sessionId: `search-curator-${token.slice(0, 8)}`,
    provider,
    workflow: workflowInfo.workflow,
    requestedWorkflow: workflowInfo.requestedWorkflow,
    queryCount: search.queries.length,
    requestedCount: search.count,
    concurrency,
    queries: querySnapshot(queryStates),
    results: [],
    errors: [],
    cancelledQueryIds: [],
    contentFetchTool: SAFE_FETCH_TOOL,
    actions: SEARCH_REVIEW_ACTIONS,
    browser: {
      openAttempted: false,
      tokenRequired: true,
      timeoutMs,
    },
    completed: false,
    timedOut: false,
    reviewTimedOut: false,
  };
  const finishPromise = new Promise((resolveFinish) => {
    finishResolve = resolveFinish;
  });

  const publicState = () => redact({
    ...state,
    review: state.review ? redact(state.review) : undefined,
  });
  const broadcast = (event, payload = {}) => {
    if (closed && event !== 'closed') return;
    const data = { ...payload, state: publicState() };
    for (const client of clients) {
      sendCuratorEvent(client, event, data);
    }
  };
  const updateFromDetails = (details = {}) => {
    if (Array.isArray(details.queryStates)) state.queries = details.queryStates;
    if (Array.isArray(details.results)) state.results = details.results;
    if (Array.isArray(details.errors)) state.errors = details.errors;
    if (Array.isArray(details.cancelledQueryIds)) state.cancelledQueryIds = details.cancelledQueryIds;
    if (details.review) state.review = details.review;
    if (details.reviewId && !state.review) state.review = { reviewId: details.reviewId };
    if (typeof details.count === 'number') state.resultCount = details.count;
    if (typeof details.timedOut === 'boolean') state.timedOut = details.timedOut;
  };
  const closeSession = (reason = 'closed') => {
    if (closed) return;
    closed = true;
    state.closed = true;
    state.closeReason = reason;
    broadcast('closed', { reason });
    for (const client of clients) client.end();
    clients.clear();
    server?.close?.(() => {});
    if (!finishedResult) finishResolve(undefined);
  };
  const actionOnUpdate = (update) => {
    const details = update?.details ? redact(update.details) : {};
    if (details.tool === WEB_SEARCH_TOOL) {
      if (Array.isArray(details.queries)) state.queries = details.queries;
      if (Array.isArray(details.results) && details.results.length > 0) {
        const seen = new Set(state.results.map((result) => result.url));
        for (const result of details.results) {
          if (result?.url && !seen.has(result.url)) {
            seen.add(result.url);
            state.results.push(result);
          }
        }
      }
      broadcast('update', { update: details });
    }
    if (typeof onUpdate === 'function') onUpdate(update);
  };
  const handleAction = async (body) => {
    if (hasSensitiveContent(body)) throw new Error('curator action contains secret-like content');
    let action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : '';
    if (action === 'followup') action = 'follow-up';
    if (!SEARCH_REVIEW_ACTION_SET.has(action)) {
      throw new Error(`curator action must be one of: ${SEARCH_REVIEW_ACTIONS.join(', ')}`);
    }
    if (!state.review?.reviewId) {
      const error = new Error('curator review is not ready yet');
      error.statusCode = 409;
      throw error;
    }
    const params = {
      curatorAction: action,
      reviewId: state.review.reviewId,
    };
    if (['keep', 'dismiss', 'fetch'].includes(action)) {
      params.searchResultUrl = body.searchResultUrl ?? body.resultUrl ?? body.url;
    }
    if (action === 'follow-up') {
      params.followUpQuery = body.followUpQuery ?? body.query ?? body.q;
    }
    const result = await executeWebSearch(params, signal, actionOnUpdate, {
      ...options,
      browserCurator: false,
    });
    updateFromDetails(result.details);
    const payload = curatorActionPayload(result);
    if (action === 'fetch') {
      state.preview = {
        sourceUrl: result.details?.sourceUrl,
        text: payload.text,
      };
    }
    broadcast('action', { action, result: payload });
    if (action === 'finish') {
      finishedResult = result;
      finishedResult.details = {
        ...finishedResult.details,
        browserCurator: {
          finished: true,
          openAttempted: state.browser.openAttempted === true,
          opened: state.browser.opened === true,
          tokenRequired: true,
          timeoutMs,
        },
      };
      finishResolve(finishedResult);
      setTimeout(() => closeSession('finished'), 25);
    }
    return payload;
  };

  server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      if (requestUrl.searchParams.get('token') !== token) {
        sendCuratorError(response, 403, new Error('curator token denied'));
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/') {
        const body = curatorHtml(token);
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(body),
        });
        response.end(body);
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/state') {
        sendCuratorJson(response, 200, { ok: true, state: publicState() });
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/events') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        clients.add(response);
        sendCuratorEvent(response, 'state', { state: publicState() });
        request.on('close', () => {
          clients.delete(response);
        });
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/action') {
        const body = await readCuratorJson(request);
        const payload = await handleAction(body);
        sendCuratorJson(response, 200, { ...payload, state: publicState() });
        return;
      }
      sendCuratorError(response, 404, new Error('curator route not found'));
    } catch (error) {
      sendCuratorError(response, error.statusCode || 400, error);
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off('listening', onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/?token=${encodeURIComponent(token)}`;
  try {
    state.browser.openAttempted = typeof options.openUrl === 'function';
    state.browser.opened = openSearchCuratorUrl(url, options) !== false;
  } catch (error) {
    state.browser.opened = false;
    state.browser.error = searchErrorMessage(error);
  }
  const onAbort = () => closeSession('aborted');
  signal?.addEventListener?.('abort', onAbort, { once: true });

  return {
    pushUpdate(update) {
      if (closed) return;
      if (Array.isArray(update.queries)) state.queries = update.queries;
      if (Array.isArray(update.results) && update.results.length > 0) {
        const seen = new Set(state.results.map((result) => result.url));
        for (const result of update.results) {
          if (result?.url && !seen.has(result.url)) {
            seen.add(result.url);
            state.results.push(result);
          }
        }
      }
      if (update.state === 'completed') state.completed = true;
      broadcast('update', { update });
    },
    setReview(details, review) {
      if (closed) return;
      updateFromDetails({ ...details, review });
      broadcast('review', { review });
    },
    waitForFinishOrTimeout(ms = timeoutMs) {
      if (!Number.isFinite(ms) || ms <= 0 || finishedResult) {
        return Promise.resolve(finishedResult);
      }
      return new Promise((resolveWait) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          state.reviewTimedOut = true;
          broadcast('timeout', { timeoutMs: ms });
          closeSession('timeout');
          resolveWait(undefined);
        }, ms);
        finishPromise.then((result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolveWait(result);
        });
      });
    },
    close(reason) {
      signal?.removeEventListener?.('abort', onAbort);
      closeSession(reason);
    },
    publicState,
  };
}

async function runBounded(items, concurrency, runItem, shouldStop) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!shouldStop()) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await runItem(items[index], index);
    }
  });
  await Promise.all(workers);
}

function searchErrorMessage(error, secretValues = []) {
  return redactSearchError(error?.message ?? String(error), secretValues) || 'search failed';
}

function searchResultHost(result) {
  try {
    return new URL(result?.url || '').hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function normalizedResultTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\b(202[0-9]|20[0-9]{2})\b/g, '')
    .replace(/\b(guide|tutorial|review|comparison|vs|versus|best|top|complete|ultimate|updated)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isKnownOfficialDocsHost(host) {
  return KNOWN_OFFICIAL_DOC_HOSTS.has(host);
}

function isFetchFrictionHost(host) {
  return FETCH_FRICTION_HOSTS.has(host) || [...FETCH_FRICTION_HOSTS].some((entry) => host.endsWith(`.${entry}`));
}

function searchRankingIntent(search) {
  const combined = (search?.queries || [search?.query || '']).join(' ').toLowerCase();
  if (/\b(official|docs?|documentation|api|reference|migration|guide)\b/.test(combined)) return 'official';
  if (/\b(vs|versus|compare|comparison|best|choose|which|better|alternative)\b/.test(combined)) return 'comparison';
  return 'general';
}

function classifySearchResult(result) {
  const host = searchResultHost(result);
  const path = (() => {
    try {
      return new URL(result?.url || '').pathname.toLowerCase();
    } catch {
      return '';
    }
  })();
  const title = String(result?.title || '').toLowerCase();
  const snippet = String(result?.snippet || '').toLowerCase();
  const combined = `${title} ${snippet}`;
  const signals = [];
  let sourceKind = 'web';
  let sourceReliability = 'unknown';
  let sourceAccessibility;

  if (
    isKnownOfficialDocsHost(host)
  ) {
    sourceKind = 'official-docs';
    sourceReliability = 'primary';
    signals.push('official-docs', 'primary-source');
  } else if (
    path.includes('/docs')
    || path.includes('/documentation')
    || path.includes('/reference')
    || path.includes('/api')
  ) {
    sourceKind = 'documentation';
    sourceReliability = 'secondary';
    signals.push('documentation', 'verify-owner');
  } else if (host === 'github.com' || host.endsWith('.github.com') || host === 'gitlab.com') {
    sourceKind = 'repository';
    sourceReliability = 'primary';
    signals.push('repository', 'primary-source');
  } else if (host === 'npmjs.com' || host === 'pypi.org') {
    sourceKind = 'package-registry';
    sourceReliability = 'primary';
    signals.push('package-registry', 'primary-source');
  } else if (/\b(vs|versus|compare|comparison|best|top|alternatives?)\b/i.test(combined)) {
    sourceKind = 'comparison-guide';
    sourceReliability = 'secondary';
    signals.push('comparison-guide', 'verify-claims');
  } else if (host.includes('blog') || host === 'medium.com' || host === 'dev.to' || path.includes('/blog')) {
    sourceKind = 'blog-or-guide';
    sourceReliability = 'secondary';
    signals.push('blog-or-guide', 'verify-claims');
  }

  if (/\b(benchmark|faster|slower|cost|downloads?|market share|%|x)\b/i.test(combined)) {
    signals.push('verify-quantitative-claims');
  }

  if (isFetchFrictionHost(host)) {
    sourceAccessibility = 'restricted';
    signals.push('fetch-risk', 'paywall-or-anti-scraping');
    if (sourceReliability === 'unknown') {
      sourceKind = 'blog-or-guide';
      sourceReliability = 'secondary';
    }
  }

  return {
    sourceKind,
    sourceReliability,
    ...(sourceAccessibility ? { sourceAccessibility } : {}),
    qualitySignals: [...new Set(signals)],
  };
}

function annotateSearchResults(results) {
  const hostCounts = new Map();
  for (const result of results) {
    const host = searchResultHost(result);
    if (host) hostCounts.set(host, (hostCounts.get(host) || 0) + 1);
  }

  const firstByTitle = new Map();
  return results.map((result) => {
    const classification = classifySearchResult(result);
    const annotated = { ...result };
    if (classification.sourceKind !== 'web' || classification.sourceReliability !== 'unknown' || classification.qualitySignals.length > 0) {
      annotated.sourceKind = classification.sourceKind;
      annotated.sourceReliability = classification.sourceReliability;
    }
    if (classification.sourceAccessibility) annotated.sourceAccessibility = classification.sourceAccessibility;
    if (classification.qualitySignals.length > 0) {
      annotated.qualitySignals = classification.qualitySignals;
    }
    const host = searchResultHost(annotated);
    const titleKey = normalizedResultTitle(annotated.title);
    if (hostCounts.get(host) > 1) {
      annotated.sameHostCount = hostCounts.get(host);
      annotated.qualitySignals = [...new Set([...(annotated.qualitySignals || []), `same-host-${annotated.sameHostCount}`])];
    }
    if (titleKey && titleKey.length >= 12) {
      const duplicateOfRank = firstByTitle.get(titleKey);
      if (duplicateOfRank) {
        annotated.duplicateOfRank = duplicateOfRank;
        annotated.qualitySignals = [...new Set([...(annotated.qualitySignals || []), `possible-duplicate-of-rank-${duplicateOfRank}`])];
      } else {
        firstByTitle.set(titleKey, annotated.rank);
      }
    }
    return annotated;
  });
}

function searchResultRankingPenalty(search, result, hostOrdinal = 0) {
  const classification = classifySearchResult(result);
  const intent = searchRankingIntent(search);
  let penalty = 0;
  if (classification.sourceReliability === 'primary') {
    penalty -= intent === 'official' ? 40 : 24;
  } else if (classification.sourceKind === 'documentation') {
    penalty -= intent === 'official' ? 12 : 4;
  } else if (classification.sourceReliability === 'secondary') {
    penalty += intent === 'official' ? 8 : 0;
  }
  if (classification.sourceAccessibility === 'restricted') penalty += 26;
  if (hostOrdinal > 0) {
    penalty += Math.min(40, hostOrdinal * 12);
    if (classification.sourceReliability === 'primary') penalty -= 8;
  }
  return penalty;
}

function mergeSearchResults(search, providerResults) {
  const seenUrls = new Set();
  const candidates = [];
  for (let queryIndex = 0; queryIndex < search.queries.length; queryIndex += 1) {
    const providerResult = providerResults[queryIndex];
    const rawResults = Array.isArray(providerResult?.results)
      ? [...providerResult.results].sort((a, b) => (Number(a.rank) || Number.MAX_SAFE_INTEGER) - (Number(b.rank) || Number.MAX_SAFE_INTEGER))
      : [];
    const hostOrdinals = new Map();
    for (const result of rawResults) {
      if (!result?.url || seenUrls.has(result.url)) continue;
      seenUrls.add(result.url);
      const host = searchResultHost(result);
      const hostOrdinal = host ? (hostOrdinals.get(host) || 0) : 0;
      if (host) hostOrdinals.set(host, hostOrdinal + 1);
      candidates.push({
        ...result,
        ...(search.queries.length > 1 ? { query: search.queries[queryIndex] } : {}),
        queryIndex,
        providerRank: Number(result.rank) || Number.MAX_SAFE_INTEGER,
        hostOrdinal,
        originalOrder: candidates.length,
      });
    }
  }
  const ranked = candidates.sort((a, b) => (
    a.queryIndex - b.queryIndex
    || searchResultRankingPenalty(search, a, a.hostOrdinal) - searchResultRankingPenalty(search, b, b.hostOrdinal)
    || a.providerRank - b.providerRank
    || a.originalOrder - b.originalOrder
  ));
  const results = ranked.map((result, index) => {
    const { queryIndex: _queryIndex, providerRank: _providerRank, hostOrdinal: _hostOrdinal, originalOrder: _originalOrder, ...clean } = result;
    return { ...clean, rank: index + 1 };
  });
  return annotateSearchResults(results);
}

function ensureSearchReviewState(options = {}) {
  const state = options.reviewState ?? options.state;
  if (!state || typeof state !== 'object') return undefined;
  if (!(state.searchReviews instanceof Map)) state.searchReviews = new Map();
  if (!Number.isInteger(state.nextSearchReviewId) || state.nextSearchReviewId < 1) {
    state.nextSearchReviewId = 1;
  }
  return state;
}

function reviewResultId(result) {
  const rank = Number(result?.rank);
  return Number.isInteger(rank) && rank > 0 ? `result-${rank}` : 'result-unknown';
}

function reviewContentStatus(session, result) {
  if (!session || !result?.url) return {};
  if (session.fetchedUrls?.has(result.url)) {
    return { contentStatus: 'fetched', fetchRecommendedBeforeUse: false };
  }
  if (session.fetchFailedUrls?.has(result.url)) {
    return {
      contentStatus: 'fetch-failed',
      fetchRecommendedBeforeUse: true,
      fetchError: session.fetchFailedUrls.get(result.url),
    };
  }
  return { contentStatus: 'snippet-only', fetchRecommendedBeforeUse: true };
}

function reviewResultSummary(result, session) {
  const contentStatus = reviewContentStatus(session, result);
  return {
    resultId: reviewResultId(result),
    rank: result.rank,
    title: result.title,
    url: result.url,
    ...(result.query ? { query: result.query } : {}),
    ...(result.sourceKind ? { sourceKind: result.sourceKind } : {}),
    ...(result.sourceReliability ? { sourceReliability: result.sourceReliability } : {}),
    ...(result.sourceAccessibility ? { sourceAccessibility: result.sourceAccessibility } : {}),
    ...(Array.isArray(result.qualitySignals) && result.qualitySignals.length > 0 ? { qualitySignals: result.qualitySignals } : {}),
    ...(result.duplicateOfRank ? { duplicateOfRank: result.duplicateOfRank } : {}),
    ...contentStatus,
  };
}

function serializeSearchReview(session) {
  const keptResults = session.results.filter((result) => session.keptUrls.has(result.url));
  const dismissedResults = session.results.filter((result) => session.dismissedUrls.has(result.url));
  const availableResults = session.results.filter((result) => !session.dismissedUrls.has(result.url));
  const duplicateCount = session.results.filter((result) => result.duplicateOfRank).length;
  const sourceSummary = session.results.reduce((acc, result) => {
    const key = result.sourceReliability || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return {
    reviewId: session.id,
    provider: session.provider,
    workflow: session.workflow,
    actions: SEARCH_REVIEW_ACTIONS,
    queryCount: session.queries.length,
    resultCount: session.results.length,
    availableResultCount: session.results.length - session.dismissedUrls.size,
    keptCount: session.keptUrls.size,
    dismissedCount: session.dismissedUrls.size,
    keptUrls: [...session.keptUrls],
    dismissedUrls: [...session.dismissedUrls],
    availableResults: availableResults.map((result) => reviewResultSummary(result, session)),
    keptResults: keptResults.map((result) => reviewResultSummary(result, session)),
    dismissedResults: dismissedResults.map((result) => reviewResultSummary(result, session)),
    duplicateCount,
    sourceSummary,
    finished: Boolean(session.finishedAt),
    contentFetchTool: SAFE_FETCH_TOOL,
  };
}

function recordSearchReview(details, options = {}) {
  const state = ensureSearchReviewState(options);
  if (!state) return undefined;

  let session;
  if (options.reviewSessionId) {
    session = state.searchReviews.get(options.reviewSessionId);
    if (!session) throw new Error(`web_search review session not found: ${options.reviewSessionId}`);
    session.queries.push(...details.queries);
    session.results.push(...details.results.filter((result) => !session.results.some((existing) => existing.url === result.url)));
    session.errors.push(...(details.errors ?? []));
    return serializeSearchReview(session);
  }

  if (details.workflow !== 'summary-review') return undefined;
  const id = `search-review-${state.nextSearchReviewId}`;
  state.nextSearchReviewId += 1;
  session = {
    id,
    provider: details.provider,
    workflow: details.workflow,
    requestedWorkflow: details.requestedWorkflow,
    queries: [...details.queries],
    count: details.requestedCount,
    results: [...details.results],
    errors: [...(details.errors ?? [])],
    keptUrls: new Set(),
    dismissedUrls: new Set(),
    fetchedUrls: new Set(),
    fetchFailedUrls: new Map(),
    createdAt: new Date().toISOString(),
    finishedAt: undefined,
  };
  state.searchReviews.set(id, session);
  return serializeSearchReview(session);
}

function requireSearchReviewSession(options = {}, reviewId) {
  const state = ensureSearchReviewState(options);
  const session = state?.searchReviews.get(reviewId);
  if (!session) throw new Error(`web_search review session not found: ${reviewId}`);
  if (!(session.fetchedUrls instanceof Set)) session.fetchedUrls = new Set();
  if (!(session.fetchFailedUrls instanceof Map)) session.fetchFailedUrls = new Map();
  return { state, session };
}

function requireReviewResult(session, selector) {
  if (typeof selector === 'string') {
    const safeUrl = searchResultUrl(selector);
    const result = safeUrl ? session.results.find((item) => item.url === safeUrl) : undefined;
    if (!result) throw new Error('web_search selected result is not in the review result set');
    return result;
  }
  const safeUrl = selector?.searchResultUrl ? searchResultUrl(selector.searchResultUrl) : undefined;
  let result = safeUrl ? session.results.find((item) => item.url === safeUrl) : undefined;
  if (!result && selector?.resultRank !== undefined) {
    result = session.results.find((item) => Number(item.rank) === selector.resultRank);
  }
  if (!result && selector?.resultId) {
    result = session.results.find((item) => reviewResultId(item) === selector.resultId);
  }
  if (!result) {
    throw new Error('web_search selected result is not in the review result set');
  }
  return result;
}

function requireReviewResults(session, search) {
  const selectors = Array.isArray(search.selectors) && search.selectors.length > 0
    ? search.selectors
    : [search];
  const selected = new Map();
  for (const selector of selectors) {
    const result = requireReviewResult(session, selector);
    selected.set(result.url, result);
  }
  return [...selected.values()].sort((a, b) => (Number(a.rank) || Number.MAX_SAFE_INTEGER) - (Number(b.rank) || Number.MAX_SAFE_INTEGER));
}

function formatSelectedReviewResults(results) {
  return results.map((result) => `#${result.rank} (${reviewResultId(result)})`).join(', ');
}

function recordReviewFetchOutcome(session, urls, details = {}) {
  if (!(session.fetchedUrls instanceof Set)) session.fetchedUrls = new Set();
  if (!(session.fetchFailedUrls instanceof Map)) session.fetchFailedUrls = new Map();
  const urlList = Array.isArray(urls) ? urls : [urls].filter(Boolean);
  if (Array.isArray(details.results)) {
    for (const result of details.results) {
      const url = result.url || result.finalUrl;
      if (!url) continue;
      if (result.error) {
        session.fetchFailedUrls.set(url, redactSearchError(result.error));
        session.fetchedUrls.delete(url);
      } else {
        session.fetchedUrls.add(url);
        session.fetchFailedUrls.delete(url);
      }
    }
    return;
  }
  if (Number(details.successful) > 0) {
    for (const url of urlList) {
      session.fetchedUrls.add(url);
      session.fetchFailedUrls.delete(url);
    }
  } else {
    const error = redactSearchError(details.error || 'fetch failed');
    for (const url of urlList) {
      session.fetchFailedUrls.set(url, error);
      session.fetchedUrls.delete(url);
    }
  }
}

function formatReviewStateLines(review, options = {}) {
  if (!review?.reviewId) return [];
  const includeActions = options.includeActions !== false;
  const lines = [
    'Review state:',
    `- reviewId: ${review.reviewId}`,
    `- kept=${review.keptCount ?? review.keptUrls?.length ?? 0} dismissed=${review.dismissedCount ?? review.dismissedUrls?.length ?? 0} available=${review.availableResultCount ?? review.resultCount ?? 0} total=${review.resultCount ?? 0}`,
  ];
  const selectorRange = formatResultSelectorRange(review.resultCount ?? review.availableResultCount ?? 0);
  if (selectorRange) lines.push(`- selectors: ${selectorRange}`);
  if (review.duplicateCount) lines.push(`- possibleDuplicates=${review.duplicateCount}`);
  const summary = formatSourceSummary(review.sourceSummary);
  if (summary) lines.push(`- sourceReliability=${summary}`);
  if (Array.isArray(review.keptResults) && review.keptResults.length > 0) {
    lines.push('- keptResults:');
    for (const result of review.keptResults.slice(0, 8)) {
      const source = result.sourceKind ? ` source=${result.sourceKind}/${result.sourceReliability || 'unknown'}` : '';
      const content = result.contentStatus ? ` content=${result.contentStatus}` : '';
      lines.push(`  - #${result.rank} resultId: ${result.resultId || `result-${result.rank}`}${source}${content}`);
    }
    if (review.keptResults.length > 8) lines.push(`  - ... ${review.keptResults.length - 8} more kept result(s)`);
  }
  if (includeActions) {
    lines.push('- action parameters:');
    lines.push(`  - keep/dismiss/fetch: curatorAction=<action>, reviewId=${review.reviewId}, resultRank=<rank> (or resultId=result-<rank> or searchResultUrl=<exact result URL from details.results>)`);
    lines.push(`  - bulk keep/dismiss: curatorAction=<keep|dismiss>, reviewId=${review.reviewId}, resultRanks=[1,2] (or resultIds=[result-1,result-2])`);
    lines.push(`  - fetch-kept: curatorAction=fetch-kept, reviewId=${review.reviewId} (explicit guarded ${SAFE_FETCH_TOOL}, max ${MAX_FETCH_URLS} URLs)`);
    lines.push(`  - follow-up: curatorAction=follow-up, reviewId=${review.reviewId}, followUpQuery=<query>`);
    lines.push(`  - finish: curatorAction=finish, reviewId=${review.reviewId}`);
    lines.push(`  - status: curatorAction=status, reviewId=${review.reviewId}`);
  }
  return lines;
}

function formatReviewActionOutput(prefix, review, extraLines = []) {
  const modelLines = [];
  if (Array.isArray(review?.availableResults) && review.availableResults.length > 0) {
    modelLines.push('', ...formatSearchResultRecordLines(review.availableResults, { heading: 'Available result records for model:' }));
  }
  if (Array.isArray(review?.keptResults) && review.keptResults.length > 0) {
    modelLines.push('', ...formatSearchResultRecordLines(review.keptResults, { heading: 'Kept result records for model:' }));
  }
  return [
    prefix,
    '',
    ...formatReviewStateLines(review, { includeActions: true }),
    ...modelLines,
    ...extraLines,
  ].filter((line) => line !== undefined).join('\n');
}

function formatSearchOutput({ provider, query, queries = [query], results, answer, errors = [], cancelledQueryIds = [], review }) {
  const lines = [
    `# ${WEB_SEARCH_TOOL} (${provider})`,
    '',
    `Query: ${query}`,
    ...(queries.length > 1 ? [`Queries: ${queries.length}`] : []),
    `Results: ${results.length}`,
    `Content fetch: explicit ${SAFE_FETCH_TOOL} only`,
  ];
  lines.push(...formatSearchResultSummaryLines(results));
  if (answer) {
    lines.push('', 'Provider answer:');
    lines.push(modelRecordText(answer, 2000));
  }
  if (results.length > 0) {
    lines.push('', ...formatSearchResultRecordLines(results));
  }
  if (review?.reviewId) {
    lines.push(`Review ID: ${review.reviewId}`);
    if (Array.isArray(review.actions) && review.actions.length > 0) {
      lines.push(`Curator actions: ${review.actions.join(', ')}`);
    }
    lines.push(...formatReviewStateLines(review, { includeActions: true }));
  }
  if (results.length === 0) {
    lines.push('', '(no results)');
  }
  if (errors.length > 0) {
    lines.push('', 'Errors:');
    for (const error of errors) {
      lines.push(`- ${error.queryId || 'query'}: ${error.message}`);
    }
  }
  if (cancelledQueryIds.length > 0) {
    lines.push('', `Cancelled: ${cancelledQueryIds.join(', ')}`);
  }
  return lines.join('\n');
}

function formatCodeSearchOutput({ mode, provider, query, effectiveQuery, results, answer, errors = [], cancelledQueryIds = [] }) {
  const lines = [
    `# ${CODE_SEARCH_TOOL} (${mode === 'exa' ? 'exa' : `web_search fallback: ${provider}`})`,
    '',
    `Query: ${query}`,
  ];
  if (effectiveQuery && effectiveQuery !== query) lines.push(`Effective query: ${effectiveQuery}`);
  lines.push(`Results: ${results.length}`);
  lines.push(`Content fetch: explicit ${SAFE_FETCH_TOOL} only`);
  lines.push(...formatSearchResultSummaryLines(results));
  if (answer) {
    lines.push('', 'Provider answer:');
    lines.push(modelRecordText(answer, 2000));
  }
  if (results.length > 0) {
    lines.push('', ...formatSearchResultRecordLines(results));
  }
  if (results.length === 0) {
    lines.push('', '(no results)');
  }
  if (errors.length > 0) {
    lines.push('', 'Errors:');
    for (const error of errors) {
      lines.push(`- ${error.message}`);
    }
  }
  if (cancelledQueryIds.length > 0) {
    lines.push('', `Cancelled: ${cancelledQueryIds.join(', ')}`);
  }
  return lines.join('\n');
}

async function executeSearchReviewAction(search, signal, onUpdate, options = {}) {
  const { session } = requireSearchReviewSession(options, search.reviewId);
  if (search.curatorAction === 'status') {
    const review = serializeSearchReview(session);
    return toolResult(formatReviewActionOutput(`Status for review ${session.id}`, review), {
      action: 'status',
      review,
    });
  }
  if (session.finishedAt && search.curatorAction !== 'finish') {
    throw new Error('web_search review session is finished');
  }
  if (search.curatorAction === 'keep') {
    const results = requireReviewResults(session, search);
    for (const result of results) {
      session.keptUrls.add(result.url);
      session.dismissedUrls.delete(result.url);
    }
    const review = serializeSearchReview(session);
    const prefix = results.length === 1
      ? `Kept result ${formatSelectedReviewResults(results)}`
      : `Kept ${results.length} results: ${formatSelectedReviewResults(results)}`;
    return toolResult(formatReviewActionOutput(prefix, review), {
      action: 'keep',
      result: results[0],
      results,
      review,
    });
  }
  if (search.curatorAction === 'dismiss') {
    const results = requireReviewResults(session, search);
    for (const result of results) {
      session.dismissedUrls.add(result.url);
      session.keptUrls.delete(result.url);
    }
    const review = serializeSearchReview(session);
    const prefix = results.length === 1
      ? `Dismissed result ${formatSelectedReviewResults(results)}`
      : `Dismissed ${results.length} results: ${formatSelectedReviewResults(results)}`;
    return toolResult(formatReviewActionOutput(prefix, review), {
      action: 'dismiss',
      result: results[0],
      results,
      review,
    });
  }
  if (search.curatorAction === 'fetch') {
    const result = requireReviewResult(session, search);
    const fetchContent = options.fetchContent ?? executeFetchContent;
    const fetched = await fetchContent({ url: result.url }, signal, onUpdate);
    recordReviewFetchOutcome(session, [result.url], fetched.details || {});
    const review = serializeSearchReview(session);
    return toolResult([
      `Fetched result #${result.rank} (${redactUrlForPreview(result.url)}) through ${SAFE_FETCH_TOOL}.`,
      '',
      ...formatReviewStateLines(review, { includeActions: true }),
      '',
      fetched.content?.[0]?.text ?? '',
    ].join('\n'), {
      action: 'fetch',
      sourceUrl: result.url,
      contentFetchTool: SAFE_FETCH_TOOL,
      fetch: metadataOnlyFetchDetails(fetched.details),
      review,
    });
  }
  if (search.curatorAction === 'fetch-kept') {
    const keptResults = session.results.filter((result) => session.keptUrls.has(result.url));
    if (keptResults.length === 0) {
      throw new Error('web_search curatorAction=fetch-kept requires at least one kept result');
    }
    const urls = keptResults.slice(0, MAX_FETCH_URLS).map((result) => result.url);
    const omittedCount = Math.max(0, keptResults.length - urls.length);
    const fetchContent = options.fetchContent ?? executeFetchContent;
    const fetched = await fetchContent({ urls }, signal, onUpdate);
    recordReviewFetchOutcome(session, urls, fetched.details || {});
    const review = serializeSearchReview(session);
    return toolResult([
      `Fetched ${urls.length}/${keptResults.length} kept result(s) through ${SAFE_FETCH_TOOL}.`,
      ...(omittedCount > 0 ? [`Omitted ${omittedCount} kept result(s) because ${SAFE_FETCH_TOOL} accepts at most ${MAX_FETCH_URLS} URLs per call.`] : []),
      '',
      ...formatReviewStateLines(review, { includeActions: true }),
      '',
      'Fetched URLs:',
      ...urls.map((url) => `- ${redactUrlForPreview(url)}`),
      '',
      fetched.content?.[0]?.text ?? '',
    ].join('\n'), {
      action: 'fetch-kept',
      urls,
      omittedCount,
      contentFetchTool: SAFE_FETCH_TOOL,
      fetch: metadataOnlyFetchDetails(fetched.details),
      review,
    });
  }
  if (search.curatorAction === 'follow-up') {
    return executeWebSearch(
      { query: search.followUpQuery, count: session.count, workflow: session.requestedWorkflow || search.workflow },
      signal,
      onUpdate,
      { ...options, reviewSessionId: session.id },
    );
  }
  if (search.curatorAction === 'finish') {
    session.finishedAt = new Date().toISOString();
    const keptResults = session.keptUrls.size > 0
      ? session.results.filter((result) => session.keptUrls.has(result.url))
      : session.results.filter((result) => !session.dismissedUrls.has(result.url));
    const review = serializeSearchReview(session);
    const lines = [
      `Finished review ${session.id} with ${keptResults.length} kept result(s).`,
      '',
      ...formatReviewStateLines(review, { includeActions: false }),
      '',
      'Citation-ready kept results:',
    ];
    for (const result of keptResults) {
      lines.push(`${result.rank}. ${result.title}`);
      lines.push(`   URL: ${result.url}`);
      if (result.sourceKind) lines.push(`   Source: ${result.sourceKind} (${result.sourceReliability || 'unknown'})`);
      if (result.sourceAccessibility) lines.push(`   Accessibility: ${result.sourceAccessibility}`);
      const content = reviewContentStatus(session, result);
      lines.push(`   Content: ${content.contentStatus || 'snippet-only'}${content.fetchRecommendedBeforeUse ? '; fetch_content recommended before citation' : ''}`);
      if (content.fetchError) lines.push(`   Fetch error: ${content.fetchError}`);
      if (Array.isArray(result.qualitySignals) && result.qualitySignals.length > 0) {
        lines.push(`   Signals: ${formatQualitySignals(result.qualitySignals)}`);
      }
      if (result.snippet) lines.push(`   ${result.snippet}`);
    }
    return toolResult(lines.join('\n'), {
      action: 'finish',
      review,
      keptResults,
    });
  }
  throw new Error(`unsupported web_search curatorAction: ${search.curatorAction}`);
}

function codeSearchCancelledResult({ mode, provider, search, workflowInfo, effectiveQuery }) {
  const queryState = {
    id: 'q1',
    index: 0,
    query: search.query,
    status: 'cancelled',
  };
  const cancelledQueryIds = ['q1'];
  return toolResult(formatCodeSearchOutput({
    mode,
    provider,
    query: search.query,
    effectiveQuery,
    results: [],
    cancelledQueryIds,
  }), {
    mode,
    provider,
    workflow: workflowInfo.workflow,
    requestedWorkflow: workflowInfo.requestedWorkflow,
    uiAvailable: workflowInfo.uiAvailable,
    query: search.query,
    effectiveQuery,
    count: 0,
    results: [],
    errors: [],
    cancelled: true,
    cancelledQueryIds,
    queryStates: [queryState],
    contentFetchTool: SAFE_FETCH_TOOL,
  });
}

async function executeWebSearch(params, signal, onUpdate, options = {}) {
  const env = options.env ?? process.env;
  const search = normalizeWebSearchParams(params);
  if (search.curatorAction) {
    return executeSearchReviewAction(search, signal, onUpdate, options);
  }
  const provider = normalizeSearchProvider(env);
  const key = searchProviderKey(provider, env);
  const handler = SEARCH_HANDLERS[provider];
  const workflowInfo = resolveSearchWorkflow(search.workflow, options.ctx, onUpdate);
  const concurrency = searchConcurrency(options, search.queries.length);
  const providerResults = new Array(search.queries.length);
  const errors = [];
  const cancelledQueryIds = new Set();
  const queryStates = search.queries.map((query, index) => ({
    id: `q${index + 1}`,
    index,
    query,
    status: 'queued',
  }));
  const controller = new AbortController();
  let externalAborted = false;
  let timedOut = false;
  const run = {
    toolName: WEB_SEARCH_TOOL,
    provider,
    requestedWorkflow: workflowInfo.requestedWorkflow,
    workflow: workflowInfo.workflow,
    emitUpdates: workflowInfo.emitUpdates,
    updatesClosed: false,
    onUpdate,
  };
  let browserCurator;
  let browserCuratorError;
  const onAbort = () => {
    externalAborted = true;
    run.updatesClosed = true;
    controller.abort(signal?.reason instanceof Error ? signal.reason : new Error(`${WEB_SEARCH_TOOL} cancelled`));
    browserCurator?.close?.('aborted');
  };
  signal?.addEventListener?.('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const overallTimeoutMs = Number(options.overallTimeoutMs ?? 30000);
  const timeoutTimer = Number.isFinite(overallTimeoutMs) && overallTimeoutMs > 0
    ? setTimeout(() => {
      if (!controller.signal.aborted) {
        timedOut = true;
        controller.abort(new Error(`${WEB_SEARCH_TOOL} timed out`));
      }
    }, overallTimeoutMs)
    : undefined;

  if (shouldStartBrowserCurator(workflowInfo, options)) {
    try {
      browserCurator = await startSearchCuratorSession({
        provider,
        search,
        workflowInfo,
        concurrency,
        queryStates,
        signal: controller.signal,
        onUpdate,
        options,
      });
      run.curator = browserCurator;
    } catch (error) {
      browserCuratorError = searchErrorMessage(error, [key]);
    }
  }

  emitSearchUpdate(run, {
    state: 'start',
    queryCount: search.queries.length,
    requestedCount: search.count,
    concurrency,
    queries: querySnapshot(queryStates),
  });

  try {
    await runBounded(search.queries, concurrency, async (query, index) => {
      const queryState = queryStates[index];
      if (controller.signal.aborted) return;
      queryState.status = 'running';
      emitSearchUpdate(run, {
        state: 'progress',
        query: { id: queryState.id, index, query, status: 'running' },
        queries: querySnapshot(queryStates),
      });
      try {
        const providerResult = await handler({ query, count: search.count }, key, options, controller.signal, env);
        if (controller.signal.aborted) {
          if (externalAborted) {
            queryState.status = 'cancelled';
            cancelledQueryIds.add(queryState.id);
          } else if (timedOut) {
            queryState.status = 'failed';
            queryState.error = `${WEB_SEARCH_TOOL} timed out`;
            errors.push({ queryId: queryState.id, index, query, message: queryState.error });
          }
          return;
        }
        const annotatedProviderResult = {
          ...providerResult,
          results: annotateSearchResults(providerResult.results ?? []),
        };
        providerResults[index] = annotatedProviderResult;
        queryState.status = 'results';
        queryState.resultCount = annotatedProviderResult.results.length;
        emitSearchUpdate(run, {
          state: 'result',
          query: { id: queryState.id, index, query, status: 'results' },
          resultCount: queryState.resultCount,
          results: annotatedProviderResult.results,
          queries: querySnapshot(queryStates),
        });
        queryState.status = 'complete';
        emitSearchUpdate(run, {
          state: 'progress',
          query: { id: queryState.id, index, query, status: 'complete' },
          queries: querySnapshot(queryStates),
        });
      } catch (error) {
        if (externalAborted) {
          queryState.status = 'cancelled';
          cancelledQueryIds.add(queryState.id);
          return;
        }
        queryState.status = timedOut && controller.signal.aborted ? 'failed' : 'failed';
        queryState.error = timedOut && controller.signal.aborted ? `${WEB_SEARCH_TOOL} timed out` : searchErrorMessage(error, [key]);
        errors.push({ queryId: queryState.id, index, query, message: queryState.error });
        emitSearchUpdate(run, {
          state: 'error',
          query: { id: queryState.id, index, query, status: 'failed' },
          error: queryState.error,
          queries: querySnapshot(queryStates),
        });
      }
    }, () => controller.signal.aborted);
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    signal?.removeEventListener?.('abort', onAbort);
  }

  for (const queryState of queryStates) {
    if (queryState.status === 'queued' || queryState.status === 'running') {
      if (externalAborted) {
        queryState.status = 'cancelled';
        cancelledQueryIds.add(queryState.id);
      } else if (timedOut) {
        queryState.status = 'failed';
        queryState.error = `${WEB_SEARCH_TOOL} timed out before completion`;
        errors.push({
          queryId: queryState.id,
          index: queryState.index,
          query: queryState.query,
          message: queryState.error,
        });
      }
    }
  }
  const results = mergeSearchResults(search, providerResults);
  const firstResult = providerResults.find(Boolean) ?? {};
  const details = {
    provider,
    workflow: workflowInfo.workflow,
    requestedWorkflow: workflowInfo.requestedWorkflow,
    ...(workflowInfo.fallbackReason ? { workflowFallback: workflowInfo.fallbackReason } : {}),
    uiAvailable: workflowInfo.uiAvailable,
    query: search.query,
    queries: search.queries,
    queryStates: querySnapshot(queryStates),
    queryCount: search.queries.length,
    requestedCount: search.count,
    concurrency,
    count: results.length,
    results,
    errors,
    cancelled: externalAborted,
    cancelledQueryIds: [...cancelledQueryIds],
    timedOut,
    requestId: firstResult.requestId,
    requestIds: providerResults.map((result) => result?.requestId).filter(Boolean),
    webSearchQueries: providerResults.flatMap((result) => result?.webSearchQueries ?? []),
    model: firstResult.model,
    ...(firstResult.answer ? { answer: redactProviderText(firstResult.answer) } : {}),
    contentFetchTool: SAFE_FETCH_TOOL,
    ...(browserCurator ? {
      browserCurator: {
        openAttempted: browserCurator.publicState?.().browser?.openAttempted === true,
        opened: browserCurator.publicState?.().browser?.opened === true,
        tokenRequired: true,
        timeoutMs: curatorTimeoutMs(options),
      },
    } : {}),
    ...(browserCuratorError ? {
      browserCurator: {
        openAttempted: false,
        tokenRequired: true,
        error: browserCuratorError,
      },
    } : {}),
  };
  const review = recordSearchReview(details, options);
  if (review) {
    details.review = review;
    details.reviewId = review.reviewId;
    browserCurator?.setReview?.(details, review);
  }
  emitSearchUpdate(run, {
    state: 'completed',
    resultCount: results.length,
    errorCount: errors.length,
    ...(review?.reviewId ? { reviewId: review.reviewId } : {}),
    cancelledQueryIds: [...cancelledQueryIds],
    queries: querySnapshot(queryStates),
  });
  const standardResult = toolResult(formatSearchOutput({
    provider,
    query: search.query,
    queries: search.queries,
    results,
    answer: firstResult.answer,
    errors,
    cancelledQueryIds: [...cancelledQueryIds],
    review,
  }), details);
  if (browserCurator && !externalAborted) {
    const finishedResult = await browserCurator.waitForFinishOrTimeout(curatorTimeoutMs(options));
    if (finishedResult) return finishedResult;
    details.browserCurator = {
      ...details.browserCurator,
      finished: false,
      openAttempted: browserCurator.publicState?.().browser?.openAttempted === true,
      opened: browserCurator.publicState?.().browser?.opened === true,
      tokenRequired: true,
      timeoutMs: curatorTimeoutMs(options),
    };
  }
  browserCurator?.close?.(externalAborted ? 'aborted' : 'completed');
  return standardResult;
}

async function executeCodeSearch(params, signal, onUpdate, options = {}) {
  const env = options.env ?? process.env;
  const search = normalizeCodeSearchParams(params);
  const workflowInfo = resolveSearchWorkflow(search.workflow, options.ctx, onUpdate);
  const controller = new AbortController();
  let externalAborted = false;
  const run = {
    toolName: CODE_SEARCH_TOOL,
    provider: 'exa',
    requestedWorkflow: workflowInfo.requestedWorkflow,
    workflow: workflowInfo.workflow,
    emitUpdates: workflowInfo.emitUpdates,
    updatesClosed: false,
    onUpdate,
  };
  const onAbort = () => {
    externalAborted = true;
    run.updatesClosed = true;
    controller.abort(signal?.reason instanceof Error ? signal.reason : new Error(`${CODE_SEARCH_TOOL} cancelled`));
  };
  signal?.addEventListener?.('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  try {
    const exaKey = optionalSearchProviderKey('exa', env);
    if (exaKey) {
      const effectiveQuery = buildCodeSearchQuery(search);
      if (controller.signal.aborted) {
        return codeSearchCancelledResult({ mode: 'exa', provider: 'exa', search, workflowInfo, effectiveQuery });
      }
      emitSearchUpdate(run, {
        state: 'start',
        queryCount: 1,
        requestedCount: search.count,
        queries: [{ id: 'q1', index: 0, query: search.query, status: 'running' }],
      });
      let providerResult;
      try {
        providerResult = await searchExaCode(search, exaKey, options, controller.signal);
        if (controller.signal.aborted || externalAborted) {
          return codeSearchCancelledResult({ mode: 'exa', provider: 'exa', search, workflowInfo, effectiveQuery });
        }
      } catch (error) {
        if (externalAborted || controller.signal.aborted) {
          return codeSearchCancelledResult({ mode: 'exa', provider: 'exa', search, workflowInfo, effectiveQuery });
        }
        const message = searchErrorMessage(error, [exaKey]);
        const errors = [{ queryId: 'q1', index: 0, query: search.query, message }];
        emitSearchUpdate(run, {
          state: 'error',
          query: { id: 'q1', index: 0, query: search.query, status: 'failed' },
          error: message,
          queries: [{ id: 'q1', index: 0, query: search.query, status: 'failed', error: message }],
        });
        emitSearchUpdate(run, {
          state: 'completed',
          resultCount: 0,
          errorCount: 1,
          queries: [{ id: 'q1', index: 0, query: search.query, status: 'failed', error: message }],
        });
        return toolResult(formatCodeSearchOutput({
          mode: 'exa',
          provider: 'exa',
          query: search.query,
          effectiveQuery,
          results: [],
          errors,
        }), {
          mode: 'exa',
          provider: 'exa',
          workflow: workflowInfo.workflow,
          requestedWorkflow: workflowInfo.requestedWorkflow,
          uiAvailable: workflowInfo.uiAvailable,
          query: search.query,
          effectiveQuery,
          count: 0,
          results: [],
          errors,
          contentFetchTool: SAFE_FETCH_TOOL,
        });
      }
      const results = annotateSearchResults(providerResult.results ?? []);
      emitSearchUpdate(run, {
        state: 'result',
        query: { id: 'q1', index: 0, query: search.query, status: 'results' },
        resultCount: results.length,
        results,
        queries: [{ id: 'q1', index: 0, query: search.query, status: 'results', resultCount: results.length }],
      });
      emitSearchUpdate(run, {
        state: 'completed',
        resultCount: results.length,
        errorCount: 0,
        queries: [{ id: 'q1', index: 0, query: search.query, status: 'complete', resultCount: results.length }],
      });
      return toolResult(formatCodeSearchOutput({
        mode: 'exa',
        provider: 'exa',
        query: search.query,
        effectiveQuery: providerResult.effectiveQuery,
        results,
      }), {
        mode: 'exa',
        provider: 'exa',
        workflow: workflowInfo.workflow,
        requestedWorkflow: workflowInfo.requestedWorkflow,
        uiAvailable: workflowInfo.uiAvailable,
        query: search.query,
        effectiveQuery: providerResult.effectiveQuery,
        count: results.length,
          results,
          requestId: providerResult.requestId,
          ...(providerResult.answer ? { answer: redactProviderText(providerResult.answer) } : {}),
          contentFetchTool: SAFE_FETCH_TOOL,
        });
    }

    if (!search.fallbackToWeb) {
      throw new Error(`missing EXA_API_KEY for ${CODE_SEARCH_TOOL}`);
    }

    let provider;
    let key;
    try {
      provider = normalizeSearchProvider(env);
      key = searchProviderKey(provider, env);
    } catch (error) {
      throw new Error(`missing EXA_API_KEY for ${CODE_SEARCH_TOOL} and ${error?.message ?? String(error)}`);
    }
    const effectiveQuery = buildCodeSearchQuery(search);
    const handler = SEARCH_HANDLERS[provider];
    run.provider = provider;
    if (controller.signal.aborted) {
      return codeSearchCancelledResult({ mode: 'web_search_fallback', provider, search, workflowInfo, effectiveQuery });
    }
    emitSearchUpdate(run, {
      state: 'start',
      queryCount: 1,
      requestedCount: search.count,
      queries: [{ id: 'q1', index: 0, query: search.query, status: 'running' }],
    });
    let providerResult;
    try {
      providerResult = await handler({ query: effectiveQuery, count: search.count }, key, options, controller.signal, env);
      if (controller.signal.aborted || externalAborted) {
        return codeSearchCancelledResult({ mode: 'web_search_fallback', provider, search, workflowInfo, effectiveQuery });
      }
    } catch (error) {
      if (externalAborted || controller.signal.aborted) {
        return codeSearchCancelledResult({ mode: 'web_search_fallback', provider, search, workflowInfo, effectiveQuery });
      }
      const message = searchErrorMessage(error, [key]);
      const errors = [{ queryId: 'q1', index: 0, query: search.query, message }];
      emitSearchUpdate(run, {
        state: 'error',
        query: { id: 'q1', index: 0, query: search.query, status: 'failed' },
        error: message,
        queries: [{ id: 'q1', index: 0, query: search.query, status: 'failed', error: message }],
      });
      emitSearchUpdate(run, {
        state: 'completed',
        resultCount: 0,
        errorCount: 1,
        queries: [{ id: 'q1', index: 0, query: search.query, status: 'failed', error: message }],
      });
      return toolResult(formatCodeSearchOutput({
        mode: 'web_search_fallback',
        provider,
        query: search.query,
        effectiveQuery,
        results: [],
        errors,
      }), {
        mode: 'web_search_fallback',
        provider,
        workflow: workflowInfo.workflow,
        requestedWorkflow: workflowInfo.requestedWorkflow,
        uiAvailable: workflowInfo.uiAvailable,
        query: search.query,
        effectiveQuery,
        count: 0,
        results: [],
        errors,
        contentFetchTool: SAFE_FETCH_TOOL,
      });
    }
    const results = annotateSearchResults(providerResult.results ?? []);
    emitSearchUpdate(run, {
      state: 'result',
      query: { id: 'q1', index: 0, query: search.query, status: 'results' },
      resultCount: results.length,
      results,
      queries: [{ id: 'q1', index: 0, query: search.query, status: 'results', resultCount: results.length }],
    });
    emitSearchUpdate(run, {
      state: 'completed',
      resultCount: results.length,
      errorCount: 0,
      queries: [{ id: 'q1', index: 0, query: search.query, status: 'complete', resultCount: results.length }],
    });
    return toolResult(formatCodeSearchOutput({
      mode: 'web_search_fallback',
      provider,
      query: search.query,
      effectiveQuery,
      results,
      answer: providerResult.answer,
    }), {
      mode: 'web_search_fallback',
      provider,
      workflow: workflowInfo.workflow,
      requestedWorkflow: workflowInfo.requestedWorkflow,
      uiAvailable: workflowInfo.uiAvailable,
      query: search.query,
      effectiveQuery,
      count: results.length,
      results,
      requestId: providerResult.requestId,
      webSearchQueries: providerResult.webSearchQueries,
      model: providerResult.model,
      ...(providerResult.answer ? { answer: redactProviderText(providerResult.answer) } : {}),
      contentFetchTool: SAFE_FETCH_TOOL,
    });
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
  }
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
        'User-Agent': 'Stronk-Pi/1.0 (+https://github.com/EYYCHEEV/stronk-pi-plugin)',
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
  return sanitizeExternalText(decodeHtmlEntities(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim());
}

function extractTitle(body, fallbackUrl) {
  const match = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return fallbackUrl;
  const title = sanitizeExternalText(decodeHtmlEntities(match[1].replace(/\s+/g, ' ').trim()));
  return title || fallbackUrl;
}

function formatFetchedContent(result) {
  const contentType = String(result.headers?.['content-type'] || '');
  const isHtml = /html|xml/i.test(contentType);
  const title = isHtml ? extractTitle(result.body, result.finalUrl) : result.finalUrl;
  const text = isHtml ? htmlToText(result.body) : sanitizeExternalText(result.body).trim();
  const body = text.length > 0 ? text : '(empty response)';
  return {
    title,
    text: `# ${title}\n\nSource: ${result.finalUrl}\n\n${body}`,
  };
}

function normalizeFetchUrls(params) {
  const urls = Array.isArray(params.urls) ? params.urls : (params.url ? [params.url] : []);
  if (urls.length === 0) throw new Error(`${SAFE_FETCH_TOOL} requires url or urls`);
  if (urls.length > MAX_FETCH_URLS) throw new Error(`${SAFE_FETCH_TOOL} accepts at most ${MAX_FETCH_URLS} URLs`);
  return urls.map((url, index) => {
    const rawUrl = requiredString(url, `url ${index + 1}`);
    const safeUrl = searchResultUrl(rawUrl);
    if (!safeUrl) {
      throw new Error(`${SAFE_FETCH_TOOL} URL must be a public http(s) URL without credentials, private hosts, or secret query parameters`);
    }
    return safeUrl;
  });
}

async function executeFetchContent(params, signal, onUpdate) {
  const urls = normalizeFetchUrls(params);
  const results = [];
  for (let index = 0; index < urls.length; index += 1) {
    onUpdate?.({
      content: [{ type: 'text', text: `Fetching ${index + 1}/${urls.length}: ${redact(urls[index])}` }],
      details: { phase: 'fetch', progress: index / urls.length, url: redact(urls[index]) },
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
  return toolResult(output, {
    urls,
    successful,
    total: urls.length,
    results: metadataOnlyFetchDetails(results),
  });
}

function formatFetchRenderCall(params = {}) {
  const urls = Array.isArray(params.urls) ? params.urls : (params.url ? [params.url] : []);
  const lines = [`${SAFE_FETCH_TOOL} urls=${urls.length || '?'}`];
  for (const [index, url] of urls.slice(0, MAX_FETCH_URLS).entries()) {
    lines.push(`- u${index + 1} ${compactCliText(redactUrlForPreview(url), 120)}`);
  }
  if (urls.length > MAX_FETCH_URLS) lines.push(`- ... ${urls.length - MAX_FETCH_URLS} more`);
  return lines.join('\n');
}

function formatFetchRenderResult(result = {}) {
  const details = result?.details || {};
  const rows = Array.isArray(details.results) ? details.results : [];
  const urls = Array.isArray(details.urls) ? details.urls : [];
  const total = typeof details.total === 'number' ? details.total : (rows.length || urls.length || 1);
  const successful = typeof details.successful === 'number' ? details.successful : 0;
  const lines = [
    `${SAFE_FETCH_TOOL} completed successful=${successful}/${total}`,
  ];

  if (details.error) {
    lines.push(`error: ${compactCliText(details.error, 120)}`);
  }

  if (rows.length > 0) {
    for (const [index, row] of rows.slice(0, MAX_FETCH_URLS).entries()) {
      if (row.error) {
        lines.push(`- #${index + 1} error=${compactCliText(row.error, 90)}`);
        lines.push(`  source: ${compactCliText(redactUrlForPreview(row.url), 120)}`);
        continue;
      }
      lines.push(`- #${index + 1} ${compactCliText(row.title || row.finalUrl || row.url || 'fetched content', 100)}`);
      if (row.finalUrl || row.url) lines.push(`  source: ${compactCliText(redactUrlForPreview(row.finalUrl || row.url), 120)}`);
      if (row.statusCode) lines.push(`  status=${row.statusCode}`);
    }
  } else if (details.finalUrl || details.title || urls.length > 0) {
    lines.push(`- ${compactCliText(details.title || details.finalUrl || urls[0] || 'fetched content', 100)}`);
    if (details.finalUrl || urls[0]) lines.push(`  source: ${compactCliText(redactUrlForPreview(details.finalUrl || urls[0]), 120)}`);
    if (details.statusCode) lines.push(`  status=${details.statusCode}`);
  }

  lines.push('content: returned to model; hidden from CLI render');
  return lines.join('\n');
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
    name: WEB_SEARCH_TOOL,
    label: WEB_SEARCH_TOOL,
    description: 'Search the public web through the Stronk-owned provider selected by STRONK_PI_SEARCH_PROVIDER.',
    promptSnippet: 'Search the web with the configured Stronk Pi provider',
    promptGuidelines: [
      `Supported providers are exactly: ${SEARCH_PROVIDERS.join(', ')}.`,
      'For operator-facing research, comparisons, current facts, or uncertain answers, call web_search once with workflow=summary-review and 5-10 varied queries so the CLI review layer can curate sources.',
      'Use workflow=none only for quick single-query lookups, deterministic headless runs, or tests.',
      'After summary-review results return, call curatorAction=status, keep strong primary/official sources using resultRank or resultId, fetch selected public URLs only when page content is needed, then finish.',
      `Use structured details.results for titles, URLs, snippets, and selectors; use ${SAFE_FETCH_TOOL} only when page content is needed.`,
      'Do not send secrets, API keys, local paths, or private-network URLs in search queries.',
    ],
    parameters: webSearchSchema,
    renderCall: (params, _theme, context) => renderTextComponent(formatSearchRenderCall(WEB_SEARCH_TOOL, params), context),
    renderResult: (result, _options, _theme, context) => renderTextComponent(formatSearchRenderResult(WEB_SEARCH_TOOL, result), context),
    execute: async (...args) => {
      const { params, signal, onUpdate, ctx } = normalizeToolArgs(args);
      return executeWebSearch(params, signal, onUpdate, { ctx, state });
    },
  });
  pi.registerTool({
    name: CODE_SEARCH_TOOL,
    label: CODE_SEARCH_TOOL,
    description: 'Search for code-oriented public results through Exa, with Stronk web_search fallback when EXA_API_KEY is unset.',
    promptSnippet: 'Search for code examples, APIs, and implementation references',
    promptGuidelines: [
      'Uses EXA_API_KEY when available.',
      `If EXA_API_KEY is unset, falls back to ${WEB_SEARCH_TOOL} using STRONK_PI_SEARCH_PROVIDER.`,
      'For code research, comparisons, or current-library behavior, prefer workflow=summary-review so progress and curation stay visible in the CLI.',
      'Use workflow=none only for quick deterministic/headless lookup.',
      `Use structured details.results for titles, URLs, snippets, and selectors; use ${SAFE_FETCH_TOOL} only when page content is needed.`,
      'Do not send secrets, API keys, local paths, or private-network URLs in search queries.',
    ],
    parameters: codeSearchSchema,
    renderCall: (params, _theme, context) => renderTextComponent(formatSearchRenderCall(CODE_SEARCH_TOOL, params), context),
    renderResult: (result, _options, _theme, context) => renderTextComponent(formatSearchRenderResult(CODE_SEARCH_TOOL, result), context),
    execute: async (...args) => {
      const { params, signal, onUpdate, ctx } = normalizeToolArgs(args);
      return executeCodeSearch(params, signal, onUpdate, { ctx });
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
    renderCall: (params, _theme, context) => renderTextComponent(formatFetchRenderCall(params), context),
    renderResult: (result, _options, _theme, context) => renderTextComponent(formatFetchRenderResult(result), context),
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
  normalizeSearchProvider,
  searchProviders: SEARCH_PROVIDERS,
  searchWorkflows: SEARCH_WORKFLOWS,
  searchReviewActions: SEARCH_REVIEW_ACTIONS,
  searchProviderKey,
  normalizeWebSearchParams,
  normalizeCodeSearchParams,
  resolveSearchWorkflow,
  searchConcurrency,
  buildCodeSearchQuery,
  executeWebSearch,
  executeCodeSearch,
  searchExa,
  searchExaCode,
  searchBrave,
  searchTavily,
  searchGemini,
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
