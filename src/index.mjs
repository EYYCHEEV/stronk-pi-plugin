import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, lstatSync, mkdirSync, opendirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { basename, dirname, extname, join, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSubagentFacade, facadeAdapterMode, facadeEnabled, stronkSubagentSchema } from './subagents/facade.mjs';
import { PiSubagentsBridgeAdapter } from './subagents/adapters/pi-subagents-bridge.mjs';

const SAFE_FETCH_TOOL = 'fetch_content';
const WEB_SEARCH_TOOL = 'web_search';
const CODE_SEARCH_TOOL = 'code_search';
const STRONK_SUBAGENT_TOOL = 'stronk_subagent';
const IMAGE_READ_TOOL = 'image_read';
const IMAGE_PREFLIGHT_READ_TOOL = 'image_preflight_read';
const DISABLED_PLUGIN_TOOLS = new Set(['get_search_content']);
const WEB_TOOLS = new Set([WEB_SEARCH_TOOL, CODE_SEARCH_TOOL, SAFE_FETCH_TOOL]);
const IMAGE_TOOLS = new Set([IMAGE_READ_TOOL, IMAGE_PREFLIGHT_READ_TOOL]);
const SESSION_TOOLS = new Set(['todowrite', 'todoread', 'question', 'ask_user']);
const INTERCOM_TOOLS = new Set(['intercom', 'contact_supervisor']);
const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'glob', 'todoread']);
const MUTATING_TOOLS = new Set(['bash', 'write', 'edit', 'patch', 'apply_patch', 'multi_edit']);
const PLUGIN_TOOLS = new Set(['mcp', STRONK_SUBAGENT_TOOL, ...WEB_TOOLS, ...IMAGE_TOOLS, ...SESSION_TOOLS, ...INTERCOM_TOOLS]);
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
const imagePreflightArtifactIndex = new Map();
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
const IMAGE_PREFLIGHT_MARKER = 'Stronk Pi Image Vision Preflight';
const IMAGE_PREFLIGHT_CONTEXT_TAG = 'stronk-pi-image-vision-preflight';
const IMAGE_READ_MARKER = 'Stronk Pi Image Read';
const IMAGE_READ_CONTEXT_TAG = 'stronk-pi-image-read';
const DEFAULT_IMAGE_PREFLIGHT_MODEL = 'kimi-coding/kimi-for-coding:xhigh';
const DEFAULT_IMAGE_PREFLIGHT_MAX_IMAGES = 12;
const DEFAULT_IMAGE_PREFLIGHT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_IMAGE_PREFLIGHT_TIMEOUT_MS = 360000;
const DEFAULT_IMAGE_PREFLIGHT_FAILURE_MODE = 'soft';
const DEFAULT_IMAGE_PREFLIGHT_RESPONSE_MAX_TOKENS = 4096;
const MIN_IMAGE_PREFLIGHT_RESPONSE_MAX_TOKENS = 1024;
const MAX_IMAGE_PREFLIGHT_RESPONSE_MAX_TOKENS = 8192;
const MAX_IMAGE_PREFLIGHT_IMAGES = 12;
const MAX_IMAGE_PREFLIGHT_REQUEST_MAX_TOKENS = DEFAULT_IMAGE_PREFLIGHT_RESPONSE_MAX_TOKENS * MAX_IMAGE_PREFLIGHT_IMAGES;
const MAX_IMAGE_PREFLIGHT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PREFLIGHT_TIMEOUT_MS = 360000;
const DEFAULT_IMAGE_PREFLIGHT_STREAM_IDLE_TIMEOUT_MS = 60000;
const MIN_IMAGE_PREFLIGHT_STREAM_IDLE_TIMEOUT_MS = 1000;
const MAX_IMAGE_PREFLIGHT_STREAM_IDLE_TIMEOUT_MS = MAX_IMAGE_PREFLIGHT_TIMEOUT_MS;
const MAX_IMAGE_PREFLIGHT_REQUEST_TEXT_CHARS = 6000;
const MAX_IMAGE_PREFLIGHT_CONTEXT_TEXT_CHARS = 12000;
const DEFAULT_IMAGE_PREFLIGHT_ARTIFACT_READ_CHARS = 20000;
const MAX_IMAGE_PREFLIGHT_ARTIFACT_READ_CHARS = 60000;
const IMAGE_PREFLIGHT_ARTIFACT_IMAGES_PER_HANDLE = 3;
const IMAGE_PREFLIGHT_ARTIFACT_HANDLE_PATTERN = /^image-preflight-[A-Fa-f0-9-]{36}$/;
const MAX_IMAGE_PATH_CANDIDATES = 24;
const MAX_IMAGE_PREFLIGHT_ATTACHMENT_SCAN = 24;
const MAX_IMAGE_READ_DIRECTORY_ENTRIES = 512;
const MAX_IMAGE_READ_DIRECTORY_DIRS = 64;
const MAX_IMAGE_READ_SKIPPED_DETAILS = 24;
const MAX_IMAGE_READ_OUTPUT_CHARS = 14000;
const IMAGE_PREFLIGHT_UI_KEY = 'stronk-pi-image-vision-preflight';
const IMAGE_PREFLIGHT_UI_FRAMES = ['|', '/', '-', '\\'];
const IMAGE_PREFLIGHT_UI_INTERVAL_MS = 120;
const IMAGE_PREFLIGHT_FAILURE_MODES = new Set(['soft', 'block']);
const IMAGE_PREFLIGHT_THINKING_SUFFIXES = new Set(['xhigh', 'high', 'medium', 'low', 'minimal', 'none', 'off']);
const OPENAI_COMPATIBLE_APIS = new Set(['openai', 'openai-chat-completions', 'openai-completions', 'chat-completions']);
const ANTHROPIC_MESSAGES_APIS = new Set(['anthropic', 'anthropic-messages', 'messages']);
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMAGE_EXTENSION_MIME_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);
const IMAGE_DATA_URL_PREFIX_PATTERN = /data:image\/[A-Za-z0-9.+-]+;base64,/gi;
const BASE64_TOKEN_PATTERN = /[A-Za-z0-9+/_-]{8,}={0,2}/g;
const LOCAL_PATH_BOUNDARY = "(^|[\\s\"'`([{<])";
const LOCAL_IMAGE_PATH_WITH_SPACES_PATTERN = new RegExp(
  LOCAL_PATH_BOUNDARY + "((?:file:\\/\\/|\\/(?!\\/)|~\\/|[A-Za-z]:[\\\\/])[^\"'`<>\\n)]*?\\.(?:png|jpe?g|gif|webp)\\b)",
  'gi',
);
const QUOTED_LOCAL_PATH_TEXT_PATTERN = /(["'`])((?:file:\/\/|\/(?!\/)|~\/|[A-Za-z]:[\\/])[^"'`\n<>]+)\1/g;
const LOCAL_PATH_TEXT_PATTERN = new RegExp(
  LOCAL_PATH_BOUNDARY + "((?:file:\\/\\/[^\\s\"'`<>)]*|\\/(?!\\/)[^\\s\"'`<>)]*|~\\/[^\\s\"'`<>)]*|[A-Za-z]:[\\\\/][^\\s\"'`<>)]*))",
  'g',
);
const PROTECTED_LOCAL_PATH_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.env']);
const FULL_DISK_IMAGE_READ_MODES = new Set([
  'danger-full-access',
  'full-access',
  'full-yolo',
  'full_yolo',
  'yolo',
  'unrestricted',
  'no-sandbox',
  'disabled',
]);
const AUTO_IMAGE_READ_MODES = new Set(['auto']);
const RESTRICTED_IMAGE_READ_MODES = new Set([
  'default',
  'read-only',
  'read_only',
  'workspace-write',
  'workspace_write',
  'workspace',
  'restricted',
]);
const BUILTIN_VISION_PROVIDER_FALLBACKS = {
  'kimi-coding/kimi-for-coding': {
    providerName: 'kimi-coding',
    providerConfig: {
      name: 'Kimi Coding',
      api: 'anthropic-messages',
      apiKey: '$KIMI_API_KEY',
      baseUrl: 'https://api.kimi.com/coding',
      headers: {
        'User-Agent': 'KimiCLI/1.5',
      },
      compat: {
        supportsDeveloperRole: false,
      },
    },
    modelConfig: {
      id: 'kimi-for-coding',
      input: ['text', 'image'],
      maxTokens: 65536,
    },
  },
};

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

const imageReadSchema = {
  type: 'object',
  additionalProperties: false,
  oneOf: [
    { required: ['paths'], not: { required: ['directory'] } },
    { required: ['directory'], not: { required: ['paths'] } },
  ],
  properties: {
    paths: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      items: { type: 'string' },
      description: 'Exactly one explicit local image file path discovered by tools such as ls, glob, or find.',
    },
    directory: {
      type: 'string',
      description: 'One local folder to scan for image files. The bounded scan must resolve exactly one image.',
    },
    recursive: {
      type: 'boolean',
      description: 'Recursively scan the directory. Defaults to false and remains bounded.',
      default: false,
    },
    question: {
      type: 'string',
      description: 'Optional visual question or focus for the configured vision model.',
    },
  },
};

const imagePreflightReadSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['handle'],
  properties: {
    handle: {
      type: 'string',
      description: 'Opaque handle for a session-scoped prompt-time image preflight analysis artifact.',
    },
    offset: {
      type: 'number',
      minimum: 0,
      description: 'Character offset for reading a later chunk. Defaults to 0.',
    },
    max_chars: {
      type: 'number',
      minimum: 1024,
      maximum: MAX_IMAGE_PREFLIGHT_ARTIFACT_READ_CHARS,
      description: 'Maximum characters to return. Defaults to 20000 and remains bounded.',
    },
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

function redact(value, options = {}) {
  const maxLength = options.maxLength === undefined ? 2000 : options.maxLength;
  if (Array.isArray(value)) return value.map((item) => redact(item, options));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? '<redacted>' : redact(item, options);
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
  return Number.isFinite(maxLength) && maxLength >= 0 && text.length > maxLength
    ? `${text.slice(0, maxLength)}...<truncated>`
    : text;
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

function sanitizeExternalText(value, options = {}) {
  return sanitizeRenderText(String(redact(value ?? '', options)));
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

function firstPresent(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return value;
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

function clampedInteger(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
}

function parseTomlScalar(value) {
  const trimmed = value.trim();
  const quoted = trimmed.match(/^"((?:\\.|[^"\\])*)"$/) || trimmed.match(/^'([^']*)'$/);
  if (quoted) {
    return quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^[+-]?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  return trimmed;
}

function stripTomlInlineComment(line) {
  let quote;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = undefined;
      continue;
    }
    if (char === '#' && !quote) return line.slice(0, index);
  }
  return line;
}

function parseTomlSections(text) {
  const out = {};
  let section = '';
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = stripTomlInlineComment(rawLine).trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      out[section] ??= {};
      continue;
    }
    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!assignment) continue;
    const target = section ? (out[section] ??= {}) : out;
    target[assignment[1]] = parseTomlScalar(assignment[2]);
  }
  return out;
}

function readTomlSections(path) {
  try {
    return parseTomlSections(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function homeDirFromEnv(env = process.env) {
  return firstString(env.HOME, env.USERPROFILE) || process.cwd();
}

function expandHomePath(value, env = process.env) {
  const raw = String(value || '');
  if (raw === '~') return homeDirFromEnv(env);
  if (raw.startsWith('~/')) return join(homeDirFromEnv(env), raw.slice(2));
  return raw;
}

function stronkStateRoot(env = process.env) {
  return resolve(expandHomePath(firstString(env.STRONK_PI_STATE_ROOT) || '~/.stronk-pi', env));
}

function normalizeFailureMode(value, fallback = DEFAULT_IMAGE_PREFLIGHT_FAILURE_MODE) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return IMAGE_PREFLIGHT_FAILURE_MODES.has(normalized) ? normalized : fallback;
}

function resolveVisionPreflightConfig(options = {}) {
  const env = options.env ?? process.env;
  const stateRoot = options.stateRoot ? resolve(expandHomePath(options.stateRoot, env)) : stronkStateRoot(env);
  const defaultsPath = options.defaultsPath ? resolve(expandHomePath(options.defaultsPath, env)) : join(stateRoot, 'config', 'defaults.toml');
  const rolesPath = options.rolesPath ? resolve(expandHomePath(options.rolesPath, env)) : join(stateRoot, 'config', 'roles.toml');
  const localRolesPath = options.localRolesPath ? resolve(expandHomePath(options.localRolesPath, env)) : join(stateRoot, 'config', 'roles.local.toml');
  const defaults = options.defaultsToml ? parseTomlSections(options.defaultsToml) : readTomlSections(defaultsPath);
  const roles = options.rolesToml ? parseTomlSections(options.rolesToml) : readTomlSections(rolesPath);
  const localRoles = options.localRolesToml ? parseTomlSections(options.localRolesToml) : readTomlSections(localRolesPath);
  const imageConfig = defaults.image_preflight || {};

  return {
    enabled: parseBoolean(
      firstString(env.STRONK_PI_IMAGE_PREFLIGHT, env.STRONK_PI_IMAGE_PREFLIGHT_ENABLED) ?? imageConfig.enabled,
      parseBoolean(imageConfig.enabled, true),
    ),
    model: firstString(
      env.STRONK_PI_IMAGE_PREFLIGHT_MODEL,
      localRoles.pi?.vision_model,
      roles.pi?.vision_model,
      imageConfig.model,
      defaults.models?.vision,
      DEFAULT_IMAGE_PREFLIGHT_MODEL,
    ),
    maxImages: clampedInteger(
      firstString(env.STRONK_PI_IMAGE_PREFLIGHT_MAX_IMAGES) ?? imageConfig.max_images,
      DEFAULT_IMAGE_PREFLIGHT_MAX_IMAGES,
      1,
      MAX_IMAGE_PREFLIGHT_IMAGES,
    ),
    maxBytes: clampedInteger(
      firstString(env.STRONK_PI_IMAGE_PREFLIGHT_MAX_BYTES) ?? imageConfig.max_bytes,
      DEFAULT_IMAGE_PREFLIGHT_MAX_BYTES,
      1024,
      MAX_IMAGE_PREFLIGHT_BYTES,
    ),
    timeoutMs: clampedInteger(
      firstString(env.STRONK_PI_IMAGE_PREFLIGHT_TIMEOUT_MS) ?? imageConfig.timeout_ms,
      DEFAULT_IMAGE_PREFLIGHT_TIMEOUT_MS,
      1000,
      MAX_IMAGE_PREFLIGHT_TIMEOUT_MS,
    ),
    streamIdleTimeoutMs: clampedInteger(
      firstString(env.STRONK_PI_IMAGE_PREFLIGHT_STREAM_IDLE_TIMEOUT_MS) ?? imageConfig.stream_idle_timeout_ms,
      DEFAULT_IMAGE_PREFLIGHT_STREAM_IDLE_TIMEOUT_MS,
      MIN_IMAGE_PREFLIGHT_STREAM_IDLE_TIMEOUT_MS,
      MAX_IMAGE_PREFLIGHT_STREAM_IDLE_TIMEOUT_MS,
    ),
    maxOutputTokens: clampedInteger(
      firstString(env.STRONK_PI_IMAGE_PREFLIGHT_MAX_OUTPUT_TOKENS) ?? imageConfig.max_output_tokens,
      DEFAULT_IMAGE_PREFLIGHT_RESPONSE_MAX_TOKENS,
      MIN_IMAGE_PREFLIGHT_RESPONSE_MAX_TOKENS,
      MAX_IMAGE_PREFLIGHT_RESPONSE_MAX_TOKENS,
    ),
    failureMode: normalizeFailureMode(
      firstString(env.STRONK_PI_IMAGE_PREFLIGHT_FAILURE_MODE) ?? imageConfig.failure_mode,
      DEFAULT_IMAGE_PREFLIGHT_FAILURE_MODE,
    ),
    stateRoot,
    defaultsPath,
    rolesPath,
    localRolesPath,
    supportedMimeTypes: [...SUPPORTED_IMAGE_MIME_TYPES],
  };
}

function stripModelThinkingSuffix(modelRef) {
  const raw = String(modelRef || '').trim();
  const separator = raw.lastIndexOf(':');
  if (separator <= 0) return raw;
  const suffix = raw.slice(separator + 1).toLowerCase();
  if (!IMAGE_PREFLIGHT_THINKING_SUFFIXES.has(suffix)) return raw;
  return raw.slice(0, separator);
}

function modelRefParts(modelRef) {
  const stripped = stripModelThinkingSuffix(modelRef);
  const slash = stripped.indexOf('/');
  if (slash <= 0) return { modelId: stripped };
  return { provider: stripped.slice(0, slash), modelId: stripped.slice(slash + 1), full: stripped };
}

function arrayHasImage(value) {
  return Array.isArray(value) && value.some((item) => String(item).toLowerCase() === 'image');
}

function objectDeclaresImageInput(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.supportsImages === true || value.supports_images === true || value.supportsImageInput === true) return true;
  if (arrayHasImage(value.input) || arrayHasImage(value.inputs) || arrayHasImage(value.modalities)) return true;
  if (objectDeclaresImageInput(value.capabilities) || objectDeclaresImageInput(value.compat)) return true;
  return false;
}

function modelStringFrom(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!value || typeof value !== 'object') return undefined;
  const id = firstString(value.id, value.model, value.modelId, value.model_id, value.slug, value.name);
  const provider = firstString(value.provider, value.providerId, value.provider_id);
  return provider && id && !id.startsWith(`${provider}/`) ? `${provider}/${id}` : id;
}

