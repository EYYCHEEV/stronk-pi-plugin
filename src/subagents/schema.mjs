const ACTIONS = new Set(['spawn', 'list', 'wait', 'wait_all', 'read_output', 'status', 'send_input', 'interrupt', 'close', 'close_all', 'revive']);
const TERMINAL_ACTIONS = new Set(['wait', 'status', 'send_input', 'interrupt', 'close', 'revive']);
export const MAX_CHILDREN = 6;

export const DENIED_OVERRIDE_KEYS = new Set([
  'apiKey',
  'async',
  'background',
  'chain',
  'chainDir',
  'chainName',
  'cwd',
  'extensions',
  'fallbackModels',
  'includeRaw',
  'model',
  'packages',
  'provider',
  'sessionDir',
  'share',
  'skill',
  'skills',
  'systemPrompt',
  'thinking',
  'unredacted',
  'tools',
  'worktree',
  'worktreeSetupHook',
  'worktreeSetupHookTimeoutMs',
]);
const CONCURRENCY_KEYS = new Set(['concurrency', 'maxConcurrency']);
const OUTPUT_HINT_KEYS = new Set(['output', 'outputMode']);
const COMMON_KEYS = new Set(['action']);
const SPAWN_KEYS = new Set(['action', 'agent', 'role', 'task', 'timeoutMs']);
const TARGET_KEYS = new Set(['action', 'childId', 'child_id', 'target', 'timeoutMs']);
const SEND_INPUT_KEYS = new Set(['action', 'childId', 'child_id', 'target', 'message', 'timeoutMs']);
const REVIVE_KEYS = new Set(['action', 'childId', 'child_id', 'target', 'task', 'message', 'timeoutMs']);
const LIST_KEYS = new Set(['action', 'timeoutMs']);
const BATCH_KEYS = new Set(['action', 'childIds', 'timeoutMs']);
const READ_OUTPUT_KEYS = new Set(['action', 'outputHandle', 'offset', 'maxChars']);

export class FacadeSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FacadeSchemaError';
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FacadeSchemaError(`${label} must be an object`);
  }
}

function stringValue(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new FacadeSchemaError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  return stringValue(value, label);
}

function reviveTask(payload) {
  const task = optionalString(payload.task, 'task');
  const message = optionalString(payload.message, 'message');
  if (task && message && task !== message) {
    throw new FacadeSchemaError('stronk_subagent revive accepts task or message, not both');
  }
  return task ?? message;
}

function optionalTimeout(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 3600000) {
    throw new FacadeSchemaError('timeoutMs must be an integer from 1 to 3600000');
  }
  return value;
}

function walkDenied(value, path = []) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkDenied(item, [...path, String(index)]));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (DENIED_OVERRIDE_KEYS.has(key) || CONCURRENCY_KEYS.has(key) || OUTPUT_HINT_KEYS.has(key)) {
      throw new FacadeSchemaError(`stronk_subagent override denied: ${[...path, key].join('.')}`);
    }
    if (key === 'context' && item !== undefined && item !== null && item !== '' && item !== 'fresh') {
      throw new FacadeSchemaError('stronk_subagent context must be fresh');
    }
    walkDenied(item, [...path, key]);
  }
}

function assertKnownKeys(payload, allowed) {
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw new FacadeSchemaError(`stronk_subagent unknown property denied: ${key}`);
    }
  }
}

function childTarget(payload) {
  return stringValue(payload.childId ?? payload.child_id ?? payload.target, 'childId');
}

function assertChildIdShape(childId) {
  if (!/^sp-child-[A-Za-z0-9._-]+$/.test(childId)) {
    throw new FacadeSchemaError(`stronk_subagent childId invalid: ${childId}`);
  }
}

function childTargets(payload) {
  if (!Array.isArray(payload.childIds)) {
    throw new FacadeSchemaError('childIds must be an array');
  }
  if (payload.childIds.length < 1) {
    throw new FacadeSchemaError('childIds must include at least one childId');
  }
  if (payload.childIds.length > MAX_CHILDREN) {
    throw new FacadeSchemaError(`childIds exceeds max children: ${payload.childIds.length}>${MAX_CHILDREN}`);
  }
  const values = payload.childIds.map((value, index) => stringValue(value, `childIds.${index}`));
  for (const value of values) assertChildIdShape(value);
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      throw new FacadeSchemaError(`stronk_subagent duplicate childId denied: ${value}`);
    }
    seen.add(value);
  }
  return values;
}

