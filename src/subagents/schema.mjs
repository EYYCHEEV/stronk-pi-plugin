const ACTIONS = new Set(['spawn', 'wait', 'status', 'send_input', 'interrupt', 'close', 'revive']);
const TERMINAL_ACTIONS = new Set(['wait', 'status', 'send_input', 'interrupt', 'close', 'revive']);
export const MAX_CHILDREN = 6;

export const DENIED_OVERRIDE_KEYS = new Set([
  'apiKey',
  'async',
  'background',
  'chain',
  'chainDir',
  'chainName',
  'extensions',
  'fallbackModels',
  'model',
  'packages',
  'provider',
  'sessionDir',
  'share',
  'skill',
  'skills',
  'systemPrompt',
  'thinking',
  'tools',
  'worktree',
  'worktreeSetupHook',
  'worktreeSetupHookTimeoutMs',
]);
const CONCURRENCY_KEYS = new Set(['concurrency', 'maxConcurrency']);
const OUTPUT_HINT_KEYS = new Set(['output', 'outputMode']);
const COMMON_KEYS = new Set(['action']);
const SPAWN_KEYS = new Set(['action', 'agent', 'role', 'task', 'cwd']);
const TARGET_KEYS = new Set(['action', 'childId', 'child_id', 'target', 'timeoutMs']);
const SEND_INPUT_KEYS = new Set(['action', 'childId', 'child_id', 'target', 'message', 'timeoutMs']);
const REVIVE_KEYS = new Set(['action', 'childId', 'child_id', 'target', 'task', 'cwd', 'timeoutMs']);

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

export function normalizeFacadePayload(payload) {
  assertPlainObject(payload, 'stronk_subagent payload');
  walkDenied(payload);
  assertKnownKeys(payload, new Set([
    ...COMMON_KEYS,
    ...SPAWN_KEYS,
    ...TARGET_KEYS,
    ...SEND_INPUT_KEYS,
    ...REVIVE_KEYS,
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
      cwd: optionalString(payload.cwd, 'cwd'),
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

  if (action === 'revive') {
    assertKnownKeys(payload, REVIVE_KEYS);
    return {
      action,
      childId: childTarget(payload),
      task: optionalString(payload.task, 'task'),
      cwd: optionalString(payload.cwd, 'cwd'),
      timeoutMs: optionalTimeout(payload.timeoutMs),
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
    cwd: { type: 'string' },
    childId: { type: 'string' },
    child_id: { type: 'string' },
    target: { type: 'string' },
    message: { type: 'string' },
    timeoutMs: { type: 'number', minimum: 1, maximum: 3600000 },
  },
};