function modelRefsMatch(left, right) {
  const a = modelRefParts(left);
  const b = modelRefParts(right);
  if (!a.modelId || !b.modelId) return false;
  if (a.provider && b.provider) return a.provider === b.provider && a.modelId === b.modelId;
  return a.modelId === b.modelId;
}

function activeModelRef(event = {}, ctx = {}) {
  return firstString(
    modelStringFrom(event.model),
    event.model,
    event.modelId,
    event.model_id,
    nestedString(event, 'model', 'id'),
    nestedString(event, 'model', 'slug'),
    modelStringFrom(ctx.model),
    ctx.model,
    ctx.modelId,
    ctx.model_id,
    nestedString(ctx, 'model', 'id'),
    nestedString(ctx, 'model', 'slug'),
    process.env.PI_MODEL,
    process.env.STRONK_PI_MODEL,
  );
}

function configuredModelSupportsImage(modelRef, modelsConfig = {}) {
  if (!modelRef || !modelsConfig || typeof modelsConfig !== 'object') return false;
  const parts = modelRefParts(modelRef);
  const providers = modelsConfig.providers && typeof modelsConfig.providers === 'object' ? modelsConfig.providers : {};
  for (const [providerName, providerConfig] of Object.entries(providers)) {
    if (!providerConfig || typeof providerConfig !== 'object') continue;
    const models = Array.isArray(providerConfig.models) ? providerConfig.models : [];
    for (const model of models) {
      if (!model || typeof model !== 'object') continue;
      const id = firstString(model.id, model.model, model.name);
      if (!id) continue;
      const full = `${providerName}/${id}`;
      const matches = modelRef === id
        || stripModelThinkingSuffix(modelRef) === id
        || stripModelThinkingSuffix(modelRef) === full
        || (parts.provider === providerName && parts.modelId === id);
      if (matches && objectDeclaresImageInput(model)) return true;
    }
  }
  return false;
}

function builtinModelSupportsImage(modelRef) {
  const parts = modelRefParts(modelRef);
  const fallback = builtinVisionProviderFallback(parts);
  return objectDeclaresImageInput(fallback?.modelConfig);
}

function loadModelsConfig(options = {}) {
  if (options.modelsConfig && typeof options.modelsConfig === 'object') return options.modelsConfig;
  if (typeof options.modelsJson === 'string') {
    try {
      return JSON.parse(options.modelsJson);
    } catch {
      return {};
    }
  }
  const env = options.env ?? process.env;
  const path = firstString(env.STRONK_PI_MODELS_JSON)
    ? resolve(expandHomePath(env.STRONK_PI_MODELS_JSON, env))
    : join(stronkStateRoot(env), 'agent', 'models.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function providerModels(providerConfig = {}) {
  const models = providerConfig && typeof providerConfig === 'object' ? providerConfig.models : undefined;
  if (Array.isArray(models)) return models.filter((model) => model && typeof model === 'object');
  if (models && typeof models === 'object') {
    return Object.entries(models)
      .map(([id, model]) => (model && typeof model === 'object' ? { id, ...model } : { id }))
      .filter((model) => model && typeof model === 'object');
  }
  return [];
}

function modelIdFromConfig(modelConfig = {}) {
  return firstString(modelConfig.id, modelConfig.model, modelConfig.slug);
}

function providerModelMatches(providerName, modelConfig, parts) {
  const modelId = modelIdFromConfig(modelConfig);
  if (!providerName || !modelId || !parts?.modelId) return false;
  return modelRefsMatch(`${providerName}/${modelId}`, parts.full || parts.modelId)
    || modelRefsMatch(modelId, parts.modelId);
}

function builtinVisionProviderFallback(parts = {}) {
  const key = parts.full || (parts.provider && parts.modelId ? `${parts.provider}/${parts.modelId}` : '');
  const fallback = BUILTIN_VISION_PROVIDER_FALLBACKS[key];
  if (!fallback) return undefined;
  return {
    ...fallback,
    builtin: true,
    modelId: modelIdFromConfig(fallback.modelConfig) || parts.modelId,
  };
}

function resolveVisionProviderConfig(modelRef, options = {}) {
  const parts = modelRefParts(modelRef);
  if (!parts.provider || !parts.modelId) return undefined;
  const providers = loadModelsConfig(options).providers;
  const providerConfig = providers && typeof providers === 'object' ? providers[parts.provider] : undefined;
  if (!providerConfig || typeof providerConfig !== 'object') return builtinVisionProviderFallback(parts);
  const modelConfig = providerModels(providerConfig).find((model) => providerModelMatches(parts.provider, model, parts));
  if (!modelConfig) return builtinVisionProviderFallback(parts);
  return {
    providerName: parts.provider,
    providerConfig,
    modelConfig,
    modelId: modelIdFromConfig(modelConfig) || parts.modelId,
    builtin: false,
  };
}

function modelSupportsImageInput(event = {}, ctx = {}, options = {}) {
  const modelRef = activeModelRef(event, ctx);
  for (const candidate of [event.model, event.modelInfo, event.activeModel, ctx.model, ctx.modelInfo, ctx.activeModel]) {
    if (!objectDeclaresImageInput(candidate)) continue;
    const candidateRef = modelStringFrom(candidate);
    if (!modelRef) return true;
    if (candidateRef && modelRefsMatch(modelRef, candidateRef)) return true;
  }
  if (!modelRef) return false;
  return configuredModelSupportsImage(modelRef, loadModelsConfig(options)) || builtinModelSupportsImage(modelRef);
}

function normalizeImageMime(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) return undefined;
  if (normalized === 'image/jpg') return 'image/jpeg';
  if (SUPPORTED_IMAGE_MIME_TYPES.has(normalized)) return normalized;
  return normalized.startsWith('image/') ? normalized : undefined;
}

function mimeFromPath(path) {
  return IMAGE_EXTENSION_MIME_TYPES.get(extname(path || '').toLowerCase());
}

function hasSupportedImageExtension(path) {
  return imageMimeSupported(mimeFromPath(path));
}

function mimeFromMagic(buffer) {
  if (!buffer || buffer.length < 4) return undefined;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}

function imageMimeSupported(mimeType) {
  return SUPPORTED_IMAGE_MIME_TYPES.has(normalizeImageMime(mimeType));
}

function parseDataUrl(value) {
  const match = String(value || '').match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s_-]+)$/);
  if (!match) return undefined;
  return { mediaType: normalizeImageMime(match[1]), data: match[2].replace(/\s+/g, '') };
}

function decodeBase64ImageData(data) {
  const normalized = String(data || '').replace(/\s+/g, '');
  if (!normalized) return undefined;
  if (normalized.length % 4 === 1 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(normalized)) return undefined;
  try {
    const buffer = Buffer.from(normalized.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (buffer.byteLength <= 0) return undefined;
    const roundTrip = buffer.toString('base64').replace(/=+$/g, '');
    if (roundTrip !== normalized.replace(/=+$/g, '').replace(/-/g, '+').replace(/_/g, '/')) return undefined;
    return { buffer, data: buffer.toString('base64') };
  } catch {
    return undefined;
  }
}

function isSupportedBase64Image(data) {
  const decoded = decodeBase64ImageData(data);
  return Boolean(decoded && imageMimeSupported(mimeFromMagic(decoded.buffer)));
}

function imageBase64RawEnd(text, start) {
  let normalized = '';
  let lastGoodEnd = -1;
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];
    if (/[A-Za-z0-9+/_=-]/.test(ch)) {
      normalized += ch;
      if (normalized.length >= 8 && normalized.length % 4 !== 1 && isSupportedBase64Image(normalized)) {
        lastGoodEnd = index + 1;
      }
      continue;
    }
    if (/\s/.test(ch)) continue;
    break;
  }
  return lastGoodEnd > start ? lastGoodEnd : start;
}

function redactImageDataUrls(text) {
  const source = String(text || '');
  let output = '';
  let cursor = 0;
  let match;
  IMAGE_DATA_URL_PREFIX_PATTERN.lastIndex = 0;
  while ((match = IMAGE_DATA_URL_PREFIX_PATTERN.exec(source)) !== null) {
    const dataStart = IMAGE_DATA_URL_PREFIX_PATTERN.lastIndex;
    const dataEnd = imageBase64RawEnd(source, dataStart);
    if (dataEnd <= dataStart) continue;
    output += source.slice(cursor, match.index);
    output += '<redacted image data>';
    cursor = dataEnd;
    IMAGE_DATA_URL_PREFIX_PATTERN.lastIndex = dataEnd;
  }
  return cursor === 0 ? source : output + source.slice(cursor);
}

function redactImageBase64Tokens(text) {
  return String(text || '').replace(BASE64_TOKEN_PATTERN, (match) => (
    isSupportedBase64Image(match) ? '<redacted image data>' : match
  ));
}

function redactImageDataText(text) {
  return redactImageBase64Tokens(redactImageDataUrls(text));
}

function redactLocalPathText(text) {
  const replaceBoundaryPath = (value, pattern) => value.replace(pattern, (_match, prefix) => `${prefix}<redacted local path>`);
  let output = String(text || '').replace(QUOTED_LOCAL_PATH_TEXT_PATTERN, '<redacted local path>');
  output = replaceBoundaryPath(output, LOCAL_IMAGE_PATH_WITH_SPACES_PATTERN);
  return replaceBoundaryPath(output, LOCAL_PATH_TEXT_PATTERN);
}

function base64EncodedMaxLength(byteLimit) {
  return Math.ceil(Math.max(0, Number(byteLimit) || 0) / 3) * 4;
}

function imagePathAllowed(path, cwd, env = process.env) {
  const home = resolve(homeDirFromEnv(env));
  const roots = [
    cwd,
    home,
    firstString(env.TMPDIR) ? resolve(env.TMPDIR) : undefined,
    '/tmp',
    '/private/tmp',
    '/var/folders',
    '/private/var/folders',
  ].filter(Boolean).map((root) => {
    try {
      return realpathSync(root);
    } catch {
      return resolve(root);
    }
  });
  return roots.some((root) => {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

function normalizeImagePermissionModes(values = []) {
  return values
    .filter((value) => typeof value === 'string' && value.trim())
    .map((mode) => String(mode).trim().toLowerCase());
}

function imagePermissionContextCandidates(ctx = {}) {
  return [
    ctx.sandboxMode,
    ctx.sandbox_mode,
    ctx.permissionMode,
    ctx.permission_mode,
  ];
}

function imagePermissionEnvCandidates(env = process.env) {
  return [
    env.STRONK_PI_SANDBOX_MODE,
    env.PI_SANDBOX_MODE,
    env.CODEX_SANDBOX_MODE,
    env.STRONK_PI_PERMISSION_MODE,
    env.PI_PERMISSION_MODE,
  ];
}

function imageAllowedRootPolicy(ctx = {}, env = process.env) {
  const contextModes = normalizeImagePermissionModes(imagePermissionContextCandidates(ctx));
  const envModes = normalizeImagePermissionModes(imagePermissionEnvCandidates(env));
  const allModes = contextModes.concat(envModes);
  if (allModes.some((mode) => FULL_DISK_IMAGE_READ_MODES.has(mode))) return false;
  if (contextModes.some((mode) => AUTO_IMAGE_READ_MODES.has(mode))) return false;
  if (contextModes.some((mode) => RESTRICTED_IMAGE_READ_MODES.has(mode))) return true;
  if (envModes.some((mode) => AUTO_IMAGE_READ_MODES.has(mode))) return false;
  if (envModes.some((mode) => RESTRICTED_IMAGE_READ_MODES.has(mode))) return true;
  return false;
}

function imageReadShouldEnforceAllowedRoots(ctx = {}, env = process.env) {
  return imageAllowedRootPolicy(ctx, env);
}

function imagePreflightShouldEnforceAllowedRoots(event = {}, ctx = {}, env = process.env) {
  return imageAllowedRootPolicy({
    sandboxMode: firstString(event.sandboxMode, event.sandbox_mode, ctx.sandboxMode, ctx.sandbox_mode),
    permissionMode: firstString(event.permissionMode, event.permission_mode, ctx.permissionMode, ctx.permission_mode),
  }, env);
}

function pathHasProtectedSegment(path) {
  return String(path || '').split(/[\\/]+/).some((segment) => PROTECTED_LOCAL_PATH_SEGMENTS.has(segment));
}

function pathHasHiddenSegment(path) {
  return String(path || '').split(/[\\/]+/).some((segment) => (
    segment && segment !== '.' && segment !== '..' && segment.startsWith('.')
  ));
}

function pathIsWithinRoot(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function imageCandidateHasHiddenSegment(path, cwd) {
  const root = resolve(cwd || process.cwd());
  const target = resolve(path || '');
  const roots = [root];
  try {
    const realRoot = realpathSync(root);
    if (!roots.includes(realRoot)) roots.push(realRoot);
  } catch {
    // Use the logical root when the root itself cannot be resolved.
  }
  for (const candidateRoot of roots) {
    if (pathIsWithinRoot(candidateRoot, target)) {
      return pathHasHiddenSegment(relative(candidateRoot, target));
    }
  }
  return pathHasHiddenSegment(target);
}

function cleanPathCandidate(raw) {
  let value = String(raw || '').trim();
  value = value.replace(/^<(.+)>$/, '$1');
  value = value.replace(/^["'`](.+)["'`]$/, '$1');
  value = value.replace(/[),.;:!?]+$/g, '');
  return value.trim();
}

function resolveImagePathCandidate(raw, cwd, env = process.env) {
  let value = cleanPathCandidate(raw);
  if (!value) return undefined;
  if (/^file:/i.test(value)) {
    try {
      value = fileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  value = expandHomePath(value, env);
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

function extractImagePathCandidates(text) {
  const candidates = [];
  const seen = new Set();
  const add = (value) => {
    const cleaned = cleanPathCandidate(value);
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    candidates.push(cleaned);
  };
  const patterns = [
    /!\[[^\]]*]\(([^)\n]+\.(?:png|jpe?g|gif|webp))(?:\s+"[^"]*")?\)/gi,
    /\[[^\]]+]\(([^)\n]+\.(?:png|jpe?g|gif|webp))(?:\s+"[^"]*")?\)/gi,
    /\bfile:\/\/[^\s'"<>`]+?\.(?:png|jpe?g|gif|webp)\b/gi,
    /["'`]([^"'`\n]+\.(?:png|jpe?g|gif|webp))["'`]/gi,
    /(?:^|[\s([{<])((?:~\/|\.\.?\/|\/)[^\n"'`<>]*?\.(?:png|jpe?g|gif|webp))(?=$|[\s)\]}>.,;!?])/gi,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text || ''); match && candidates.length < MAX_IMAGE_PATH_CANDIDATES; match = pattern.exec(text || '')) {
      add(match[1] || match[0]);
    }
  }
  return candidates;
}

function makeImageSkip(origin, reason, source = {}) {
  return {
    label: source.label || origin,
    origin,
    reason,
    displayName: source.displayName,
    path: source.path,
    originalPath: source.originalPath,
    pathAliases: imagePathAliases(source),
    mediaType: source.mediaType,
  };
}

function imagePathAliases(image = {}) {
  const aliases = [];
  for (const value of [
    image.originalPath,
    image.path,
    ...(Array.isArray(image.pathAliases) ? image.pathAliases : []),
  ]) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed && !aliases.includes(trimmed)) aliases.push(trimmed);
  }
  return aliases;
}

function safeImageDisplayName(image = {}, fallback = 'image') {
  const value = firstString(image.displayName, image.name, image.originalPath, image.path, image.label, image.origin, fallback) || fallback;
  const cleaned = cleanPathCandidate(value);
  if (!cleaned) return fallback;
  return basename(cleaned) || cleaned || fallback;
}

function imageReferenceReplacement(image = {}, status = 'analyzed') {
  const label = firstString(image.label, image.origin) || 'image';
  const displayName = safeImageDisplayName(image, label);
  const display = displayName && displayName !== label ? `; ${displayName}` : '';
  if (status === 'skipped') return `[${label}${display}; skipped]`;
  if (status === 'failed') return `[${label}${display}; failed]`;
  return `[${label}${display}]`;
}

function rewriteImageReferenceAliases(text, entries = []) {
  let rewritten = String(text || '');
  const replacements = [];
  for (const entry of entries) {
    const paths = imagePathAliases(entry.image).sort((left, right) => right.length - left.length);
    for (const path of paths) {
      if (!path) continue;
      replacements.push([path, entry.replacement]);
    }
  }
  for (const [path, replacement] of replacements) {
    rewritten = rewritten.split(path).join(replacement);
  }
  return rewritten;
}

function mergeImagePathAliases(target = {}, source = {}) {
  const aliases = [...imagePathAliases(target), ...imagePathAliases(source)];
  if (aliases.length > 0) target.pathAliases = [...new Set(aliases)];
  if (!target.originalPath && source.originalPath) target.originalPath = source.originalPath;
  return target;
}