function outputHandle(payload) {
  const handle = stringValue(payload.outputHandle, 'outputHandle');
  if (!/^subagent-output-[a-f0-9-]{36}$/.test(handle)) {
    throw new FacadeSchemaError('outputHandle invalid');
  }
  return handle;
}

function optionalOffset(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new FacadeSchemaError('offset must be a non-negative integer');
  }
  return value;
}

function optionalMaxChars(value) {
  if (value === undefined || value === null || value === '') return 6000;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 24000) {
    throw new FacadeSchemaError('maxChars must be an integer from 1 to 24000');
  }
  return value;
}

export function normalizeFacadePayload(payload) {
  assertPlainObject(payload, 'stronk_subagent payload');
  walkDenied(payload);
  assertKnownKeys(payload, new Set([
    ...COMMON_KEYS,
    ...SPAWN_KEYS,
    ...TARGET_KEYS,
    ...SEND_INPUT_KEYS,
    ...REVIVE_KEYS,
    ...BATCH_KEYS,
    ...READ_OUTPUT_KEYS,
    ...LIST_KEYS,
  ]));

  const action = stringValue(payload.action, 'action');
  if (!ACTIONS.has(action)) {
    throw new FacadeSchemaError(`stronk_subagent action denied: ${action}`);
  }

  if (action === 'spawn') {
    assertKnownKeys(payload, SPAWN_KEYS);
    const role = stringValue(payload.role ?? payload.agent, 'role');
    const task = stringValue(payload.task, 'task');
    return {
      action,
      role,
      task,
      timeoutMs: optionalTimeout(payload.timeoutMs),
    };
  }

  if (action === 'send_input') {
    assertKnownKeys(payload, SEND_INPUT_KEYS);
    return {
      action,
      childId: childTarget(payload),
      message: stringValue(payload.message, 'message'),
      timeoutMs: optionalTimeout(payload.timeoutMs),
    };
  }

  if (action === 'list') {
    assertKnownKeys(payload, LIST_KEYS);
    return {
      action,
      timeoutMs: optionalTimeout(payload.timeoutMs),
    };
  }

  if (action === 'revive') {
    assertKnownKeys(payload, REVIVE_KEYS);
    return {
      action,
      childId: childTarget(payload),
      task: reviveTask(payload),
      timeoutMs: optionalTimeout(payload.timeoutMs),
    };
  }

  if (action === 'wait_all' || action === 'close_all') {
    assertKnownKeys(payload, BATCH_KEYS);
    return {
      action,
      childIds: childTargets(payload),
      timeoutMs: optionalTimeout(payload.timeoutMs),
    };
  }

  if (action === 'read_output') {
    assertKnownKeys(payload, READ_OUTPUT_KEYS);
    return {
      action,
      outputHandle: outputHandle(payload),
      offset: optionalOffset(payload.offset),
      maxChars: optionalMaxChars(payload.maxChars),
    };
  }

  if (TERMINAL_ACTIONS.has(action)) {
    assertKnownKeys(payload, TARGET_KEYS);
    return {
      action,
      childId: childTarget(payload),
      timeoutMs: optionalTimeout(payload.timeoutMs),
    };
  }

  throw new FacadeSchemaError(`stronk_subagent action denied: ${action}`);
}

export const stronkSubagentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: [...ACTIONS] },
    role: { type: 'string' },
    agent: { type: 'string' },
    task: { type: 'string' },
    childId: { type: 'string' },
    childIds: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_CHILDREN,
      items: { type: 'string' },
    },
    outputHandle: { type: 'string' },
    offset: { type: 'number', minimum: 0 },
    maxChars: { type: 'number', minimum: 1, maximum: 24000 },
    child_id: { type: 'string' },
    target: { type: 'string' },
    message: { type: 'string' },
    timeoutMs: { type: 'number', minimum: 1, maximum: 3600000 },
  },
};