function makeNormalizedImage(origin, data, mediaType, byteLength, source = {}) {
  const label = source.label || `image-${source.index ?? 1}`;
  const pathAliases = imagePathAliases(source);
  return {
    label,
    origin,
    displayName: source.displayName || source.path ? basename(source.displayName || source.path) : label,
    path: source.path,
    originalPath: source.originalPath,
    pathAliases,
    mediaType,
    byteLength,
    data,
    contentPart: {
      type: 'image',
      source: { type: 'base64', mediaType, data },
    },
  };
}

function normalizeBase64Image(origin, source, config, index) {
  const dataUrl = parseDataUrl(source.data);
  const rawData = dataUrl?.data || String(source.data || '').replace(/\s+/g, '');
  if (rawData.length > base64EncodedMaxLength(config.maxBytes)) {
    return { skip: makeImageSkip(origin, `image exceeds max_bytes (${config.maxBytes})`, source) };
  }
  const decoded = decodeBase64ImageData(rawData);
  if (!decoded) return { skip: makeImageSkip(origin, rawData ? 'invalid image base64' : 'missing image data', source) };
  if (decoded.buffer.byteLength > config.maxBytes) return { skip: makeImageSkip(origin, `image exceeds max_bytes (${config.maxBytes})`, source) };

  const declaredMimeType = normalizeImageMime(dataUrl?.mediaType || source.mediaType || mimeFromPath(source.path || source.displayName));
  const detectedMimeType = mimeFromMagic(decoded.buffer);
  if (!imageMimeSupported(detectedMimeType)) {
    return { skip: makeImageSkip(origin, `unsupported MIME type ${declaredMimeType || detectedMimeType || 'unknown'}`, source) };
  }
  if (declaredMimeType && imageMimeSupported(declaredMimeType) && declaredMimeType !== detectedMimeType) {
    return { skip: makeImageSkip(origin, `MIME mismatch declared ${declaredMimeType} but detected ${detectedMimeType}`, source) };
  }
  if (declaredMimeType && !imageMimeSupported(declaredMimeType)) {
    return { skip: makeImageSkip(origin, `unsupported MIME type ${declaredMimeType}`, source) };
  }
  return { image: makeNormalizedImage(origin, decoded.data, detectedMimeType, decoded.buffer.byteLength, { ...source, index }) };
}

function normalizePathImage(origin, rawPath, config, index, ctx = {}, env = process.env, options = {}) {
  const cwd = resolve(firstString(ctx.cwd) || process.cwd());
  const originalPath = cleanPathCandidate(rawPath);
  const path = resolveImagePathCandidate(rawPath, cwd, env);
  const enforceAllowedRoots = options.enforceAllowedRoots !== false;
  if (!path) return { skip: makeImageSkip(origin, 'invalid image path', { path: String(rawPath || ''), originalPath }) };
  if (pathHasProtectedSegment(path) || pathHasProtectedSegment(originalPath)) {
    return { skip: makeImageSkip(origin, 'protected local path denied', { path, originalPath }) };
  }
  if (imageCandidateHasHiddenSegment(path, cwd)) {
    return { skip: makeImageSkip(origin, 'hidden path skipped', { path, originalPath }) };
  }
  let linkStats;
  try {
    linkStats = lstatSync(path);
  } catch {
    return { skip: makeImageSkip(origin, 'image path does not exist', { path, originalPath }) };
  }
  if (linkStats.isSymbolicLink()) {
    return { skip: makeImageSkip(origin, 'symlink path skipped', { path, originalPath }) };
  }
  let realPath;
  try {
    realPath = realpathSync(path);
  } catch {
    return { skip: makeImageSkip(origin, 'image path does not exist', { path, originalPath }) };
  }
  if (pathHasProtectedSegment(realPath)) return { skip: makeImageSkip(origin, 'protected local path denied', { path: realPath, originalPath }) };
  if (imageCandidateHasHiddenSegment(realPath, cwd)) return { skip: makeImageSkip(origin, 'hidden path skipped', { path: realPath, originalPath }) };
  if (enforceAllowedRoots && !imagePathAllowed(realPath, cwd, env)) return { skip: makeImageSkip(origin, 'path outside allowed image roots', { path: realPath, originalPath }) };
  let st;
  try {
    st = statSync(realPath);
  } catch {
    return { skip: makeImageSkip(origin, 'image path is not readable', { path: realPath, originalPath }) };
  }
  if (!st.isFile()) return { skip: makeImageSkip(origin, 'image path is not a file', { path: realPath, originalPath }) };
  if (st.size > config.maxBytes) return { skip: makeImageSkip(origin, `image exceeds max_bytes (${config.maxBytes})`, { path: realPath, originalPath }) };
  let buffer;
  try {
    buffer = readFileSync(realPath);
  } catch {
    return { skip: makeImageSkip(origin, 'image path is not readable', { path: realPath, originalPath }) };
  }
  const mediaType = mimeFromMagic(buffer);
  if (!imageMimeSupported(mediaType)) {
    return { skip: makeImageSkip(origin, `unsupported MIME type ${mimeFromPath(realPath) || mediaType || 'unknown'}`, { path: realPath, originalPath }) };
  }
  return {
    image: makeNormalizedImage(origin, buffer.toString('base64'), mediaType, buffer.byteLength, {
      index,
      path: realPath,
      originalPath,
      displayName: basename(realPath),
    }),
  };
}

function sourceFromImageAttachment(raw) {
  if (typeof raw === 'string') {
    const dataUrl = parseDataUrl(raw);
    return dataUrl ? { data: dataUrl.data, mediaType: dataUrl.mediaType } : { path: raw };
  }
  if (!raw || typeof raw !== 'object') return {};
  const source = raw.source && typeof raw.source === 'object' ? raw.source : {};
  const data = firstString(raw.data, raw.base64, raw.base64Data, source.data, source.base64);
  const path = firstString(raw.path, raw.filePath, raw.file_path, raw.filename, raw.url, source.path, source.filePath, source.url);
  const mediaType = normalizeImageMime(firstString(raw.mediaType, raw.mimeType, raw.mime, raw.type, source.mediaType, source.mimeType, source.mime));
  return {
    data,
    path,
    mediaType,
    displayName: firstString(raw.name, raw.filename, raw.fileName, raw.file_name, path),
  };
}

function collectImageInputs(event = {}, ctx = {}, config = resolveVisionPreflightConfig(), options = {}) {
  const env = options.env ?? process.env;
  const enforceAllowedRoots = imagePreflightShouldEnforceAllowedRoots(event, ctx, env);
  const images = [];
  const skipped = [];
  const seen = new Map();
  const addResult = (result) => {
    if (result.image) {
      const key = result.image.path ? `path:${result.image.path}` : `data:${result.image.mediaType}:${result.image.byteLength}:${result.image.data.slice(0, 32)}`;
      const existing = seen.get(key);
      if (existing) {
        mergeImagePathAliases(existing, result.image);
        return;
      }
      if (images.length >= config.maxImages) {
        skipped.push(makeImageSkip(result.image.origin, `max_images limit reached (${config.maxImages})`, result.image));
        return;
      }
      result.image.label = `image-${images.length + 1}`;
      mergeImagePathAliases(result.image, result.image);
      seen.set(key, result.image);
      images.push(result.image);
    } else if (result.skip) {
      skipped.push(result.skip);
    }
  };

  const rawImages = Array.isArray(event.images) ? event.images : [];
  const imageScanLimit = Math.min(Math.max(config.maxImages * 2, config.maxImages + 1), MAX_IMAGE_PREFLIGHT_ATTACHMENT_SCAN);
  const scannedRawImages = rawImages.slice(0, imageScanLimit);
  for (const [index, raw] of scannedRawImages.entries()) {
    const source = sourceFromImageAttachment(raw);
    const origin = `event.images[${index}]`;
    if (source.data) addResult(normalizeBase64Image(origin, source, config, index + 1));
    else if (source.path) addResult(normalizePathImage(origin, source.path, config, index + 1, { cwd: firstString(event.cwd, ctx.cwd) }, env, { enforceAllowedRoots }));
    else addResult({ skip: makeImageSkip(origin, 'unsupported image attachment shape', source) });
  }
  if (rawImages.length > imageScanLimit) {
    skipped.push(makeImageSkip('event.images', `image attachment scan limit reached (${imageScanLimit})`, { label: 'event.images' }));
  }

  const text = typeof event.text === 'string' ? event.text : '';
  for (const [index, candidate] of extractImagePathCandidates(text).entries()) {
    addResult(normalizePathImage(`event.text[${index}]`, candidate, config, rawImages.length + index + 1, { cwd: firstString(event.cwd, ctx.cwd) }, env, { enforceAllowedRoots }));
  }

  return {
    images,
    skipped,
    discoveredCount: rawImages.length + skipped.filter((item) => item.origin?.startsWith('event.text')).length + images.filter((item) => item.origin?.startsWith('event.text')).length,
    rawImageCount: rawImages.length,
  };
}

function truncateText(value, max = MAX_IMAGE_PREFLIGHT_REQUEST_TEXT_CHARS) {
  const text = String(value || '').replace(/\u0000/g, '').trim();
  return text.length > max ? `${text.slice(0, max - 24)}\n[truncated by Stronk Pi]` : text;
}

function visionSystemPrompt() {
  return [
    'You are Stronk Pi image vision preflight.',
    'Turn any supplied image into evidence-rich context for a text-only coding agent.',
    'Return JSON only. Do not wrap the JSON in Markdown.',
    'Use this universal shape, filling only fields that are relevant to the image:',
    '{"images":[{"label":"image-1","image_type":"photo|screenshot|document|chart|diagram|map|product|art|meme|mixed|unknown","overview":"one detailed sentence","quality_flags":["clear or limited"],"scene_and_composition":["image-1.E1: setting, background, foreground, viewpoint, lighting, style"],"subjects_and_entities":["image-1.E2: people, objects, products, places, visible named entities"],"attributes_and_state":["image-1.E3: colors, materials, condition, counts, measurements, state"],"spatial_relationships":["image-1.E4: positions, actions, interactions, movement, before/after relationship"],"visible_text":["image-1.E5: exact visible text, labels, captions, symbols"],"structured_content":["image-1.E6: tables, charts, diagrams, maps, forms, code, terminal output, UI, documents"],"domain_specific_details":["image-1.E7: relevant details for the detected image type"],"observed_facts":["image-1.E8: directly visible fact"],"uncertainties":["image-1.U1: unreadable, cropped, ambiguous, or low-confidence detail"],"negative_evidence":["image-1.N1: scoped not-visible result; do not treat as absent"],"inferences":["image-1.I1: inference citing image-1.E ids"],"guardrails":["how the text-only model should avoid overclaiming"]}]}',
    'Use image-scoped evidence ids. Prefix direct observations with <label>.E#, uncertainties with <label>.U#, scoped negative evidence with <label>.N#, and inferences with <label>.I#.',
    'Do not force every image into a UI or screenshot schema. First identify the image type, then describe what matters for that type.',
    'For photos, preserve subjects, setting, composition, actions, relationships, state, visible text, and visual details such as color/material/condition.',
    'For documents, screenshots, charts, diagrams, maps, code, or terminal images, preserve visible text, labels, values, layout, selected states, axes, legends, tables, errors, commands, and relationships.',
    'Keep original UI labels or document text when legible; add short translations only when confident.',
    'Include counts, measurements, identities, absence, density, condition, and relationships only when directly visible or clearly supported by cited evidence.',
    'Never say something is absent or missing just because it is omitted, cropped, unreadable, not visible, or unknown.',
    'Do not identify private people by name unless the image text explicitly names them. Do not infer sensitive traits.',
    'Prefer up to 12 observed evidence items, 6 uncertainties, and 6 inferences per image. Keep each item short and specific.',
    'Separate directly visible facts from inference. Do not invent hidden content, requirements, file metadata, off-screen UI, or unseen context.',
  ].join('\n');
}

function imageVisionOutputTokens(config = {}, imageCount = 1) {
  const perImage = clampedInteger(
    config.maxOutputTokens,
    DEFAULT_IMAGE_PREFLIGHT_RESPONSE_MAX_TOKENS,
    MIN_IMAGE_PREFLIGHT_RESPONSE_MAX_TOKENS,
    MAX_IMAGE_PREFLIGHT_RESPONSE_MAX_TOKENS,
  );
  const count = Math.max(1, Math.min(Math.trunc(Number(imageCount) || 1), MAX_IMAGE_PREFLIGHT_IMAGES));
  return Math.min(perImage * count, MAX_IMAGE_PREFLIGHT_REQUEST_MAX_TOKENS);
}

function buildVisionRequest(images, config, event = {}, ctx = {}, collected = { images }) {
  const outputTokens = imageVisionOutputTokens(config, images.length);
  let requestText = redactImageDataText(event.text || '');
  requestText = rewriteAnalyzedImageReferences(requestText, { collected });
  requestText = redactLocalPathText(requestText);
  requestText = redactImageDataText(requestText);
  const prompt = [
    'Analyze these user-supplied images so a downstream text-only model can answer the user without reading image files.',
    'Extract enough visual, textual, and structural evidence to support careful reasoning.',
    'Keep direct observations separate from inference, uncertainty, and scoped negative evidence.',
    'Use the labels from the image inventory exactly.',
    '',
    `Original user text:\n${truncateText(requestText)}`,
    '',
    'Image inventory:',
    ...images.map((image) => `- ${image.label}: ${image.displayName || image.origin}; mime=${image.mediaType}; bytes=${image.byteLength}`),
  ].join('\n');
  return {
    model: config.model,
    maxTokens: outputTokens,
    maxOutputTokens: outputTokens,
    maxOutputTokenCap: outputTokens,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    systemPrompt: visionSystemPrompt(),
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: prompt }, ...images.map((image) => image.contentPart)],
      },
    ],
    images: images.map(({
      data: _data,
      contentPart: _contentPart,
      path: _path,
      originalPath: _originalPath,
      pathAliases: _pathAliases,
      ...safe
    }) => safe),
    event: {
      sessionId: firstString(event.sessionId, event.session_id, ctx.sessionId, ctx.session_id),
      turnId: firstString(event.turnId, event.turn_id, ctx.turnId, ctx.turn_id),
    },
  };
}

async function runImageVisionPreflightRequest(images, config, event = {}, ctx = {}, collected = { images }, options = {}) {
  const request = buildVisionRequest(images, config, event, ctx, collected);
  const result = await withVisionTimeout(config.timeoutMs, ctx.signal, (signal) => {
    request.signal = signal;
    return invokeVisionPreflight(request, ctx, options);
  });
  return {
    request,
    summaryImages: alignSingleImageBatchSummaryLabels(
      sanitizeVisionSummaries(normalizeVisionSummary(result), collected),
      images,
    ),
  };
}

function imagePreflightTimedOut(error) {
  return /timed?\s*out|timeout/i.test(String(error?.message ?? error ?? ''));
}

function imagePreflightTimeoutRetryBatchSize(imageCount) {
  const count = Math.max(0, Math.trunc(Number(imageCount) || 0));
  if (count <= 1) return count;
  return Math.max(1, Math.min(IMAGE_PREFLIGHT_ARTIFACT_IMAGES_PER_HANDLE, Math.floor(count / 2)));
}

async function retryImageVisionPreflightAfterTimeout(error, config, event = {}, ctx = {}, collected = { images: [] }, options = {}) {
  const images = Array.isArray(collected.images) ? collected.images : [];
  if (!imagePreflightTimedOut(error) || images.length <= 1) throw error;

  const batchSize = imagePreflightTimeoutRetryBatchSize(images.length);
  const requests = [];
  const summaryImages = [];
  try {
    for (let index = 0; index < images.length; index += batchSize) {
      const attempt = await runImageVisionPreflightRequest(
        images.slice(index, index + batchSize),
        config,
        event,
        ctx,
        collected,
        options,
      );
      requests.push(attempt.request);
      summaryImages.push(...attempt.summaryImages);
    }
  } catch {
    throw error;
  }
  return { request: requests[0], requests, summaryImages, retriedAfterTimeout: true };
}

function extractVisionText(result) {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  if (typeof result.text === 'string') return result.text;
  if (typeof result.output === 'string') return result.output;
  if (typeof result.content === 'string') return result.content;
  if (Array.isArray(result.content)) {
    return result.content
      .map((item) => (typeof item === 'string' ? item : (item && typeof item.text === 'string' ? item.text : '')))
      .filter(Boolean)
      .join('\n');
  }
  if (Array.isArray(result.messages)) {
    return result.messages.map(extractVisionText).filter(Boolean).join('\n');
  }
  return '';
}

function visionSummaryJsonCandidates(text) {
  const candidates = [];
  const trimmed = String(text || '').trim();
  if (!trimmed) return candidates;
  candidates.push(trimmed);
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fencePattern.exec(trimmed)) !== null) {
    const fenced = match[1]?.trim();
    if (fenced) candidates.push(fenced);
  }
  return candidates;
}

function normalizeVisionSummary(result) {
  if (result && typeof result === 'object' && Array.isArray(result.images)) return result.images;
  const text = extractVisionText(result);
  if (!text) return [];
  for (const candidate of visionSummaryJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.images)) return parsed.images;
    } catch {
      // Fall back to the next candidate, then heading parsing below.
    }
  }
  const observed = [];
  const uncertainties = [];
  const inferences = [];
  let target;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^observed(?:\s+facts)?\s*:/i.test(line)) {
      target = observed;
      continue;
    }
    if (/^(uncertaint(?:y|ies)|limits?|unknowns?)\s*:/i.test(line)) {
      target = uncertainties;
      continue;
    }
    if (/^(inferences?|interpretations?)\s*:/i.test(line)) {
      target = inferences;
      continue;
    }
    const cleaned = line.replace(/^[-*]\s*/, '');
    if (target) target.push(cleaned);
  }
  if (observed.length || uncertainties.length || inferences.length) return [{ label: 'image-1', observed_facts: observed, uncertainties, inferences }];
  return [{ label: 'image-1', observed_facts: [], inferences: [`Unstructured vision output: ${truncateText(text, 2000)}`] }];
}

function sanitizeVisionSummaryText(value, collected = { images: [], skipped: [] }) {
  let text = sanitizeExternalText(value, { maxLength: Infinity });
  text = redactImageDataText(text);
  text = rewriteAnalyzedImageReferences(text, { collected });
  text = redactLocalPathText(text);
  return redactImageDataText(text);
}

function sanitizeVisionSummaryValue(value, collected = { images: [], skipped: [] }, depth = 0) {
  if (typeof value === 'string') return sanitizeVisionSummaryText(value, collected);
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (depth >= 8) return sanitizeVisionSummaryText(visionScalarText(value), collected);
  if (Array.isArray(value)) return value.map((item) => sanitizeVisionSummaryValue(item, collected, depth + 1));
  const sanitized = {};
  for (const [key, item] of Object.entries(value)) {
    const cleanKeyBase = sanitizeVisionSummaryText(key, collected) || 'field';
    let cleanKey = cleanKeyBase;
    let suffix = 2;
    while (Object.hasOwn(sanitized, cleanKey)) {
      cleanKey = `${cleanKeyBase}_${suffix}`;
      suffix += 1;
    }
    sanitized[cleanKey] = sanitizeVisionSummaryValue(item, collected, depth + 1);
  }
  return sanitized;
}

function sanitizeVisionSummaries(summaryImages = [], collected = { images: [], skipped: [] }) {
  if (!Array.isArray(summaryImages)) return [];
  return summaryImages.map((summary) => sanitizeVisionSummaryValue(summary, collected));
}

function alignSingleImageBatchSummaryLabels(summaryImages = [], images = []) {
  if (!Array.isArray(summaryImages) || images.length !== 1) return summaryImages;
  const label = firstString(images[0]?.label);
  if (!label) return summaryImages;
  const first = summaryImages[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return summaryImages;
  return [{ ...first, label }];
}

function apiKeyEnvName(reference) {
  const raw = String(reference || '').trim();
  if (!raw) return undefined;
  const braced = raw.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)}$/);
  if (braced) return braced[1];
  if (raw.startsWith('$')) {
    const name = raw.slice(1);
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : undefined;
  }
  return /^[A-Z_][A-Z0-9_]*$/.test(raw) ? raw : undefined;
}

function providerApiKeyReferences(providerName, providerConfig = {}) {
  const refs = [
    providerConfig.apiKey,
    providerConfig.api_key,
    providerConfig.apiKeyEnv,
    providerConfig.api_key_env,
  ];
  if (providerName === 'kimi-coding') refs.push('KIMI_API_KEY', 'KIMI_CODE_API_KEY');
  return [...new Set(refs
    .filter((ref) => typeof ref === 'string')
    .map((ref) => ref.trim())
    .filter(Boolean))];
}

function resolveProviderApiKey(providerName, providerConfig = {}, env = process.env) {
  const missing = [];
  for (const ref of providerApiKeyReferences(providerName, providerConfig)) {
    const envName = apiKeyEnvName(ref);
    if (envName) {
      const value = firstString(env[envName]);
      if (value) return { value, envName };
      missing.push(envName);
      continue;
    }
    return { value: ref, literal: true };
  }
  return { missing: [...new Set(missing)] };
}

function providerBaseUrl(providerConfig = {}) {
  const baseUrl = firstString(providerConfig.baseUrl, providerConfig.base_url, providerConfig.url, providerConfig.endpoint);
  if (!baseUrl) return undefined;
  return String(baseUrl).replace(/\/+$/g, '');
}

function providerUsesOpenAICompatibleChat(providerConfig = {}) {
  const api = firstString(providerConfig.api, providerConfig.kind, providerConfig.protocol);
  return !api || OPENAI_COMPATIBLE_APIS.has(String(api).trim().toLowerCase());
}

function providerUsesAnthropicMessages(providerConfig = {}) {
  const api = firstString(providerConfig.api, providerConfig.kind, providerConfig.protocol);
  return ANTHROPIC_MESSAGES_APIS.has(String(api || '').trim().toLowerCase());
}

function openAIChatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl || '').replace(/\/+$/g, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}

function anthropicMessagesUrl(baseUrl) {
  const trimmed = String(baseUrl || '').replace(/\/+$/g, '');
  if (trimmed.endsWith('/messages')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

function openAICompatibleContentPart(part) {
  if (typeof part === 'string') return { type: 'text', text: part };
  if (!part || typeof part !== 'object') return undefined;
  if (part.type === 'text') return { type: 'text', text: String(part.text || '') };
  if (part.type === 'image_url' && part.image_url) return part;
  if (part.type !== 'image') return undefined;
  const source = part.source && typeof part.source === 'object' ? part.source : {};
  const mediaType = normalizeImageMime(source.mediaType || source.mimeType || part.mediaType || part.mimeType);
  const data = firstString(source.data, source.base64, part.data, part.base64);
  if (!mediaType || !data) return undefined;
  return {
    type: 'image_url',
    image_url: { url: `data:${mediaType};base64,${data}` },
  };
}

function openAICompatibleMessage(message = {}) {
  const role = firstString(message.role) || 'user';
  const content = Array.isArray(message.content)
    ? message.content.map(openAICompatibleContentPart).filter(Boolean)
    : String(message.content || '');
  return { role, content };
}

function imageVisionOutputTokenCap(request = {}, options = {}) {
  return clampedInteger(
    firstPresent(options.maxVisionTokenCap, request.maxOutputTokenCap),
    MAX_IMAGE_PREFLIGHT_RESPONSE_MAX_TOKENS,
    MIN_IMAGE_PREFLIGHT_RESPONSE_MAX_TOKENS,
    MAX_IMAGE_PREFLIGHT_REQUEST_MAX_TOKENS,
  );
}

function buildOpenAIVisionPayload(request, resolvedProvider, options = {}) {
  const providerConfig = resolvedProvider.providerConfig || {};
  const compat = providerConfig.compat && typeof providerConfig.compat === 'object' ? providerConfig.compat : {};
  const messages = (Array.isArray(request.messages) ? request.messages : []).map(openAICompatibleMessage);
  if (request.systemPrompt) {
    if (compat.supportsSystemRole === false && messages.length > 0) {
      const first = messages[0];
      first.content = Array.isArray(first.content)
        ? [{ type: 'text', text: request.systemPrompt }, ...first.content]
        : `${request.systemPrompt}\n\n${first.content || ''}`;
    } else {
      messages.unshift({ role: 'system', content: request.systemPrompt });
    }
  }
  const maxTokensField = firstString(compat.maxTokensField, compat.max_tokens_field) || 'max_tokens';
  const maxTokens = clampedInteger(
    firstPresent(
      options.maxVisionTokens,
      request.maxOutputTokens,
      request.maxTokens,
      providerConfig.visionMaxTokens,
      resolvedProvider.modelConfig?.visionMaxTokens,
    ),
    DEFAULT_IMAGE_PREFLIGHT_RESPONSE_MAX_TOKENS,
    MIN_IMAGE_PREFLIGHT_RESPONSE_MAX_TOKENS,
    imageVisionOutputTokenCap(request, options),
  );
  return {
    model: resolvedProvider.modelId,
    messages,
    [maxTokensField]: maxTokens,
  };
}

function extractOpenAICompletionText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.output_text === 'string') return payload.output_text;
  if (typeof payload.text === 'string') return payload.text;
  if (Array.isArray(payload.choices)) {
    return payload.choices
      .map((choice) => extractVisionText(choice?.message ?? choice?.delta ?? choice))
      .filter(Boolean)
      .join('\n');
  }
  return extractVisionText(payload);
}

function anthropicContentPart(part) {
  if (typeof part === 'string') return { type: 'text', text: part };
  if (!part || typeof part !== 'object') return undefined;
  if (part.type === 'text') return { type: 'text', text: String(part.text || '') };
  if (part.type !== 'image') return undefined;
  const source = part.source && typeof part.source === 'object' ? part.source : {};
  const mediaType = normalizeImageMime(source.mediaType || source.mimeType || part.mediaType || part.mimeType);
  const data = firstString(source.data, source.base64, part.data, part.base64);
  if (!mediaType || !data) return undefined;
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data,
    },
  };
}

function anthropicMessage(message = {}) {
  const role = firstString(message.role) === 'assistant' ? 'assistant' : 'user';
  const content = Array.isArray(message.content)
    ? message.content.map(anthropicContentPart).filter(Boolean)
    : String(message.content || '');
  return { role, content };
}

function providerStaticHeaders(providerConfig = {}, modelConfig = {}) {
  return {
    ...(providerConfig.headers && typeof providerConfig.headers === 'object' ? providerConfig.headers : {}),
    ...(modelConfig.headers && typeof modelConfig.headers === 'object' ? modelConfig.headers : {}),
  };
}

function responseHeader(response, name) {
  const headers = response?.headers;
  if (!headers || typeof headers.get !== 'function') return '';
  return String(headers.get(name) || '');
}

function responseIsEventStream(response) {
  return /\btext\/event-stream\b/i.test(responseHeader(response, 'content-type'));
}

function shouldStreamAnthropicVisionPreflight(resolvedProvider = {}, options = {}) {
  if (options.streamVisionPreflight === false) return false;
  if (options.streamVisionPreflight === true) return true;
  const providerConfig = resolvedProvider.providerConfig || {};
  if (parseBoolean(firstPresent(providerConfig.visionStream, providerConfig.vision_stream, providerConfig.stream), false)) {
    return true;
  }
  return firstString(resolvedProvider.providerName) === 'kimi-coding';
}

function buildAnthropicVisionPayload(request, resolvedProvider, options = {}) {
  const providerConfig = resolvedProvider.providerConfig || {};
  const messages = (Array.isArray(request.messages) ? request.messages : []).map(anthropicMessage);
  const maxTokens = clampedInteger(
    firstPresent(
      options.maxVisionTokens,
      request.maxOutputTokens,
      request.maxTokens,
      providerConfig.visionMaxTokens,
      resolvedProvider.modelConfig?.visionMaxTokens,
    ),
    DEFAULT_IMAGE_PREFLIGHT_RESPONSE_MAX_TOKENS,
    MIN_IMAGE_PREFLIGHT_RESPONSE_MAX_TOKENS,
    imageVisionOutputTokenCap(request, options),
  );
  const payload = {
    model: resolvedProvider.modelId,
    messages,
    max_tokens: maxTokens,
    stream: options.stream === true,
  };
  if (request.systemPrompt) {
    payload.system = [{ type: 'text', text: request.systemPrompt }];
  }
  return payload;
}

function parseServerSentEventBlock(block) {
  let event = 'message';
  const data = [];
  for (const line of String(block || '').split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trim() || event;
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).trimStart());
    }
  }
  return { event, data: data.join('\n') };
}

function nextServerSentEventSeparator(buffer) {
  const match = String(buffer || '').match(/\r?\n\r?\n/);
  return match && match.index !== undefined
    ? { index: match.index, length: match[0].length }
    : undefined;
}

function anthropicStreamTextDelta(payload) {
  const delta = payload?.delta;
  if (delta?.type === 'text_delta' && typeof delta.text === 'string') return delta.text;
  if (typeof delta?.text === 'string') return delta.text;
  if (payload?.type === 'content_block_start' && payload.content_block?.type === 'text') {
    return typeof payload.content_block.text === 'string' ? payload.content_block.text : '';
  }
  return '';
}

function anthropicStreamSemanticProgress(payload) {
  const delta = payload?.delta;
  return Boolean(firstString(
    anthropicStreamTextDelta(payload),
    delta?.thinking,
    delta?.partial_json,
  ));
}

async function readWithAbort(reader, signal) {
  if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : new Error('vision preflight stream aborted'));
  let onAbort;
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error('vision preflight stream aborted'));
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
  }
}

async function withVisionStreamIdleTimeout(timeoutMs, parentSignal, action) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parentSignal?.reason instanceof Error ? parentSignal.reason : new Error('vision preflight aborted'));
  parentSignal?.addEventListener?.('abort', onAbort, { once: true });
  const idleMs = clampedInteger(
    timeoutMs,
    DEFAULT_IMAGE_PREFLIGHT_STREAM_IDLE_TIMEOUT_MS,
    MIN_IMAGE_PREFLIGHT_STREAM_IDLE_TIMEOUT_MS,
    MAX_IMAGE_PREFLIGHT_STREAM_IDLE_TIMEOUT_MS,
  );
  let timer;
  const resetIdle = (label = 'stream token') => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      controller.abort(new Error(`vision preflight stream idle timed out waiting for ${label}`));
    }, idleMs);
  };
  resetIdle('first stream token');
  try {
    return await action(controller.signal, resetIdle);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener?.('abort', onAbort);
  }
}

async function readAnthropicEventStreamResponse(response, providerName, secretValues = [], options = {}) {
  if (!response?.ok) {
    return { text: extractAnthropicMessageText(await readProviderJsonResponse(response, providerName, secretValues)) };
  }
  const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : undefined;
  if (!reader) {
    return { text: extractAnthropicMessageText(await readProviderJsonResponse(response, providerName, secretValues)) };
  }
  const decoder = new TextDecoder();
  const output = [];
  const eventTypes = {};
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await readWithAbort(reader, options.signal);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator;
      while ((separator = nextServerSentEventSeparator(buffer))) {
        const block = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator.length);
        const event = parseServerSentEventBlock(block);
        if (!event.data) continue;
        if (event.data === '[DONE]') {
          eventTypes['[DONE]'] = (eventTypes['[DONE]'] || 0) + 1;
          continue;
        }
        let parsed;
        try {
          parsed = JSON.parse(event.data);
        } catch (error) {
          throw new Error(`vision provider ${providerName} returned invalid event stream JSON: ${redactProviderText(error?.message || event.data, 240)}`);
        }
        const type = firstString(parsed?.type, event.event) || 'message';
        eventTypes[type] = (eventTypes[type] || 0) + 1;
        const text = anthropicStreamTextDelta(parsed);
        if (text) output.push(text);
        if (anthropicStreamSemanticProgress(parsed)) options.resetIdle?.('next stream token');
      }
    }
    const trailing = buffer + decoder.decode();
    if (trailing.trim()) {
      throw new Error(`vision provider ${providerName} returned incomplete event stream data`);
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // The stream may already be closed or aborted by the provider.
    }
    throw error;
  }
  return { text: output.join(''), response: { stream: true, eventTypes } };
}

function extractAnthropicMessageText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.text === 'string') return payload.text;
  if (Array.isArray(payload.content)) {
    return payload.content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item.text === 'string') return item.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return extractVisionText(payload);
}

async function readProviderJsonResponse(response, providerName, secretValues = []) {
  const text = typeof response?.text === 'function' ? await response.text() : '';
  if (!response?.ok) {
    const status = Number.isFinite(response?.status) ? response.status : 'unknown';
    const detail = redactSearchError(text, secretValues);
    throw new Error(`vision provider ${providerName} returned HTTP ${status}${detail ? `: ${detail}` : ''}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`vision provider ${providerName} returned invalid JSON: ${redactProviderText(error?.message || text, 240)}`);
  }
}

async function invokeOpenAICompatibleVisionPreflight(request, ctx = {}, options = {}) {
  const env = options.env ?? process.env;
  const resolvedProvider = resolveVisionProviderConfig(request.model, options);
  if (!resolvedProvider) throw new Error(`vision model not found in models.json: ${request.model}`);
  const { providerName, providerConfig, modelConfig } = resolvedProvider;
  if (!providerUsesOpenAICompatibleChat(providerConfig)) {
    throw new Error(`vision provider ${providerName} is not OpenAI-compatible`);
  }
  const baseUrl = providerBaseUrl(providerConfig);
  if (!baseUrl) throw new Error(`vision provider ${providerName} is missing baseUrl`);
  const apiKey = resolveProviderApiKey(providerName, providerConfig, env);
  if (!apiKey.value) {
    const missing = apiKey.missing?.length ? apiKey.missing.join(' or ') : 'provider API key';
    throw new Error(`missing ${missing} for vision model ${request.model}`);
  }
  const fetchFn = options.fetch ?? ctx.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new Error('vision preflight requires fetch for configured provider fallback');
  const payload = buildOpenAIVisionPayload(request, resolvedProvider, options);
  const response = await fetchFn(openAIChatCompletionsUrl(baseUrl), {
    method: 'POST',
    headers: {
      ...providerStaticHeaders(providerConfig, modelConfig),
      authorization: `Bearer ${apiKey.value}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: request.signal,
  });
  const json = await readProviderJsonResponse(response, providerName, [apiKey.value]);
  return { text: extractOpenAICompletionText(json), response: json };
}

async function invokeAnthropicMessagesVisionPreflight(request, ctx = {}, options = {}) {
  const env = options.env ?? process.env;
  const resolvedProvider = resolveVisionProviderConfig(request.model, options);
  if (!resolvedProvider) throw new Error(`vision model not found in models.json: ${request.model}`);
  const { providerName, providerConfig, modelConfig } = resolvedProvider;
  if (!providerUsesAnthropicMessages(providerConfig)) {
    throw new Error(`vision provider ${providerName} is not Anthropic Messages-compatible`);
  }
  const baseUrl = providerBaseUrl(providerConfig);
  if (!baseUrl) throw new Error(`vision provider ${providerName} is missing baseUrl`);
  const apiKey = resolveProviderApiKey(providerName, providerConfig, env);
  if (!apiKey.value) {
    const missing = apiKey.missing?.length ? apiKey.missing.join(' or ') : 'provider API key';
    throw new Error(`missing ${missing} for vision model ${request.model}`);
  }
  const fetchFn = options.fetch ?? ctx.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new Error('vision preflight requires fetch for configured provider fallback');
  const stream = shouldStreamAnthropicVisionPreflight(resolvedProvider, options);
  const invoke = async (signal = request.signal, resetIdle) => {
    const payload = buildAnthropicVisionPayload(request, resolvedProvider, { ...options, stream });
    const response = await fetchFn(anthropicMessagesUrl(baseUrl), {
      method: 'POST',
      headers: {
        ...providerStaticHeaders(providerConfig, modelConfig),
        'x-api-key': apiKey.value,
        accept: stream ? 'text/event-stream, application/json' : 'application/json',
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(payload),
      signal,
    });
    if (stream && responseIsEventStream(response)) {
      return readAnthropicEventStreamResponse(response, providerName, [apiKey.value], {
        signal,
        resetIdle,
      });
    }
    const json = await readProviderJsonResponse(response, providerName, [apiKey.value]);
    return { text: extractAnthropicMessageText(json), response: json };
  };
  if (stream) {
    return withVisionStreamIdleTimeout(request.streamIdleTimeoutMs, request.signal, invoke);
  }
  return invoke();
}

async function invokeConfiguredProviderVisionPreflight(request, ctx = {}, options = {}) {
  const resolvedProvider = resolveVisionProviderConfig(request.model, options);
  if (!resolvedProvider) throw new Error(`vision model not found in models.json: ${request.model}`);
  if (providerUsesAnthropicMessages(resolvedProvider.providerConfig)) {
    return invokeAnthropicMessagesVisionPreflight(request, ctx, options);
  }
  return invokeOpenAICompatibleVisionPreflight(request, ctx, options);
}

async function invokeVisionPreflight(request, ctx = {}, options = {}) {
  const direct = options.visionPreflight || ctx.visionPreflight || ctx.runVisionPreflight || ctx.imageVisionPreflight;
  if (typeof direct === 'function') return direct(request);

  const complete = options.complete || ctx.complete;
  const registry = options.modelRegistry || ctx.modelRegistry;
  if (typeof complete !== 'function') {
    return invokeConfiguredProviderVisionPreflight(request, ctx, options);
  }
  if (!registry) {
    return complete(request);
  }
  const parts = modelRefParts(request.model);
  const model = registry.find?.(parts.provider, parts.modelId) || registry.find?.(parts.full || request.model) || registry.get?.(parts.full || request.model);
  if (!model) throw new Error(`vision model not found: ${request.model}`);
  const auth = await registry.getApiKeyAndHeaders?.(model);
  return complete(
    model,
    {
      systemPrompt: request.systemPrompt,
      messages: request.messages,
    },
    {
      ...(auth || {}),
      signal: request.signal,
    },
  );
}

async function withVisionTimeout(timeoutMs, parentSignal, action) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parentSignal?.reason instanceof Error ? parentSignal.reason : new Error('vision preflight aborted'));
  parentSignal?.addEventListener?.('abort', onAbort, { once: true });
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => action(controller.signal)),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error('vision preflight timed out');
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener?.('abort', onAbort);
  }
}

function visionScalarText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(visionScalarText).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, item]) => {
        const text = visionScalarText(item);
        return text ? `${key}=${text}` : '';
      })
      .filter(Boolean)
      .join(', ');
  }
  return String(value).trim();
}

function firstVisionText(item, keys) {
  if (!item || typeof item !== 'object') return '';
  for (const key of keys) {
    const text = visionScalarText(item[key]);
    if (text) return text;
  }
  return '';
}

function formatVisionItem(item) {
  if (item === undefined || item === null) return '';
  if (typeof item !== 'object' || Array.isArray(item)) return visionScalarText(item);

  const id = firstVisionText(item, ['id', 'evidence_id', 'evidenceId']);
  const primary = firstVisionText(item, [
    'observation',
    'text',
    'raw_text',
    'normalized_text',
    'claim',
    'description',
    'summary',
    'label',
    'value',
    'status',
    'result',
    'note',
  ]);
  const prefix = id ? `${id}: ` : '';
  const main = primary ? `${prefix}${primary}` : `${prefix}${visionScalarText(item)}`.trim();
  const details = [];
  const detailKeys = [
    ['type', 'type'],
    ['role', 'role'],
    ['location', 'location'],
    ['scope', 'scope'],
    ['state', 'state'],
    ['status', 'status'],
    ['result', 'result'],
    ['value', 'value'],
    ['translation', 'translation'],
    ['evidence', 'evidence'],
    ['evidence', 'evidence_ids'],
    ['confidence', 'confidence'],
    ['note', 'note'],
  ];
  for (const [label, key] of detailKeys) {
    const text = visionScalarText(item[key]);
    if (!text || text === primary || text === id) continue;
    details.push(`${label}=${text}`);
  }
  return details.length > 0 ? `${main} (${details.join('; ')})` : main;
}

function visionItems(value) {
  const raw = Array.isArray(value) ? value : (value === undefined || value === null || value === '' ? [] : [value]);
  return raw.map(formatVisionItem).map((item) => item.trim()).filter(Boolean);
}

function collectVisionFields(summary = {}, keys = []) {
  const values = [];
  if (!summary || typeof summary !== 'object') return values;
  for (const key of keys) values.push(...visionItems(summary[key]));
  return [...new Set(values)];
}

function summaryForImage(image, images, summaryImages) {
  const exact = summaryImages.find((item) => item?.label === image.label);
  if (exact) return exact;
  const indexed = summaryImages[images.indexOf(image)];
  if (indexed?.label && indexed.label !== image.label) return {};
  return indexed || {};
}

function bulletLines(items, fallback, options = {}) {
  const values = visionItems(items);
  if (values.length === 0) return [`- ${fallback}`];
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.trunc(options.limit)) : values.length;
  const scopedValues = options.evidenceScope
    ? values.map((item) => scopeEvidenceReferences(item, options.evidenceScope, {
      scopeCitationReferences: options.scopeCitationReferences === true,
    }))
    : values;
  const shown = scopedValues.slice(0, limit);
  const itemMaxChars = options.itemMaxChars === null
    ? undefined
    : Number.isFinite(options.itemMaxChars)
      ? Math.max(200, Math.trunc(options.itemMaxChars))
      : 1200;
  const lines = shown.map((item) => `- ${itemMaxChars === undefined ? item : truncateText(item, itemMaxChars)}`);
  const omitted = scopedValues.length - shown.length;
  if (omitted > 0) lines.push(`- +${omitted} additional items omitted by Stronk Pi.`);
  return lines;
}

function scopeEvidenceReferences(text, imageLabel, options = {}) {
  const label = String(imageLabel || '').trim();
  let scoped = String(text || '');
  if (!label) return scoped;
  const leadingScoped = scoped.match(/^(image-\d+)\.([EUNI]\d+)(?=[:\s-])/);
  if (leadingScoped && leadingScoped[1] !== label) {
    const previousLabel = leadingScoped[1];
    scoped = `${label}.${leadingScoped[2]}${scoped.slice(leadingScoped[0].length)}`;
    scoped = retargetScopedEvidenceReferences(scoped, previousLabel, label);
  }
  scoped = scoped.replace(/^([EUNI]\d+)(?=[:\s-])/, `${label}.$1`);
  scoped = scoped.replace(/\b(evidence(?:_ids)?=)([^);]+)/gi, (_match, prefix, value) => (
    `${prefix}${scopeBareEvidenceReferences(value, label)}`
  ));
  if (options.scopeCitationReferences) scoped = scopeBareEvidenceReferences(scoped, label);
  return scoped;
}

function retargetScopedEvidenceReferences(text, fromLabel, toLabel) {
  const source = String(fromLabel || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const target = String(toLabel || '').trim();
  if (!source || !target) return String(text || '');
  const pattern = new RegExp(`(^|[^A-Za-z0-9_.-])${source}\\.([EUNI]\\d+)\\b`, 'g');
  return String(text || '').replace(pattern, (_match, prefix, evidenceId) => `${prefix}${target}.${evidenceId}`);
}

function scopeBareEvidenceReferences(text, imageLabel) {
  const label = String(imageLabel || '').trim();
  if (!label) return String(text || '');
  return String(text || '').replace(/(^|[^A-Za-z0-9_.-])([EUNI]\d+)\b/g, (_match, prefix, evidenceId) => (
    `${prefix}${label}.${evidenceId}`
  ));
}

function renderImageEvidenceIndex(lines, images = []) {
  lines.push('', 'Image Evidence Index:');
  if (images.length === 0) {
    lines.push('- No supported images were analyzed.');
    return;
  }
  for (const image of images) {
    const label = firstString(image.label) || 'image';
    const displayName = truncateText(firstString(image.displayName, image.origin, label) || label, 160);
    const origin = truncateText(firstString(image.origin) || 'unknown', 120);
    const mediaType = firstString(image.mediaType) || 'unknown';
    const byteLength = Number.isFinite(image.byteLength) ? Math.max(0, Math.trunc(image.byteLength)) : 'unknown';
    lines.push(`- ${label}: ${displayName}; source=${origin}; mime=${mediaType}; bytes=${byteLength}; citation_prefix=${label}.`);
  }
}

function compactMediaType(mediaType) {
  const text = String(mediaType || '').trim().toLowerCase();
  if (!text) return 'unknown';
  if (text.startsWith('image/')) return text.slice(6).replace('jpeg', 'jpg');
  return text;
}

function compactByteLength(byteLength) {
  if (!Number.isFinite(byteLength)) return '?B';
  const bytes = Math.max(0, Math.trunc(byteLength));
  if (bytes >= 1024 * 1024) {
    const mib = bytes / (1024 * 1024);
    return `${(mib >= 10 ? Math.round(mib) : Number(mib.toFixed(1))).toString()}MiB`;
  }
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KiB`;
  return `${bytes}B`;
}

function imagePreflightImageRange(images = []) {
  const labels = images.map((image) => firstString(image?.label)).filter(Boolean);
  if (labels.length === 0) return 'none';
  if (labels.length === 1) return labels[0];
  return `${labels[0]}..${labels[labels.length - 1]}`;
}

function imagePreflightArtifactGroupsForCompact(artifact) {
  if (Array.isArray(artifact?.groups) && artifact.groups.length > 0) return artifact.groups;
  if (artifact?.handle) return [{
    handle: artifact.handle,
    imageRange: artifact.imageRange || 'all images',
    imageLabels: artifact.imageLabels || [],
    charLength: artifact.charLength,
    truncated: artifact.truncated,
  }];
  return [];
}

function imagePreflightArtifactGroupForImage(artifact, label) {
  if (!label) return undefined;
  return imagePreflightArtifactGroupsForCompact(artifact).find((group) => (
    Array.isArray(group.imageLabels) && group.imageLabels.includes(label)
  ));
}

function imagePreflightArtifactGroupLine(group = {}) {
  const range = firstString(group.imageRange) || 'images';
  const handle = firstString(group.handle) || 'missing-handle';
  const charCount = Number.isFinite(group.charLength) ? ` chars=${group.charLength}` : '';
  const capped = group.truncated ? ' capped=true' : ' capped=false';
  return `${range}: handle=${handle}${charCount}${capped}`;
}

function compactImageIndexEntry(image = {}, artifact) {
  const label = firstString(image.label) || 'image';
  const displayName = truncateText(firstString(image.displayName, image.origin, label) || label, 72);
  const group = imagePreflightArtifactGroupForImage(artifact, label);
  const groupSuffix = group?.imageRange ? `@${group.imageRange}` : '';
  return `${label}=${displayName}/${compactMediaType(image.mediaType)}/${compactByteLength(image.byteLength)}${groupSuffix}`;
}

function renderCompactVisionContext({ config, images, summaryImages, skipped = [], failure, artifact, maxChars = MAX_IMAGE_PREFLIGHT_CONTEXT_TEXT_CHARS }) {
  const analyzedCount = failure ? summaryImages.length : images.length;
  const artifactGroups = imagePreflightArtifactGroupsForCompact(artifact);
  const index = images.length > 0
    ? images.map((image) => compactImageIndexEntry(image, artifact)).join('; ')
    : 'none supported';
  const lines = [
    `<${IMAGE_PREFLIGHT_CONTEXT_TAG}>`,
    `${IMAGE_PREFLIGHT_MARKER} | model=${config.model} | analyzed=${analyzedCount}`,
    '',
    `Artifact index only. Do not make visual claims from this block alone; call ${IMAGE_PREFLIGHT_READ_TOOL} with the handle for the relevant image group before citing evidence. For cross-image claims, read every relevant group. Unshown details are unavailable, not absent.`,
    `Artifact Groups: ${artifactGroups.map(imagePreflightArtifactGroupLine).join('; ')}`,
    `Image Evidence Index: ${index}`,
  ];
  if (failure) lines.push(`Preflight status: failed (${failure})`);
  if (skipped.length > 0) {
    const shown = skipped.slice(0, MAX_IMAGE_PREFLIGHT_IMAGES).map((item) => {
      const name = safeImageDisplayName(item, item.label || item.origin || 'image');
      return `${name}=${item.reason}`;
    });
    const omitted = skipped.length - shown.length;
    lines.push(`Skipped Images: ${shown.join('; ')}${omitted > 0 ? `; omitted=${omitted}` : ''}`);
  }
  lines.push(`</${IMAGE_PREFLIGHT_CONTEXT_TAG}>`);
  const rendered = lines.join('\n');
  return Number.isFinite(maxChars) ? truncateText(rendered, maxChars) : rendered;
}

function renderVisionImageSection(lines, title, images, summaryImages, fieldKeys, fallback, options = {}) {
  const sectionItems = images.map((image) => ({
    image,
    items: collectVisionFields(summaryForImage(image, images, summaryImages), fieldKeys),
  }));
  const hasItems = sectionItems.some((entry) => entry.items.length > 0);
  if (!options.required && !hasItems) return;

  lines.push('', `${title}:`);
  for (const { image, items } of sectionItems) {
    const heading = options.includeImageMeta
      ? `${image.label} (${image.displayName || image.origin}; ${image.mediaType}; ${image.byteLength} bytes)`
      : image.label;
    lines.push(heading);
    lines.push(...bulletLines(items, fallback, {
      limit: options.limit,
      evidenceScope: image.label,
      scopeCitationReferences: options.scopeCitationReferences,
      itemMaxChars: options.itemMaxChars,
    }));
  }
  if (images.length === 0) lines.push(`- ${options.emptyFallback || fallback}`);
}

function countLabel(count, singular, plural = `${singular}s`) {
  const value = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  return `${value} ${value === 1 ? singular : plural}`;
}

function safeImagePreflightFailureReason(reason) {
  const text = String(reason || '').toLowerCase();
  if (/timed?\s*out|timeout/.test(text)) return 'timed out';
  if (/missing .*key|api key|credential|authentication|unauthori[sz]ed|http\s*401|http\s*403/.test(text)) return 'missing vision model credentials';
  if (/invalid json|invalid response|malformed/.test(text)) return 'vision provider returned invalid response';
  if (/unsupported mime|unsupported image|invalid image|image exceeds|max_bytes|max_images/.test(text)) return 'unsupported or oversized image';
  if (/ctx\.complete|ctx\.visionpreflight|unavailable|missing.*fetch|model not found/.test(text)) return 'vision preflight unavailable';
  if (text) return 'vision provider request failed';
  return 'unexpected vision preflight error';
}

function formatImagePreflightStatus(status = {}) {
  const imageCount = Number(status.imageCount ?? status.analyzedCount ?? 0);
  const skippedCount = Number(status.skippedCount ?? 0);
  const skipped = skippedCount > 0 ? `; skipped ${countLabel(skippedCount, 'image')}` : '';
  if (status.phase === 'analyzing') {
    return `Stronk Pi detected ${countLabel(imageCount, 'image')} for a text-only model; analyzing with vision preflight.`;
  }
  if (status.phase === 'complete') {
    return `Image vision preflight complete: analyzed ${countLabel(imageCount, 'image')}${skipped}.`;
  }
  if (status.phase === 'skipped') {
    return `Image vision preflight skipped: no supported images found${skipped}.`;
  }
  if (status.phase === 'failed') {
    const reason = safeImagePreflightFailureReason(status.reason);
    const mode = status.failureMode === 'block' ? '' : '; using a failure note instead of raw images';
    return `Image vision preflight failed: ${reason}${mode}.`;
  }
  return undefined;
}

function emitImagePreflightStatus(options = {}, status = {}) {
  if (typeof options.onStatus !== 'function') return false;
  try {
    options.onStatus(status);
    return true;
  } catch {
    return false;
  }
}

function visionContextIdentity(source) {
  if (source === IMAGE_READ_TOOL) {
    return {
      tag: IMAGE_READ_CONTEXT_TAG,
      marker: IMAGE_READ_MARKER,
      guidance: 'Use this block as the image_read result for this turn. Do not re-read this same image unless the user asks for a fresh analysis or file metadata.',
      failureLabel: 'Image read status',
    };
  }
  return {
    tag: IMAGE_PREFLIGHT_CONTEXT_TAG,
    marker: IMAGE_PREFLIGHT_MARKER,
    guidance: 'Use this block as the image input for this turn. Do not call file or image read tools for these images unless the user asks for file metadata.',
    failureLabel: 'Preflight status',
  };
}

function renderVisionContext({ config, images, summaryImages, skipped = [], failure, artifact, full = false, maxChars, source } = {}) {
  const resolvedMaxChars = maxChars === undefined
    ? full ? undefined : MAX_IMAGE_PREFLIGHT_CONTEXT_TEXT_CHARS
    : maxChars;
  if ((artifact?.handle || artifact?.groups?.length) && !full) {
    return renderCompactVisionContext({ config, images, summaryImages, skipped, failure, artifact, maxChars: resolvedMaxChars });
  }
  const identity = visionContextIdentity(source);
  const analyzedCount = failure ? summaryImages.length : images.length;
  const sectionLimit = (value) => (full ? undefined : value);
  const itemMaxChars = full ? null : 1200;
  const lines = [
    `<${identity.tag}>`,
    `${identity.marker}`,
    `Vision model: ${config.model}`,
    `Images analyzed: ${analyzedCount}`,
    identity.guidance,
    'Evidence rule: omitted, unknown, unreadable, cropped, or not-visible details are unavailable, not absent. Only make identity, absence, count, measurement, condition, layout, chart, document, UI, relationship, or scene claims when direct evidence below supports them.',
    'Evidence IDs are image-scoped in this block: use ids like image-1.E1, image-2.U1, image-3.N1, and image-4.I1 when citing image evidence.',
  ];
  if (!failure && images.length > 0 && summaryImages.length !== images.length) lines.push(`Vision summaries returned: ${summaryImages.length}`);
  if (failure) lines.push(`${identity.failureLabel}: failed (${failure})`);
  renderImageEvidenceIndex(lines, images);
  if (skipped.length > 0) {
    lines.push('', 'Skipped Images:');
    for (const item of skipped) {
      const name = safeImageDisplayName(item, item.label || item.origin || 'image');
      lines.push(`- ${name}: ${item.reason}`);
    }
  }
  renderVisionImageSection(lines, 'Overview', images, summaryImages, ['overview', 'summary'], 'No overview was returned.', { limit: sectionLimit(3), itemMaxChars });
  renderVisionImageSection(lines, 'Image Type, Quality, And Scope', images, summaryImages, ['image_type', 'imageType', 'content_type', 'contentType', 'modality', 'quality_flags', 'qualityFlags', 'source_context', 'sourceContext', 'limits'], 'No type, quality, or scope notes were returned.', { limit: sectionLimit(8), itemMaxChars });
  renderVisionImageSection(lines, 'Scene And Composition', images, summaryImages, ['scene_and_composition', 'sceneAndComposition', 'scene', 'scene_description', 'sceneDescription', 'setting', 'environment', 'composition', 'foreground', 'background', 'lighting', 'visual_style', 'visualStyle', 'style', 'medium', 'layout', 'regions', 'spatial_structure', 'spatialStructure'], 'No scene or composition details were returned.', { limit: sectionLimit(12), itemMaxChars });
  renderVisionImageSection(lines, 'Subjects, Objects, And Entities', images, summaryImages, ['subjects_and_entities', 'subjectsAndEntities', 'subjects', 'objects', 'entities', 'people', 'living_subjects', 'livingSubjects', 'products', 'places', 'landmarks', 'brands'], 'No subject/object/entity details were returned.', { limit: sectionLimit(12), itemMaxChars });
  renderVisionImageSection(lines, 'Attributes, Counts, And State', images, summaryImages, ['attributes_and_state', 'attributesAndState', 'attributes', 'colors', 'materials', 'condition', 'state', 'measurements', 'counts', 'counts_and_density', 'countsAndDensity', 'density'], 'No attribute, count, or state details were returned.', { limit: sectionLimit(10), itemMaxChars });
  renderVisionImageSection(lines, 'Relationships And Activity', images, summaryImages, ['spatial_relationships', 'spatialRelationships', 'relationships', 'relative_positions', 'relativePositions', 'actions', 'events', 'activity', 'interactions', 'poses', 'motion'], 'No relationship or activity details were returned.', { limit: sectionLimit(10), itemMaxChars });
  renderVisionImageSection(lines, 'Visible Text And Symbols', images, summaryImages, ['visible_text', 'visibleText', 'ocr_spans', 'ocrSpans', 'text_spans', 'textSpans', 'transcription', 'labels', 'captions', 'signage', 'symbols'], 'No visible text was returned.', { limit: sectionLimit(12), itemMaxChars });
  renderVisionImageSection(lines, 'Structured Content And Data', images, summaryImages, ['structured_content', 'structuredContent', 'tables', 'charts', 'diagrams', 'documents', 'forms', 'receipts', 'maps', 'code', 'terminal', 'formulas', 'document_structure', 'documentStructure', 'data_entities', 'dataEntities', 'metrics'], 'No structured content or data details were returned.', { limit: sectionLimit(12), itemMaxChars });
  renderVisionImageSection(lines, 'Domain-Specific Details', images, summaryImages, ['domain_specific_details', 'domainSpecificDetails', 'specialized_observations', 'specializedObservations', 'relevant_details', 'relevantDetails', 'ui_elements', 'uiElements', 'controls'], 'No domain-specific details were returned.', { limit: sectionLimit(10), itemMaxChars });
  renderVisionImageSection(lines, 'Observed Facts', images, summaryImages, ['observed_facts', 'observedFacts', 'facts'], 'No structured observed facts were returned.', { required: true, includeImageMeta: true, limit: sectionLimit(12), emptyFallback: 'No supported images were analyzed.', itemMaxChars });
  renderVisionImageSection(lines, 'Uncertainties And Limits', images, summaryImages, ['uncertainties', 'uncertainty', 'uncertainty_notes', 'uncertaintyNotes', 'unknowns'], 'No structured uncertainty notes were returned.', { limit: sectionLimit(8), itemMaxChars });
  renderVisionImageSection(lines, 'Scoped Negative Evidence', images, summaryImages, ['negative_evidence', 'negativeEvidence', 'not_visible', 'notVisible'], 'No scoped negative evidence was returned.', { limit: sectionLimit(8), itemMaxChars });
  renderVisionImageSection(lines, 'Inferences And Context', images, summaryImages, ['inferences', 'inference'], 'No structured inferences were returned.', { required: true, limit: sectionLimit(6), emptyFallback: 'No image inferences are available.', scopeCitationReferences: true, itemMaxChars });
  renderVisionImageSection(lines, 'Guardrails For Text-Only Model', images, summaryImages, ['guardrails', 'critique_guardrails', 'critiqueGuardrails'], 'No image-specific guardrails were returned.', { limit: sectionLimit(6), scopeCitationReferences: true, itemMaxChars });
  lines.push(`</${identity.tag}>`);
  const rendered = lines.join('\n');
  return Number.isFinite(resolvedMaxChars) ? truncateText(rendered, resolvedMaxChars) : rendered;
}

function safeImagePreflightSessionSegment(value) {
  const text = String(value || '').trim().replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 96);
  return text || 'stronk-pi';
}

function imagePreflightSessionContext(event = {}, ctx = {}, options = {}, config = {}) {
  const env = options.env ?? process.env;
  const stateRoot = config.stateRoot || stronkStateRoot(env);
  const sessionsRoot = join(stateRoot, 'agent', 'sessions');
  const managerSessionId = sessionManagerString(ctx, 'getSessionId');
  const managerSessionFile = sessionManagerString(ctx, 'getSessionFile');
  const rawSessionId = firstString(
    managerSessionId,
    event.sessionId,
    event.session_id,
    nestedString(event, 'session', 'id'),
    ctx.sessionId,
    ctx.session_id,
    nestedString(ctx, 'session', 'id'),
    env.PI_SESSION_ID,
    env.STRONK_PI_SWARM_RUN_ID,
  );
  const turnId = firstString(
    event.turnId,
    event.turn_id,
    ctx.turnId,
    ctx.turn_id,
    env.PI_TURN_ID,
    env.STRONK_PI_TURN_ID,
  );
  const transcriptPath = firstString(
    managerSessionFile,
    event.transcriptPath,
    event.transcript_path,
    nestedString(event, 'session', 'transcriptPath'),
    ctx.transcriptPath,
    ctx.transcript_path,
    nestedString(ctx, 'session', 'transcriptPath'),
    env.PI_TRANSCRIPT_PATH,
    env.STRONK_PI_TRANSCRIPT_PATH,
  );
  const transcriptSessionId = transcriptPath && isAbsolute(transcriptPath)
    ? basename(transcriptPath).replace(/\.[^.]+$/, '')
    : '';
  const sessionId = rawSessionId || transcriptSessionId || 'stronk-pi';
  let artifactRoot = sessionsRoot;
  if (transcriptPath && isAbsolute(transcriptPath)) {
    const transcriptDir = resolve(dirname(transcriptPath));
    if (pathIsWithinRoot(resolve(sessionsRoot), transcriptDir)) artifactRoot = transcriptDir;
  }
  return {
    sessionId,
    turnId,
    sessionSegment: safeImagePreflightSessionSegment(sessionId),
    artifactRoot,
    hasSessionBinding: Boolean(rawSessionId || transcriptPath),
  };
}

function imagePreflightArtifactDirectory(context = {}) {
  const root = resolve(context.artifactRoot || join(stronkStateRoot(), 'agent', 'sessions'));
  const base = resolve(root, 'image-preflight');
  const directory = resolve(base, safeImagePreflightSessionSegment(context.sessionSegment || context.sessionId));
  return pathIsWithinRoot(base, directory) ? directory : join(base, 'stronk-pi');
}

function imagePreflightArtifactInputGroups(images = [], summaryImages = [], groupSize = IMAGE_PREFLIGHT_ARTIFACT_IMAGES_PER_HANDLE) {
  const safeGroupSize = Math.max(1, Math.trunc(Number(groupSize) || IMAGE_PREFLIGHT_ARTIFACT_IMAGES_PER_HANDLE));
  const entries = images.map((image) => {
    const summary = summaryForImage(image, images, summaryImages);
    return {
      image,
      summary: summary && typeof summary === 'object'
        ? { ...summary, label: firstString(summary.label, image.label) || image.label }
        : { label: image.label },
    };
  });
  const groups = [];
  for (let index = 0; index < entries.length; index += safeGroupSize) {
    const groupEntries = entries.slice(index, index + safeGroupSize);
    const groupImages = groupEntries.map((entry) => entry.image);
    groups.push({
      images: groupImages,
      summaryImages: groupEntries.map((entry) => entry.summary),
      imageLabels: groupImages.map((image) => firstString(image.label)).filter(Boolean),
      imageRange: imagePreflightImageRange(groupImages),
    });
  }
  return groups;
}

function renderImagePreflightArtifactGroupHeader(group = {}, groups = []) {
  const siblings = groups
    .filter((candidate) => candidate.handle !== group.handle)
    .map((candidate) => `${candidate.imageRange} handle=${candidate.handle}`)
    .join('; ') || 'none';
  return [
    `Image Preflight Artifact Group ${group.groupIndex} of ${group.groupCount}`,
    `Images in this handle: ${(group.imageLabels || []).join(', ') || 'none'}`,
    `Sibling groups: ${siblings}`,
    'If evidence cites labels outside this handle, read that sibling handle before relying on it.',
  ].join('\n');
}

function publicImagePreflightArtifactGroup(group = {}) {
  return {
    handle: group.handle,
    sessionId: group.sessionId,
    turnId: group.turnId,
    groupIndex: group.groupIndex,
    groupCount: group.groupCount,
    imageRange: group.imageRange,
    imageLabels: group.imageLabels,
    charLength: group.charLength,
    truncated: group.truncated,
  };
}

function writeImagePreflightArtifact({ config, images, summaryImages, skipped = [], failure }, event = {}, ctx = {}, options = {}) {
  const writtenPaths = [];
  try {
    const context = imagePreflightSessionContext(event, ctx, options, config);
    if (!context.hasSessionBinding) return undefined;
    const directory = imagePreflightArtifactDirectory(context);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const groupInputs = imagePreflightArtifactInputGroups(images, summaryImages);
    if (groupInputs.length === 0) return undefined;
    const directoryRoot = resolve(directory);
    const groups = groupInputs.map((groupInput, index) => ({
      ...groupInput,
      handle: `image-preflight-${randomUUID()}`,
      sessionId: context.sessionId,
      turnId: context.turnId,
      groupIndex: index + 1,
      groupCount: groupInputs.length,
    }));
    const renderedGroups = groups.map((group) => {
      const filePath = resolve(directory, `${group.handle}.txt`);
      if (!pathIsWithinRoot(directoryRoot, filePath)) throw new Error('image preflight artifact path escaped session directory');
      const body = renderVisionContext({
        config,
        images: group.images,
        summaryImages: group.summaryImages,
        skipped,
        failure,
        full: true,
        maxChars: undefined,
      });
      const text = `${renderImagePreflightArtifactGroupHeader(group, groups)}\n\n${body}`;
      return {
        ...group,
        filePath,
        text,
        charLength: text.length,
        truncated: text.includes('[truncated by Stronk Pi]'),
      };
    });
    for (const group of renderedGroups) {
      writeFileSync(group.filePath, group.text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      writtenPaths.push(group.filePath);
    }
    const publicGroups = renderedGroups.map(publicImagePreflightArtifactGroup);
    for (const group of renderedGroups) {
      imagePreflightArtifactIndex.set(group.handle, {
        ...publicImagePreflightArtifactGroup(group),
        path: group.filePath,
      });
    }
    return {
      handle: publicGroups[0]?.handle,
      sessionId: context.sessionId,
      turnId: context.turnId,
      batchSize: IMAGE_PREFLIGHT_ARTIFACT_IMAGES_PER_HANDLE,
      groups: publicGroups,
      charLength: publicGroups.reduce((total, group) => total + (Number(group.charLength) || 0), 0),
      truncated: publicGroups.some((group) => group.truncated),
    };
  } catch {
    for (const filePath of writtenPaths) {
      try {
        unlinkSync(filePath);
      } catch {
        // Best-effort cleanup; a stale temp artifact is safer than exposing raw image data.
      }
    }
    return undefined;
  }
}

function normalizeImagePreflightReadParams(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error(`${IMAGE_PREFLIGHT_READ_TOOL} input must be an object`);
  }
  const handle = typeof params.handle === 'string' ? params.handle.trim() : '';
  if (!IMAGE_PREFLIGHT_ARTIFACT_HANDLE_PATTERN.test(handle)) {
    throw new Error(`${IMAGE_PREFLIGHT_READ_TOOL} requires a valid image preflight handle`);
  }
  const offset = Math.max(0, Math.trunc(Number(params.offset) || 0));
  const maxChars = clampedInteger(
    firstPresent(params.max_chars, params.maxChars),
    DEFAULT_IMAGE_PREFLIGHT_ARTIFACT_READ_CHARS,
    1024,
    MAX_IMAGE_PREFLIGHT_ARTIFACT_READ_CHARS,
  );
  return { handle, offset, maxChars };
}

function resolveImagePreflightArtifact(handle, ctx = {}, options = {}) {
  const config = resolveVisionPreflightConfig(options);
  const context = imagePreflightSessionContext({}, ctx, options, config);
  if (!context.hasSessionBinding) {
    throw new Error('image preflight artifact not found for this session');
  }
  const indexed = imagePreflightArtifactIndex.get(handle);
  if (indexed?.path) {
    if (indexed.sessionId && indexed.sessionId !== context.sessionId) {
      throw new Error('image preflight artifact not found for this session');
    }
    return { path: indexed.path, metadata: indexed };
  }
  const directory = imagePreflightArtifactDirectory(context);
  const filePath = resolve(directory, `${handle}.txt`);
  if (!pathIsWithinRoot(resolve(directory), filePath)) {
    throw new Error('image preflight artifact handle is outside the current session');
  }
  return { path: filePath, metadata: undefined };
}

function executeImagePreflightRead(params = {}, _signal, ctx = {}, options = {}) {
  const normalized = normalizeImagePreflightReadParams(params);
  let text;
  let metadata;
  try {
    const artifact = resolveImagePreflightArtifact(normalized.handle, ctx, options);
    metadata = artifact.metadata;
    text = readFileSync(artifact.path, 'utf8');
  } catch {
    return toolResult(
      'Image preflight artifact not found for this session.',
      { tool: IMAGE_PREFLIGHT_READ_TOOL, handle: normalized.handle, found: false },
    );
  }
  const totalChars = text.length;
  const truncated = text.includes('[truncated by Stronk Pi]');
  const start = Math.min(normalized.offset, totalChars);
  const end = Math.min(totalChars, start + normalized.maxChars);
  const chunk = text.slice(start, end);
  const nextOffset = end < totalChars ? end : undefined;
  const more = nextOffset === undefined ? '' : `\n\n[Call ${IMAGE_PREFLIGHT_READ_TOOL} with handle=${normalized.handle} and offset=${nextOffset} for more.]`;
  return toolResult(
    `Image Preflight Analysis Artifact\nHandle: ${normalized.handle}\nCharacters: ${start}-${end} of ${totalChars}\nArtifact capped: ${truncated ? 'yes' : 'no'}\n\n${chunk}${more}`,
    {
      tool: IMAGE_PREFLIGHT_READ_TOOL,
      handle: normalized.handle,
      found: true,
      offset: start,
      returnedChars: chunk.length,
      totalChars,
      truncated,
      nextOffset,
      groupIndex: metadata?.groupIndex,
      groupCount: metadata?.groupCount,
      imageRange: metadata?.imageRange,
      imageLabels: metadata?.imageLabels,
    },
  );
}

function rewriteAnalyzedImageReferences(text, imagePreflight = {}) {
  if (typeof text !== 'string' || !text) return text;
  if (imagePreflight.block) return text;
  const images = imagePreflight.collected?.images || [];
  const skipped = imagePreflight.collected?.skipped || [];
  if (!Array.isArray(images) && !Array.isArray(skipped)) return text;
  const entries = [];
  for (const image of images) {
    entries.push({
      image,
      replacement: imageReferenceReplacement(image, imagePreflight.failure ? 'failed' : 'analyzed'),
    });
  }
  for (const item of skipped) {
    entries.push({
      image: item,
      replacement: imageReferenceReplacement(item, 'skipped'),
    });
  }
  return rewriteImageReferenceAliases(text, entries);
}

function shouldSkipImagePreflight(event = {}) {
  const text = typeof event.text === 'string' ? event.text : '';
  const source = firstString(
    event.source,
    event.origin,
    event.inputSource,
    event.input_source,
    nestedString(event, 'metadata', 'source'),
    nestedString(event, 'metadata', 'origin'),
  );
  if (source && /extension|preflight|stronk-pi-image-vision-preflight/i.test(source)) return true;
  if (event.stronkPiImagePreflight || event.imageVisionPreflight) return true;
  if (event.metadata?.stronkPiImagePreflight || event.metadata?.imageVisionPreflight) return true;
  return text.includes(`<${IMAGE_PREFLIGHT_CONTEXT_TAG}>`) || text.includes(IMAGE_PREFLIGHT_MARKER);
}

async function buildImageVisionPreflight(event = {}, ctx = {}, options = {}) {
  if (shouldSkipImagePreflight(event)) return { contextBlock: '', stripImages: false, skipped: true };
  if (modelSupportsImageInput(event, ctx, options)) return { contextBlock: '', stripImages: false, nativeImages: true };
  const config = resolveVisionPreflightConfig(options);
  if (!config.enabled) return { contextBlock: '', stripImages: false, skipped: true };
  const collected = collectImageInputs(event, ctx, config, options);
  if (collected.images.length === 0 && collected.skipped.length === 0) return { contextBlock: '', stripImages: false };

  if (collected.images.length === 0) {
    emitImagePreflightStatus(options, { phase: 'skipped', imageCount: 0, skippedCount: collected.skipped.length });
    return {
      contextBlock: renderVisionContext({ config, images: [], summaryImages: [], skipped: collected.skipped }),
      stripImages: collected.rawImageCount > 0,
      collected,
    };
  }

  try {
    emitImagePreflightStatus(options, {
      phase: 'analyzing',
      imageCount: collected.images.length,
      skippedCount: collected.skipped.length,
      model: config.model,
    });
    const attempt = await runImageVisionPreflightRequest(
      collected.images,
      config,
      event,
      ctx,
      collected,
      options,
    ).catch((error) => retryImageVisionPreflightAfterTimeout(error, config, event, ctx, collected, options));
    const summaryImages = attempt.summaryImages;
    const artifact = writeImagePreflightArtifact({
      config,
      images: collected.images,
      summaryImages,
      skipped: collected.skipped,
    }, event, ctx, options);
    emitImagePreflightStatus(options, {
      phase: 'complete',
      imageCount: collected.images.length,
      analyzedCount: summaryImages.length,
      skippedCount: collected.skipped.length,
      model: config.model,
    });
    return {
      contextBlock: renderVisionContext({ config, images: collected.images, summaryImages, skipped: collected.skipped, artifact }),
      stripImages: collected.rawImageCount > 0,
      collected,
      request: attempt.request,
      retryRequests: attempt.requests,
      retriedAfterTimeout: attempt.retriedAfterTimeout,
      artifact,
    };
  } catch (error) {
    const rawReason = error?.message ?? String(error);
    const reason = safeImagePreflightFailureReason(rawReason);
    emitImagePreflightStatus(options, {
      phase: 'failed',
      reason: rawReason,
      failureMode: config.failureMode,
      imageCount: collected.images.length,
      skippedCount: collected.skipped.length,
      model: config.model,
    });
    if (config.failureMode === 'block') {
      return { block: true, reason, stripImages: collected.rawImageCount > 0, collected };
    }
    return {
      contextBlock: renderVisionContext({
        config,
        images: collected.images,
        summaryImages: [],
        skipped: collected.skipped,
        failure: reason,
      }),
      stripImages: collected.rawImageCount > 0,
      collected,
      failure: reason,
    };
  }
}

function normalizeImageReadPaths(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('image_read paths must be an array of strings');
  const paths = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) throw new Error('image_read paths must contain only non-empty strings');
    paths.push(item);
  }
  return paths;
}

function normalizeImageReadParams(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('image_read input must be an object');
  }
  const paths = normalizeImageReadPaths(params.paths);
  const directory = typeof params.directory === 'string' && params.directory.trim() ? params.directory : undefined;
  if (paths.length === 0 && !directory) throw new Error('image_read requires paths or directory');
  if (paths.length > 1) {
    throw new Error(`image_read reads exactly one image per call; received ${countLabel(paths.length, 'explicit path')}. Call image_read once per image with one exact path.`);
  }
  if (paths.length > 0 && directory) {
    throw new Error('image_read reads exactly one image per call; pass either one exact path or one directory scan, not both.');
  }
  return {
    paths,
    directory,
    recursive: params.recursive === true,
    maxImages: 1,
    question: typeof params.question === 'string' ? truncateText(params.question, 2000) : '',
  };
}

function makeImageReadScanSkip(origin, reason, displayName) {
  return makeImageSkip(origin, reason, {
    label: origin,
    displayName: displayName || origin,
  });
}

function readBoundedImageReadDirectoryEntries(dir, limit) {
  if (limit <= 0) return { entries: [], truncated: true };
  let handle;
  try {
    handle = opendirSync(dir);
  } catch {
    return undefined;
  }
  const entries = [];
  let truncated = false;
  try {
    while (entries.length < limit) {
      const entry = handle.readSync();
      if (!entry) break;
      entries.push(entry);
    }
    truncated = Boolean(handle.readSync());
  } catch {
    return undefined;
  } finally {
    try {
      handle.closeSync();
    } catch {
      // Directory scan cleanup is best-effort.
    }
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return { entries, truncated };
}

function scanImageReadDirectory(rawDirectory, params = {}, ctx = {}, env = process.env, options = {}) {
  const cwd = resolve(firstString(ctx.cwd) || process.cwd());
  const originalPath = cleanPathCandidate(rawDirectory);
  const path = resolveImagePathCandidate(rawDirectory, cwd, env);
  const enforceAllowedRoots = options.enforceAllowedRoots !== false;
  if (!path) return { candidates: [], skipped: [makeImageSkip('directory', 'invalid image directory', { originalPath, displayName: originalPath || 'directory' })] };

  let linkStats;
  try {
    linkStats = lstatSync(path);
  } catch {
    return { candidates: [], skipped: [makeImageSkip('directory', 'image directory does not exist', { path, originalPath, displayName: basename(originalPath || path) || 'directory' })] };
  }
  if (linkStats.isSymbolicLink()) {
    return { candidates: [], skipped: [makeImageSkip('directory', 'symlink directory root skipped', { originalPath, displayName: basename(originalPath || path) || 'directory' })] };
  }
  if (imageCandidateHasHiddenSegment(path, cwd)) {
    return { candidates: [], skipped: [makeImageSkip('directory', 'hidden directory root skipped', { originalPath, displayName: basename(originalPath || path) || 'directory' })] };
  }

  let realPath;
  try {
    realPath = realpathSync(path);
  } catch {
    return { candidates: [], skipped: [makeImageSkip('directory', 'image directory does not exist', { path, originalPath, displayName: basename(originalPath || path) || 'directory' })] };
  }
  if (pathHasProtectedSegment(realPath)) {
    return { candidates: [], skipped: [makeImageSkip('directory', 'protected local path denied', { path: realPath, originalPath, displayName: basename(realPath) || 'directory' })] };
  }
  if (imageCandidateHasHiddenSegment(realPath, cwd)) {
    return { candidates: [], skipped: [makeImageSkip('directory', 'hidden directory root skipped', { path: realPath, originalPath, displayName: basename(realPath) || 'directory' })] };
  }
  if (enforceAllowedRoots && !imagePathAllowed(realPath, cwd, env)) {
    return { candidates: [], skipped: [makeImageSkip('directory', 'path outside allowed image roots', { path: realPath, originalPath, displayName: basename(realPath) || 'directory' })] };
  }
  let rootStats;
  try {
    rootStats = statSync(realPath);
  } catch {
    return { candidates: [], skipped: [makeImageSkip('directory', 'image directory is not readable', { path: realPath, originalPath, displayName: basename(realPath) || 'directory' })] };
  }
  if (!rootStats.isDirectory()) {
    return { candidates: [], skipped: [makeImageSkip('directory', 'image directory is not a directory', { path: realPath, originalPath, displayName: basename(realPath) || 'directory' })] };
  }

  const recursive = params.recursive === true;
  const candidates = [];
  const skipped = [];
  const queue = [{ dir: realPath }];
  const visited = new Set([realPath]);
  let entriesSeen = 0;
  let dirsSeen = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    dirsSeen += 1;
    if (dirsSeen > MAX_IMAGE_READ_DIRECTORY_DIRS) {
      skipped.push(makeImageReadScanSkip('directory', `directory scan directory limit reached (${MAX_IMAGE_READ_DIRECTORY_DIRS})`, basename(realPath) || 'directory'));
      break;
    }

    const remainingEntries = MAX_IMAGE_READ_DIRECTORY_ENTRIES - entriesSeen;
    const scan = readBoundedImageReadDirectoryEntries(current.dir, remainingEntries);
    if (!scan) {
      skipped.push(makeImageReadScanSkip('directory', 'image directory is not readable', basename(current.dir) || 'directory'));
      continue;
    }
    const { entries } = scan;
    entriesSeen += entries.length;

    for (const entry of entries) {
      const child = join(current.dir, entry.name);
      const displayName = entry.name;
      if (entry.name.startsWith('.')) {
        if (entry.isDirectory() || imageMimeSupported(mimeFromPath(entry.name))) {
          skipped.push(makeImageReadScanSkip('directory', 'hidden path skipped', displayName));
        }
        continue;
      }
      if (pathHasProtectedSegment(child)) {
        skipped.push(makeImageReadScanSkip('directory', 'protected local path denied', displayName));
        continue;
      }
      if (entry.isSymbolicLink()) {
        skipped.push(makeImageReadScanSkip('directory', 'symlink skipped during directory scan', displayName));
        continue;
      }
      if (entry.isDirectory()) {
        if (!recursive) continue;
        let childReal;
        try {
          childReal = realpathSync(child);
        } catch {
          skipped.push(makeImageReadScanSkip('directory', 'image directory is not readable', displayName));
          continue;
        }
        if (!pathIsInside(realPath, childReal) || (enforceAllowedRoots && !imagePathAllowed(childReal, cwd, env))) {
          skipped.push(makeImageReadScanSkip('directory', enforceAllowedRoots ? 'directory escapes allowed image root' : 'directory escapes scan root', displayName));
          continue;
        }
        if (pathHasProtectedSegment(childReal)) {
          skipped.push(makeImageReadScanSkip('directory', 'protected local path denied', displayName));
          continue;
        }
        if (imageCandidateHasHiddenSegment(childReal, realPath)) {
          skipped.push(makeImageReadScanSkip('directory', 'hidden path skipped', displayName));
          continue;
        }
        if (visited.has(childReal)) continue;
        visited.add(childReal);
        queue.push({ dir: childReal });
        continue;
      }
      if (entry.isFile() && hasSupportedImageExtension(entry.name)) candidates.push(child);
    }
    if (scan.truncated) {
      skipped.push(makeImageReadScanSkip('directory', `directory scan entry limit reached (${MAX_IMAGE_READ_DIRECTORY_ENTRIES})`, basename(realPath) || 'directory'));
      return { candidates, skipped };
    }
  }
  return { candidates, skipped };
}

function imageReadDirectoryMultipleRejection(scan = {}) {
  const candidates = Array.isArray(scan.candidates) ? scan.candidates : [];
  return {
    reason: 'directory scan resolved multiple images',
    message: `directory scan resolved ${countLabel(candidates.length, 'image candidate')}. Call image_read with one exact path or a narrower directory/input that resolves to one image.`,
    mode: 'directory',
    candidateCount: candidates.length,
    candidateNames: candidates
      .slice(0, MAX_IMAGE_READ_SKIPPED_DETAILS)
      .map((candidate) => (
        typeof candidate === 'string'
          ? basename(cleanPathCandidate(candidate)) || 'image'
          : safeImageDisplayName(candidate, candidate?.label || 'image')
      )),
    candidateNamesTruncated: candidates.length > MAX_IMAGE_READ_SKIPPED_DETAILS,
  };
}

function imageReadMultipleImagesRejection(imageCount) {
  return {
    reason: 'multiple images resolved',
    message: `${IMAGE_READ_TOOL} reads exactly one image per call; input resolved to ${countLabel(imageCount, 'image')}. Call image_read once per image with one exact path.`,
    mode: 'resolved',
    imageCount,
  };
}

function collectImageReadInputs(params = {}, ctx = {}, config = resolveVisionPreflightConfig(), options = {}) {
  const env = options.env ?? process.env;
  const enforceAllowedRoots = imageReadShouldEnforceAllowedRoots(ctx, env);
  const images = [];
  const skipped = [];
  const seen = new Map();
  const addResult = (result) => {
    if (result.image) {
      const key = result.image.path ? `path:${result.image.path}` : `data:${result.image.mediaType}:${result.image.byteLength}:${result.image.data.slice(0, 32)}`;
      const existing = seen.get(key);
      if (existing) {
        mergeImagePathAliases(existing, result.image);
        return;
      }
      result.image.label = `image-${images.length + 1}`;
      mergeImagePathAliases(result.image, result.image);
      seen.set(key, result.image);
      images.push(result.image);
    } else if (result.skip) {
      skipped.push(result.skip);
    }
  };

  for (const [index, imagePath] of params.paths.entries()) {
    addResult(normalizePathImage(`paths[${index}]`, imagePath, config, index + 1, ctx, env, { enforceAllowedRoots }));
  }

  if (params.directory) {
    const scan = scanImageReadDirectory(params.directory, params, ctx, env, { enforceAllowedRoots });
    skipped.push(...scan.skipped);
    const pathOffset = params.paths.length;
    for (const [index, imagePath] of scan.candidates.entries()) {
      addResult(normalizePathImage(`directory[${index}]`, imagePath, config, pathOffset + index + 1, ctx, env, { enforceAllowedRoots }));
    }
  }

  return {
    images,
    skipped,
    discoveredCount: params.paths.length + (params.directory ? 1 : 0),
  };
}

function imageReadDirectoryAliases(rawDirectory, ctx = {}, env = process.env) {
  const aliases = [];
  const originalPath = cleanPathCandidate(rawDirectory);
  if (originalPath) aliases.push(originalPath);
  const cwd = resolve(firstString(ctx.cwd) || process.cwd());
  const resolvedPath = resolveImagePathCandidate(rawDirectory, cwd, env);
  if (resolvedPath) {
    aliases.push(resolvedPath);
    try {
      aliases.push(realpathSync(resolvedPath));
    } catch {
      // Best-effort path alias collection for redaction only.
    }
  }
  return [...new Set(aliases.filter(Boolean))];
}

function sanitizeImageReadQuestion(question, params = {}, collected = { images: [], skipped: [] }, ctx = {}, env = process.env) {
  const fallback = 'Image Read requested local image inspection.';
  let text = typeof question === 'string' && question.trim() ? question.trim() : fallback;
  text = redactImageDataText(text);
  text = rewriteAnalyzedImageReferences(text, { collected });
  if (params.directory) {
    const directoryName = basename(cleanPathCandidate(params.directory)) || 'directory';
    text = rewriteImageReferenceAliases(text, [{
      image: { pathAliases: imageReadDirectoryAliases(params.directory, ctx, env), originalPath: params.directory },
      replacement: `[directory; ${directoryName}]`,
    }]);
  }
  text = redactLocalPathText(text);
  text = redactImageDataText(text);
  return truncateText(text, 2000);
}

function imageReadDetails(config, collected, summaryImages = [], failure) {
  return {
    tool: IMAGE_READ_TOOL,
    model: config.model,
    images: collected.images.map((image) => ({
      label: image.label,
      displayName: safeImageDisplayName(image, image.label),
      origin: image.origin,
      mediaType: image.mediaType,
      byteLength: image.byteLength,
    })),
    imageCount: collected.images.length,
    analyzedCount: failure ? summaryImages.length : collected.images.length,
    summaryCount: summaryImages.length,
    skippedCount: collected.skipped.length,
    skipped: collected.skipped.slice(0, MAX_IMAGE_READ_SKIPPED_DETAILS).map((item) => ({
      label: item.label || item.origin,
      displayName: safeImageDisplayName(item, item.label || item.origin || 'image'),
      origin: item.origin,
      reason: item.reason,
    })),
    skippedTruncated: collected.skipped.length > MAX_IMAGE_READ_SKIPPED_DETAILS,
    failure,
  };
}

function imageReadToolText(contextBlock, collected, summaryImages = [], failure) {
  const analyzed = failure ? summaryImages.length : collected.images.length;
  const skipped = collected.skipped.length > 0 ? `; skipped ${countLabel(collected.skipped.length, 'image')}` : '';
  const status = failure
    ? `Image Read failed with bounded reason: ${failure}${skipped}.`
    : `Image Read complete: analyzed ${countLabel(analyzed, 'image')}${skipped}.`;
  return truncateText(`${status}\n\n${contextBlock}`, MAX_IMAGE_READ_OUTPUT_CHARS);
}

function imageReadRejectionResult(config, rejection = {}, collected = { images: [], skipped: [] }) {
  const reason = rejection.reason || 'invalid image_read input';
  const message = truncateText(rejection.message || `${IMAGE_READ_TOOL} reads exactly one image per call.`, 1000);
  return {
    ...toolResult(
      `Image Read rejected: ${message}`,
      {
        ...imageReadDetails(config, collected, [], reason),
        rejected: true,
        rejection: {
          reason,
          mode: rejection.mode,
          candidateCount: rejection.candidateCount,
          candidateNames: rejection.candidateNames,
          candidateNamesTruncated: rejection.candidateNamesTruncated,
          imageCount: rejection.imageCount,
        },
      },
    ),
    isError: true,
  };
}

async function executeImageRead(params = {}, signal, ctx = {}, options = {}) {
  const config = resolveVisionPreflightConfig(options);
  let normalized;
  try {
    normalized = normalizeImageReadParams(params);
  } catch (error) {
    return imageReadRejectionResult(
      { ...config, maxImages: 1 },
      { reason: 'invalid image_read input', message: error?.message || 'image_read input is invalid', mode: 'input' },
      { images: [], skipped: [] },
    );
  }
  const toolConfig = { ...config, maxImages: 1 };

  if (modelSupportsImageInput({}, ctx, options)) {
    const modelRef = activeModelRef({}, ctx) || 'current model';
    return imageReadRejectionResult(
      toolConfig,
      {
        reason: 'native multimodal model',
        message: `image_read is only for text-only models. ${modelRef} supports native image input; use normal image handling instead.`,
        mode: 'model',
      },
      { images: [], skipped: [] },
    );
  }

  if (!toolConfig.enabled) {
    const text = 'Image Read unavailable: image_preflight is disabled.';
    return toolResult(text, imageReadDetails(toolConfig, { images: [], skipped: [] }, [], 'vision preflight unavailable'));
  }

  const collected = collectImageReadInputs(normalized, ctx, toolConfig, options);

  if (collected.images.length === 0) {
    const contextBlock = renderVisionContext({
      config: toolConfig,
      images: [],
      summaryImages: [],
      skipped: collected.skipped,
      source: IMAGE_READ_TOOL,
    });
    return toolResult(imageReadToolText(contextBlock, collected, []), imageReadDetails(toolConfig, collected, []));
  }

  if (collected.images.length > 1) {
    const rejection = normalized.directory
      ? imageReadDirectoryMultipleRejection({ candidates: collected.images })
      : imageReadMultipleImagesRejection(collected.images.length);
    return imageReadRejectionResult(toolConfig, rejection, collected);
  }

  try {
    const request = buildVisionRequest(
      collected.images,
      toolConfig,
      {
        text: sanitizeImageReadQuestion(normalized.question, normalized, collected, ctx, options.env ?? process.env),
        source: IMAGE_READ_TOOL,
      },
      ctx,
      collected,
    );
    const result = await withVisionTimeout(toolConfig.timeoutMs, signal || ctx.signal, (visionSignal) => {
      request.signal = visionSignal;
      return invokeVisionPreflight(request, ctx, options);
    });
    const summaryImages = sanitizeVisionSummaries(normalizeVisionSummary(result), collected);
    const contextBlock = renderVisionContext({
      config: toolConfig,
      images: collected.images,
      summaryImages,
      skipped: collected.skipped,
      source: IMAGE_READ_TOOL,
    });
    return toolResult(imageReadToolText(contextBlock, collected, summaryImages), imageReadDetails(toolConfig, collected, summaryImages));
  } catch (error) {
    const reason = safeImagePreflightFailureReason(error?.message ?? String(error));
    const contextBlock = renderVisionContext({
      config: toolConfig,
      images: collected.images,
      summaryImages: [],
      skipped: collected.skipped,
      failure: reason,
      source: IMAGE_READ_TOOL,
    });
    return toolResult(
      imageReadToolText(contextBlock, collected, [], reason),
      imageReadDetails(toolConfig, collected, [], reason),
    );
  }
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
  notifyUi(ctx, reason, 'warning');
}

function notifyUi(ctx, message, kind = 'info') {
  if (ctx?.hasUI && ctx.ui && typeof ctx.ui.notify === 'function' && typeof message === 'string' && message.trim()) {
    try {
      ctx.ui.notify(message, kind);
      return true;
    } catch {
      // UI notifications are advisory.
    }
  }
  return false;
}

const activeImagePreflightUi = new WeakMap();

function imagePreflightUiMessage(status = {}) {
  const imageCount = Number(status.imageCount ?? status.analyzedCount ?? 0);
  return `Analyzing ${countLabel(imageCount, 'image')} with vision preflight`;
}

function themeText(theme, key, text) {
  if (theme && typeof theme.fg === 'function') {
    try {
      return theme.fg(key, text);
    } catch {
      // Theme helpers are advisory.
    }
  }
  return text;
}

function createImagePreflightWidget(status = {}) {
  const message = imagePreflightUiMessage(status);
  return (tui, theme) => {
    let frameIndex = 0;
    let disposed = false;
    const renderLine = () => {
      const frame = IMAGE_PREFLIGHT_UI_FRAMES[frameIndex % IMAGE_PREFLIGHT_UI_FRAMES.length] || '';
      return `${themeText(theme, 'accent', frame)} ${themeText(theme, 'muted', message)}`;
    };
    const interval = setInterval(() => {
      if (disposed) return;
      frameIndex = (frameIndex + 1) % IMAGE_PREFLIGHT_UI_FRAMES.length;
      if (typeof tui?.requestRender === 'function') tui.requestRender();
    }, IMAGE_PREFLIGHT_UI_INTERVAL_MS);
    if (typeof interval?.unref === 'function') interval.unref();
    return {
      render: () => [renderLine()],
      invalidate: () => {},
      dispose: () => {
        disposed = true;
        clearInterval(interval);
      },
    };
  };
}

function startImagePreflightUi(ctx, status = {}) {
  const ui = ctx?.ui;
  if (!ctx?.hasUI || !ui || typeof ui !== 'object') return false;
  stopImagePreflightUi(ctx);
  const tuiMode = ctx.mode === 'tui' || ctx.mode === 'interactive';
  const message = imagePreflightUiMessage(status);
  const state = { status: false, widget: false };

  if (typeof ui.setStatus === 'function') {
    try {
      ui.setStatus(IMAGE_PREFLIGHT_UI_KEY, `image vision: ${message}`);
      state.status = true;
    } catch {
      // UI status is advisory.
    }
  }

  if (tuiMode && typeof ui.setWidget === 'function') {
    try {
      ui.setWidget(IMAGE_PREFLIGHT_UI_KEY, createImagePreflightWidget(status), { placement: 'belowEditor' });
      state.widget = true;
    } catch {
      // Widgets are advisory.
    }
  }

  if (state.status || state.widget) {
    activeImagePreflightUi.set(ui, state);
    return true;
  }
  return false;
}

function stopImagePreflightUi(ctx) {
  const ui = ctx?.ui;
  if (!ui || typeof ui !== 'object') return false;
  const state = activeImagePreflightUi.get(ui);
  if (!state) return false;
  if (state.widget && typeof ui.setWidget === 'function') {
    try {
      ui.setWidget(IMAGE_PREFLIGHT_UI_KEY, undefined);
    } catch {
      // UI cleanup is best-effort.
    }
  }
  if (state.status && typeof ui.setStatus === 'function') {
    try {
      ui.setStatus(IMAGE_PREFLIGHT_UI_KEY, undefined);
    } catch {
      // UI cleanup is best-effort.
    }
  }
  activeImagePreflightUi.delete(ui);
  return true;
}

function notifyImagePreflightStatus(ctx, status = {}) {
  const message = formatImagePreflightStatus(status);
  if (!message) return false;
  if (status.phase === 'analyzing') {
    startImagePreflightUi(ctx, status);
  } else if (status.phase === 'complete' || status.phase === 'failed' || status.phase === 'skipped') {
    stopImagePreflightUi(ctx);
  }
  return notifyUi(ctx, message, status.phase === 'failed' || status.phase === 'skipped' ? 'warning' : 'info');
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
  if (typeof event?.text !== 'string' && !Array.isArray(event?.images)) return undefined;
  const originalText = typeof event?.text === 'string' ? event.text : '';

  let skillContext = { blocks: [] };
  try {
    if (typeof event?.text === 'string') {
      skillContext = buildSkillInjectionContext(event.text, {
        cwd: firstString(event.cwd, ctx.cwd) || process.cwd(),
      });
    }
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

  const imagePreflight = await buildImageVisionPreflight(event, ctx, {
    onStatus: (status) => notifyImagePreflightStatus(ctx, status),
  });
  if (imagePreflight.block) {
    return { action: 'handled' };
  }
  if (imagePreflight.contextBlock) appendedContexts.push(imagePreflight.contextBlock);

  if (appendedContexts.length > 0 || imagePreflight.stripImages) {
    const baseText = rewriteAnalyzedImageReferences(originalText, imagePreflight);
    const text = appendedContexts.length > 0
      ? `${baseText}${baseText ? '\n\n' : ''}${appendedContexts.join('\n\n')}`
      : baseText;
    return {
      action: 'transform',
      text,
      images: imagePreflight.stripImages ? [] : event.images,
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

class UnavailableSubagentAdapter {
  constructor(reason) {
    this.reason = reason;
  }

  unavailable() {
    throw new Error(`stronk_subagent intercom adapter unavailable: ${this.reason}`);
  }

  async spawn() { this.unavailable(); }
  async wait() { this.unavailable(); }
  async status() { this.unavailable(); }
  async sendInput() { this.unavailable(); }
  async close() { this.unavailable(); }
  async interrupt() { this.unavailable(); }
  async revive() { this.unavailable(); }
}

function subagentAdapterForPi(pi) {
  if (facadeAdapterMode() !== 'intercom') return undefined;
  if (!pi.events) {
    return new UnavailableSubagentAdapter('pi.events is required; ensure pi-subagents and pi-intercom are loaded before the Stronk facade');
  }
  return new PiSubagentsBridgeAdapter({ events: pi.events });
}

function registerStronkTools(pi, state = { todos: [] }) {
  if (typeof pi.registerTool !== 'function') return;
  if (facadeEnabled()) {
    const adapter = subagentAdapterForPi(pi);
    const executeFacade = createSubagentFacade({
      ...(adapter ? { adapter } : {}),
      parentModelProvider: (execution) => activeModelRef({}, execution?.ctx || {}),
    });
    pi.registerTool({
      name: STRONK_SUBAGENT_TOOL,
      label: STRONK_SUBAGENT_TOOL,
      description: 'Run Stronk-managed Pi subagent lifecycle actions through a closed schema and private ledger.',
      promptSnippet: 'Run a guarded Stronk Pi subagent action',
      promptGuidelines: [
        'Use stronk_subagent for Stronk-owned subagent lifecycle actions.',
        'Spawned children use fresh context; skills are passed through prompt-time context, not user-supplied override fields.',
        'Raw upstream subagent calls, model/tool/skill overrides, worktrees, chains, and output-path hints are denied.',
        'Public results are path-clean: do not expect cwd, upstream temp paths, durable output paths, ledger paths, or debug artifact paths.',
        'Use wait_all for explicit current-run child IDs when coordinating batches; duplicate, invalid, unknown, or foreign child IDs are denied.',
        'Provider capacity failures expose failureClass=provider_capacity, retryable=true, and retryableCapacityChildIds; treat them as retry lifecycle state, not child findings.',
        'For provider capacity failures, wait for nextRetryAfterMs or for non-terminal batch children to drain, then retry with guarded revive; do not switch models or add fallback/provider/concurrency overrides.',
        'Use read_output with opaque childOutputHandle values for bounded sanitized chunks; handles are invalidated by close and close_all.',
        'Use close_all for explicit batch cleanup and inspect per-child close and cleanup failure arrays.',
        'Use long waits, respect terminal barriers before synthesis, send follow-up only to non-terminal children, and close children after terminal synthesis.',
        'Check roleRequested, roleUsed, aliasResolved, timedOut, recommendedNextAction, failedChildIds, cleanupFailedChildIds, and cleanupVerified before reporting lifecycle status.',
        'Recheck file-line citations from current files during synthesis instead of trusting stale child citations.',
      ],
      parameters: stronkSubagentSchema,
      execute: async (...args) => {
        const { params, ctx } = normalizeToolArgs(args);
        const result = await executeFacade(params, { ctx });
        return toolResult(result.text, result.details);
      },
    });
  }
  pi.registerTool({
    name: IMAGE_PREFLIGHT_READ_TOOL,
    label: 'Image Preflight Read',
    description: 'Read a session-scoped extended text artifact produced by prompt-time image vision preflight for text-only models.',
    promptSnippet: 'Read extended prompt-time image preflight analysis by handle',
    promptGuidelines: [
      'Use image_preflight_read only when a prompt-time image preflight block gives a handle and the bounded inline block omits needed image detail.',
      'Pass the exact handle from the preflight block; use offset only to continue a previous chunk.',
      'This tool returns sanitized text analysis, not raw image data.',
    ],
    parameters: imagePreflightReadSchema,
    execute: async (...args) => {
      const { params, signal, ctx } = normalizeToolArgs(args);
      return executeImagePreflightRead(params, signal, ctx);
    },
  });
  pi.registerTool({
    name: IMAGE_READ_TOOL,
    label: 'Image Read',
    description: 'Read exactly one local image file for text-only models by routing it through the configured vision preflight model. Native multimodal models should use normal image handling.',
    promptSnippet: 'Read one local image with the configured vision preflight model',
    promptGuidelines: [
      'Use image_read when a text-only model discovers local image files after the prompt starts.',
      'Call image_read once per image; pass one exact path when possible.',
      'Use directory only when one bounded folder scan is expected to resolve exactly one image.',
      'Never use image_read for native multimodal models; use normal image handling instead.',
    ],
    parameters: imageReadSchema,
    execute: async (...args) => {
      const { params, signal, ctx } = normalizeToolArgs(args);
      return executeImageRead(params, signal, ctx);
    },
  });
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
  if (toolName === 'subagent') {
    return block(
      'raw subagent tool denied; use stronk_subagent with spawn, wait_all/status, read_output, send_input, revive, interrupt, close, or close_all',
    );
  }
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
  if (event?.suppressSessionResumeHint === true) return undefined;
  if (!shouldShowSessionResumeHint(ctx)) return undefined;

  const sessionId = sessionManagerString(ctx, 'getSessionId');
  if (!sessionId || !RESUME_HINT_SESSION_ID_PATTERN.test(sessionId)) return undefined;

  const sessionFile = sessionManagerString(ctx, 'getSessionFile');
  if (!hasReadableSessionFile(sessionFile)) return undefined;

  return `To continue this session, run stronkpi --session ${sessionId}`;
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
  parseTomlSections,
  resolveVisionPreflightConfig,
  resolveVisionProviderConfig,
  activeModelRef,
  modelSupportsImageInput,
  extractImagePathCandidates,
  collectImageInputs,
  buildVisionRequest,
  buildOpenAIVisionPayload,
  invokeOpenAICompatibleVisionPreflight,
  normalizeVisionSummary,
  safeImagePreflightFailureReason,
  formatImagePreflightStatus,
  createImagePreflightWidget,
  startImagePreflightUi,
  stopImagePreflightUi,
  notifyImagePreflightStatus,
  renderVisionContext,
  imageVisionOutputTokens,
  imagePreflightSessionContext,
  writeImagePreflightArtifact,
  normalizeImagePreflightReadParams,
  executeImagePreflightRead,
  rewriteAnalyzedImageReferences,
  buildImageVisionPreflight,
  normalizeImageReadParams,
  scanImageReadDirectory,
  collectImageReadInputs,
  executeImageRead,
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
