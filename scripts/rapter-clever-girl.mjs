#!/usr/bin/env node

import {
  chmod,
  link,
  lstat,
  open,
  readdir,
  realpath,
  unlink,
} from 'node:fs/promises';
import { constants as FS_CONSTANTS } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 'rapter-clever-girl.observe.v1';
const SOURCE_TYPES = new Set([
  'auto',
  'claude',
  'codex',
  'copilot',
  'openrappter',
  'normalized',
]);
const ACTIVE_GAP_CAP_SECONDS = 300;
const MAX_CANDIDATES = 5;
const MAX_TEXT_CHARS = 262_144;

const LABELS = Object.freeze({
  'repair-loop': 'Repeated setup or recovery workflow',
  'review-workflow': 'Repeated review or release workflow',
  'delivery-workflow': 'Repeated traceable delivery workflow',
  'recurring-correction': 'Repeated correction rule',
  'tool-sequence': 'Repeated tool sequence',
});

const RULE_IDS = Object.freeze({
  'repair-loop': 'detector.repair-loop.v1',
  'review-workflow': 'detector.review-workflow.v1',
  'delivery-workflow': 'detector.delivery-workflow.v1',
  'recurring-correction': 'detector.recurring-correction.v1',
  'tool-sequence': 'detector.tool-sequence.v1',
});

const CONFIDENCE_RANK = Object.freeze({ high: 3, medium: 2, low: 1 });
const CONTROL_MESSAGE_RE =
  /^(?:continue|yes|y|ok|okay|sure|go ahead|proceed|done|thanks|thank you|no|nope)[.!?\s]*$/i;
const TOKEN_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'please',
  'should',
  'so',
  'that',
  'the',
  'their',
  'then',
  'this',
  'to',
  'was',
  'we',
  'were',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

class CliError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage);
    this.name = 'CliError';
    this.code = code;
    this.safeMessage = safeMessage;
  }
}

class SafeReadError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SafeReadError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function own(object, key) {
  return (
    object !== null &&
    typeof object === 'object' &&
    Object.prototype.hasOwnProperty.call(object, key)
  );
}

function valueFor(record, ...keys) {
  for (const key of keys) {
    if (own(record, key)) return record[key];
  }
  return undefined;
}

function requireOptionValue(argv, index, option, inlineValue) {
  if (inlineValue !== undefined) {
    if (inlineValue.length === 0) {
      throw new CliError('MISSING_OPTION_VALUE', `Configuration error: ${option} requires a value.`);
    }
    return { value: inlineValue, nextIndex: index };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new CliError('MISSING_OPTION_VALUE', `Configuration error: ${option} requires a value.`);
  }
  return { value, nextIndex: index + 1 };
}

function parsePositiveInteger(value, option, minimum) {
  if (!/^[0-9]+$/.test(value)) {
    throw new CliError('INVALID_INTEGER', `Configuration error: ${option} requires an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new CliError(
      'INVALID_INTEGER_RANGE',
      `Configuration error: ${option} is outside its supported range.`,
    );
  }
  return parsed;
}

function parseIsoDateTime(value, option) {
  const parsed = strictTimestampString(value);
  if (parsed === null) {
    throw new CliError(
      'INVALID_DATE_TIME',
      `Configuration error: ${option} requires a valid RFC 3339 date-time with a timezone.`,
    );
  }
  return parsed;
}

/**
 * Parse observe-mode arguments without reading the environment or filesystem.
 */
export function parseArgs(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv)) {
    throw new CliError('INVALID_ARGUMENTS', 'Configuration error: arguments must be an array.');
  }
  if (argv[0] !== 'observe') {
    throw new CliError(
      'INVALID_COMMAND',
      'Usage: rapter-clever-girl observe --input <path> [options]',
    );
  }

  const options = {
    mode: 'observe',
    inputs: [],
    skillsRoots: [],
    source: 'auto',
    since: null,
    sinceMs: null,
    until: null,
    untilMs: null,
    minSessions: 3,
    minDays: 2,
    pretty: false,
    output: null,
  };
  const singletonOptions = new Set();

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--pretty') {
      if (singletonOptions.has('--pretty')) {
        throw new CliError('DUPLICATE_OPTION', 'Configuration error: --pretty was specified twice.');
      }
      singletonOptions.add('--pretty');
      options.pretty = true;
      continue;
    }

    const equalsIndex = argument.indexOf('=');
    const option = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1);
    const supported = new Set([
      '--input',
      '--skills-root',
      '--source',
      '--since',
      '--until',
      '--min-sessions',
      '--min-days',
      '--output',
    ]);
    if (!supported.has(option)) {
      throw new CliError('UNKNOWN_OPTION', 'Configuration error: an unsupported option was provided.');
    }

    const parsedValue = requireOptionValue(argv, index, option, inlineValue);
    index = parsedValue.nextIndex;
    const value = parsedValue.value;

    if (option === '--input') {
      if (value === '-') {
        throw new CliError(
          'STDIN_NOT_SUPPORTED',
          'Configuration error: --input must explicitly name a source file.',
        );
      }
      options.inputs.push(value);
      continue;
    }
    if (option === '--skills-root') {
      if (value === '-') {
        throw new CliError(
          'INVALID_SKILLS_ROOT',
          'Configuration error: --skills-root must explicitly name a filesystem location.',
        );
      }
      options.skillsRoots.push(value);
      continue;
    }
    if (singletonOptions.has(option)) {
      throw new CliError('DUPLICATE_OPTION', `Configuration error: ${option} was specified twice.`);
    }
    singletonOptions.add(option);

    switch (option) {
      case '--source':
        if (!SOURCE_TYPES.has(value)) {
          throw new CliError(
            'INVALID_SOURCE',
            'Configuration error: --source is not one of the supported adapters.',
          );
        }
        options.source = value;
        break;
      case '--since': {
        const parsed = parseIsoDateTime(value, option);
        options.since = parsed.iso;
        options.sinceMs = parsed.milliseconds;
        break;
      }
      case '--until': {
        const parsed = parseIsoDateTime(value, option);
        options.until = parsed.iso;
        options.untilMs = parsed.milliseconds;
        break;
      }
      case '--min-sessions':
        options.minSessions = parsePositiveInteger(value, option, 2);
        break;
      case '--min-days':
        options.minDays = parsePositiveInteger(value, option, 1);
        break;
      case '--output':
        if (value === '-') {
          throw new CliError(
            'INVALID_OUTPUT',
            'Configuration error: --output must explicitly name a file.',
          );
        }
        options.output = value;
        break;
      default:
        break;
    }
  }

  if (options.inputs.length === 0) {
    throw new CliError(
      'MISSING_INPUT',
      'Configuration error: at least one explicit --input path is required.',
    );
  }
  if (
    options.sinceMs !== null &&
    options.untilMs !== null &&
    options.sinceMs > options.untilMs
  ) {
    throw new CliError(
      'INVALID_TIME_WINDOW',
      'Configuration error: --since must not be later than --until.',
    );
  }
  return options;
}

function decodeHistoryBytes(bytes) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return decoder.decode(input).replace(/^\uFEFF/, '');
}

function containerRecords(value) {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') {
    for (const key of ['records', 'events', 'entries', 'rows', 'items']) {
      if (Array.isArray(value[key])) return value[key];
    }
  }
  return [value];
}

/**
 * Parse JSON or JSONL bytes. Malformed JSONL lines are represented by a
 * counted issue; parsed transcript values remain inert objects.
 */
export function parseHistoryBytes(bytes) {
  let text;
  try {
    text = decodeHistoryBytes(bytes);
  } catch {
    return {
      format: 'unknown',
      records: [],
      skippedRecords: 1,
      issues: [{ code: 'INVALID_UTF8', count: 1 }],
    };
  }

  if (text.trim().length === 0) {
    return {
      format: 'unknown',
      records: [],
      skippedRecords: 1,
      issues: [{ code: 'EMPTY_INPUT', count: 1 }],
    };
  }

  try {
    const parsed = JSON.parse(text);
    const values = containerRecords(parsed);
    if (values.length === 0) {
      return {
        format: 'json',
        records: [],
        skippedRecords: 1,
        issues: [{ code: 'EMPTY_CONTAINER', count: 1 }],
      };
    }
    return {
      format: 'json',
      records: values.map((value, index) => ({ ordinal: index + 1, value })),
      skippedRecords: 0,
      issues: [],
    };
  } catch {
    // A failed whole-document parse is expected for JSONL and is not itself a
    // skipped record. Each malformed nonblank JSONL row is counted below.
  }

  const records = [];
  let skippedRecords = 0;
  let attemptedOrdinal = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    attemptedOrdinal += 1;
    try {
      const parsed = JSON.parse(line);
      const values = Array.isArray(parsed) ? parsed : [parsed];
      if (values.length === 0) {
        skippedRecords += 1;
        continue;
      }
      for (const value of values) {
        records.push({ ordinal: attemptedOrdinal, value });
      }
    } catch {
      skippedRecords += 1;
    }
  }

  if (records.length === 0 && skippedRecords === 0) skippedRecords = 1;
  return {
    format: 'jsonl',
    records,
    skippedRecords,
    issues:
      skippedRecords > 0
        ? [{ code: records.length === 0 ? 'UNPARSEABLE_INPUT' : 'MALFORMED_RECORDS', count: skippedRecords }]
        : [],
  };
}

function appendKnownText(value, output, depth = 0) {
  if (output.length >= MAX_TEXT_CHARS || depth > 6 || value === null || value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    const remaining = MAX_TEXT_CHARS - output.length;
    output.push(value.slice(0, remaining));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) appendKnownText(item, output, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const key of ['text', 'content', 'message', 'input_text', 'output_text']) {
    if (own(value, key)) appendKnownText(value[key], output, depth + 1);
  }
}

function textFrom(...values) {
  const output = [];
  for (const value of values) appendKnownText(value, output);
  return output.join('\n').slice(0, MAX_TEXT_CHARS);
}

function hashTokens(text) {
  const tokens = text
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,31}/gu);
  if (!tokens) return [];
  const hashes = new Set();
  for (const token of tokens) {
    if (!TOKEN_STOP_WORDS.has(token)) hashes.add(sha256(`token-v1:${token}`).slice(0, 20));
    if (hashes.size >= 128) break;
  }
  return [...hashes].sort();
}

function classifyText(text) {
  const normalized = text.normalize('NFKC').trim();
  const lower = normalized.toLowerCase();
  const setup =
    /\b(?:setup|set up|install|installer|configure|configuration|dependency|dependencies|environment|authenticate|authentication|login|permission|bootstrap|first[- ]run|first time|startup|starts? up|launch|deploy|deployment|pipeline)\b/.test(
      lower,
    );
  const failure =
    /\b(?:error|fail(?:ed|ure|ing)?|broken|missing|denied|unable|cannot|can't|not found|not (?:working|running|starting|launching|going)|timeout|stuck|stall(?:ed|ing)?|runs? forever|running forever|silent|retry|recover|repair|restart|workaround)\b/.test(
      lower,
    );
  const repairAction =
    /\b(?:fix|repair|recover|retry|restart|reinstall|reconfigure|resolve|unblock|workaround)\b/.test(
      lower,
    );
  const review =
    /\b(?:review|code review|pull request review|merge request review|release candidate|go[ -]?no[ -]?go|release gate)\b/.test(
      lower,
    );
  const verification =
    /\b(?:verify|verification|test|tests|testing|pytest|vitest|lint|typecheck|type-check|build|check)\b/.test(
      lower,
    );
  const deliverySignals = [
    /\b(?:issue|ticket)\b/.test(lower),
    /\bbranch\b/.test(lower),
    /\bcommit\b/.test(lower),
    /\b(?:pull request|merge request)\b/.test(lower),
    /\b(?:push|publish|deploy|release)\b/.test(lower),
    /\b(?:test|lint|build|verify|evidence|trace|status)\b/.test(lower),
  ].filter(Boolean).length;
  const correction =
    /\b(?:always|never|from now on|going forward|next time|remember (?:to|that)|do not|don't|instead|should have|must not|prefer)\b/.test(
      lower,
    );
  const intentionalVerification =
    /\b(?:intentional|deliberate|expected|planned|predetermined|prescribed)\b/.test(lower) &&
    /\b(?:verification|validation|test|red[ -]?green|known (?:red |test )?failure)\b/.test(lower);
  const correctionTopics = [];
  if (/\b(?:test|lint|build|verify)\b/.test(lower)) correctionTopics.push('verification');
  if (/\b(?:git|commit|branch|push|merge|rebase)\b/.test(lower)) correctionTopics.push('version-control');
  if (/\b(?:output|response|reply|format|concise|verbose|style)\b/.test(lower)) {
    correctionTopics.push('communication');
  }
  if (/\b(?:path|file|directory|folder|repository|worktree)\b/.test(lower)) {
    correctionTopics.push('filesystem');
  }
  if (/\b(?:secret|token|credential|security|privacy|redact)\b/.test(lower)) {
    correctionTopics.push('security');
  }
  if (/\b(?:tool|command|shell|terminal)\b/.test(lower)) correctionTopics.push('tooling');
  if (/\b(?:document|documentation|readme)\b/.test(lower)) correctionTopics.push('documentation');

  const workflowSignal = setup || failure || repairAction || review || deliverySignals >= 2 || correction;
  return {
    isControl: CONTROL_MESSAGE_RE.test(normalized),
    repair: (setup && (failure || repairAction)) || (failure && repairAction),
    review,
    delivery: deliverySignals >= 2,
    correction,
    correctionTopics: [...new Set(correctionTopics)].sort(),
    verificationOnly: intentionalVerification || (verification && !workflowSignal),
    tokenHashes: hashTokens(normalized),
  };
}

function adapterMatches(record, source) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return false;
  switch (source) {
    case 'copilot':
      return (
        own(record, 'session_id') &&
        own(record, 'timestamp') &&
        (own(record, 'user_message') || own(record, 'assistant_response'))
      );
    case 'openrappter':
      return (
        own(record, 'sessionId') &&
        own(record, 'timestamp') &&
        own(record, 'kind') &&
        (own(record, 'toolName') || own(record, 'status') || own(record, 'durationMs'))
      );
    case 'codex':
      return own(record, 'timestamp') && own(record, 'type') && own(record, 'payload');
    case 'claude':
      return (
        own(record, 'sessionId') &&
        own(record, 'timestamp') &&
        own(record, 'type') &&
        (own(record, 'message') || own(record, 'content') || own(record, 'toolUseResult'))
      );
    case 'normalized':
      return (
        (own(record, 'sessionId') || own(record, 'session_id')) &&
        (own(record, 'timestamp') || own(record, 'time')) &&
        (own(record, 'content') ||
          own(record, 'text') ||
          own(record, 'message') ||
          own(record, 'kind') ||
          own(record, 'toolName') ||
          own(record, 'tool_name'))
      );
    default:
      return false;
  }
}

function detectAdapter(record) {
  for (const source of ['copilot', 'openrappter', 'codex', 'claude', 'normalized']) {
    if (adapterMatches(record, source)) return source;
  }
  return null;
}

function roleFrom(...values) {
  const joined = values
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  if (/\b(?:user|human|user_message)\b/.test(joined)) return 'user';
  if (/\b(?:assistant|agent|assistant_message)\b/.test(joined)) return 'assistant';
  if (/\b(?:tool|function|command)\b/.test(joined)) return 'tool';
  if (/\bsystem\b/.test(joined)) return 'system';
  return 'unknown';
}

function toolNameFromContent(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = toolNameFromContent(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const type = String(valueFor(value, 'type', 'kind') ?? '').toLowerCase();
  if (/(?:tool|function|command)/.test(type)) {
    const name = valueFor(value, 'name', 'toolName', 'tool_name');
    if (typeof name === 'string') return name;
  }
  for (const key of ['content', 'message', 'payload']) {
    if (own(value, key)) {
      const found = toolNameFromContent(value[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function classifyTool(name, type = '') {
  const lower = `${typeof name === 'string' ? name : ''} ${
    typeof type === 'string' ? type : ''
  }`.toLowerCase();
  if (!/(?:tool|function|command|shell|bash|read|write|edit|test|lint|build|git|search|grep|glob|fetch|memory|deploy|review)/.test(lower)) {
    return null;
  }
  if (/\b(?:review|code_review)\b/.test(lower)) return 'review';
  if (/\b(?:git|github|commit|branch|pull|merge)\b/.test(lower)) return 'version-control';
  if (/\b(?:test|pytest|vitest|lint|typecheck|build|check)\b/.test(lower)) return 'verification';
  if (/\b(?:edit|write|patch|create)\b/.test(lower)) return 'edit';
  if (/\b(?:read|view|grep|glob|search|find)\b/.test(lower)) return 'inspect';
  if (/\b(?:deploy|publish|release)\b/.test(lower)) return 'delivery';
  if (/\b(?:fetch|web|http|network)\b/.test(lower)) return 'network';
  if (/\b(?:memory|remember|recall)\b/.test(lower)) return 'memory';
  if (/\b(?:shell|bash|command|terminal)\b/.test(lower)) return 'shell';
  return 'other';
}

function strictTimestampString(value) {
  if (typeof value !== 'string') return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > monthDays[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  if (zone !== 'Z') {
    const [offsetHour, offsetMinute] = zone.slice(1).split(':').map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return { iso: new Date(milliseconds).toISOString(), milliseconds };
}

function normalizedTimestamp(value) {
  if (value === null || value === undefined || value === '') {
    return { iso: null, milliseconds: null, day: null, invalid: false };
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    return { iso: null, milliseconds: null, day: null, invalid: true };
  }
  let parsed;
  if (typeof value === 'number') {
    const date = new Date(value);
    parsed =
      Number.isFinite(value) && !Number.isNaN(date.getTime())
        ? { iso: date.toISOString(), milliseconds: date.getTime() }
        : null;
  } else {
    parsed = strictTimestampString(value);
  }
  if (parsed === null) {
    return { iso: null, milliseconds: null, day: null, invalid: true };
  }
  const milliseconds = parsed.milliseconds;
  if (!Number.isFinite(milliseconds)) {
    return { iso: null, milliseconds: null, day: null, invalid: true };
  }
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    return { iso: null, milliseconds: null, day: null, invalid: true };
  }
  const iso = parsed.iso;
  return { iso, milliseconds: date.getTime(), day: iso.slice(0, 10), invalid: false };
}

function sessionKeyFor(value, fallback) {
  const selected =
    value === null || value === undefined || String(value).length === 0 ? fallback : value;
  const material = `session:${String(selected)}`;
  return sha256(material);
}

export async function openRegularFileNoFollow(
  file,
  {
    symlinkCode = 'SOURCE_SYMLINK_REFUSED',
    notFileCode = 'SOURCE_NOT_FILE',
    changedCode = 'SOURCE_CHANGED_DURING_OPEN',
    readCode = 'SOURCE_READ_FAILED',
  } = {},
  hooks = {},
) {
  let before;
  try {
    before = await lstat(file);
  } catch {
    throw new SafeReadError(readCode);
  }
  if (before.isSymbolicLink()) throw new SafeReadError(symlinkCode);
  if (!before.isFile()) throw new SafeReadError(notFileCode);
  if (typeof hooks.afterLstat === 'function') await hooks.afterLstat();

  let handle;
  try {
    const noFollow = FS_CONSTANTS.O_NOFOLLOW ?? 0;
    handle = await open(file, FS_CONSTANTS.O_RDONLY | noFollow);
    const after = await handle.stat();
    if (
      !after.isFile() ||
      String(before.dev) !== String(after.dev) ||
      String(before.ino) !== String(after.ino)
    ) {
      throw new SafeReadError(changedCode);
    }
    return handle;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error instanceof SafeReadError) throw error;
    throw new SafeReadError(readCode);
  }
}

function makeNormalizedEvent({
  sourceId,
  ordinal,
  eventIndex,
  adapter,
  sessionId,
  fallbackSession,
  timestamp,
  role,
  kind,
  text,
  toolName,
  status,
  durationMs,
}) {
  const parsedTimestamp = normalizedTimestamp(timestamp);
  if (parsedTimestamp.invalid) return { errorCode: 'INVALID_TIMESTAMP' };
  const safeText = typeof text === 'string' ? text.slice(0, MAX_TEXT_CHARS) : '';
  const features = classifyText(safeText);
  const normalizedStatus = typeof status === 'string' ? status.toLowerCase() : '';
  const statusError = /\b(?:error|failed|failure|timeout|denied)\b/.test(normalizedStatus);
  const toolCategory = classifyTool(toolName, `${kind ?? ''} ${role ?? ''}`);
  const duration =
    typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0
      ? Math.floor(durationMs)
      : null;
  return {
    event: {
      sourceId,
      ordinal,
      eventIndex,
      adapter,
      sessionKey: sessionKeyFor(sessionId, fallbackSession),
      timestamp: parsedTimestamp.iso,
      timestampMs: parsedTimestamp.milliseconds,
      day: parsedTimestamp.day,
      role,
      kind: typeof kind === 'string' ? sha256(`kind-v1:${kind}`).slice(0, 16) : null,
      toolCategory,
      statusError,
      durationMs: duration,
      features,
    },
  };
}

/**
 * Normalize one supported source row. The return value never contains an
 * original session identifier, tool name, or transcript string.
 */
export function normalizeRecord(record, options = {}) {
  const requestedSource = options.source ?? 'auto';
  const sourceId =
    typeof options.sourceId === 'string' && /^source-[a-f0-9]{12}$/.test(options.sourceId)
      ? options.sourceId
      : `source-${sha256('normalized-test-source').slice(0, 12)}`;
  const ordinal =
    Number.isSafeInteger(options.ordinal) && options.ordinal >= 1 ? options.ordinal : 1;
  const fallbackSession = options.fallbackSession ?? sourceId;

  if (!SOURCE_TYPES.has(requestedSource)) {
    return { sourceType: null, records: [], errorCode: 'UNSUPPORTED_SOURCE' };
  }
  const adapter = requestedSource === 'auto' ? detectAdapter(record) : requestedSource;
  if (adapter === null || !adapterMatches(record, adapter)) {
    return { sourceType: adapter, records: [], errorCode: 'UNSUPPORTED_RECORD' };
  }

  const specs = [];
  if (adapter === 'copilot') {
    const sessionId = record.session_id;
    const timestamp = record.timestamp;
    const userText = textFrom(record.user_message);
    const assistantText = textFrom(record.assistant_response);
    if (userText.length > 0) {
      specs.push({
        sessionId,
        timestamp,
        role: 'user',
        kind: 'message',
        text: userText,
      });
    }
    if (assistantText.length > 0) {
      specs.push({
        sessionId,
        timestamp,
        role: 'assistant',
        kind: 'message',
        text: assistantText,
      });
    }
  } else if (adapter === 'claude') {
    const type = record.type;
    const content = textFrom(record.message, record.content, record.toolUseResult);
    specs.push({
      sessionId: record.sessionId,
      timestamp: record.timestamp,
      role: roleFrom(type, valueFor(record.message, 'role'), valueFor(record.content, 'role')),
      kind: type,
      text: content,
      toolName:
        valueFor(record, 'toolName', 'tool_name') ??
        toolNameFromContent(record.content) ??
        toolNameFromContent(record.message),
      status: valueFor(record.toolUseResult, 'status'),
      durationMs: valueFor(record.toolUseResult, 'durationMs', 'duration_ms'),
    });
  } else if (adapter === 'codex') {
    const payload = record.payload;
    const codexSessionId =
      record.type === 'session_meta'
        ? valueFor(payload, 'sessionId', 'session_id', 'conversationId', 'id')
        : valueFor(payload, 'sessionId', 'session_id', 'conversationId');
    specs.push({
      sessionId: codexSessionId,
      timestamp: record.timestamp,
      role: roleFrom(record.type, valueFor(payload, 'role', 'type')),
      kind: `${record.type} ${String(valueFor(payload, 'type') ?? '')}`,
      text: textFrom(valueFor(payload, 'message', 'content', 'text', 'input', 'output')),
      toolName:
        valueFor(payload, 'toolName', 'tool_name', 'name') ?? toolNameFromContent(payload),
      status: valueFor(payload, 'status', 'result_status'),
      durationMs: valueFor(payload, 'durationMs', 'duration_ms'),
    });
  } else if (adapter === 'openrappter') {
    const payload = record.payload;
    specs.push({
      sessionId: record.sessionId,
      timestamp: record.timestamp,
      role: roleFrom(valueFor(payload, 'role'), record.kind, record.toolName),
      kind: record.kind,
      text: textFrom(valueFor(payload, 'content', 'message', 'text')),
      toolName: record.toolName ?? valueFor(payload, 'toolName', 'tool_name'),
      status: record.status,
      durationMs: record.durationMs,
    });
  } else {
    const role = valueFor(record, 'role', 'actor', 'type');
    const kind = valueFor(record, 'kind', 'eventType', 'event_type', 'type');
    specs.push({
      sessionId: valueFor(record, 'sessionId', 'session_id'),
      timestamp: valueFor(record, 'timestamp', 'time'),
      role: roleFrom(role, kind),
      kind,
      text: textFrom(
        valueFor(record, 'content', 'text', 'message', 'user_message', 'assistant_response'),
      ),
      toolName:
        valueFor(record, 'toolName', 'tool_name') ??
        toolNameFromContent(valueFor(record, 'content', 'message')),
      status: valueFor(record, 'status'),
      durationMs: valueFor(record, 'durationMs', 'duration_ms'),
    });
  }

  if (specs.length === 0) {
    return { sourceType: adapter, records: [], errorCode: 'EMPTY_RECORD' };
  }

  const records = [];
  for (let eventIndex = 0; eventIndex < specs.length; eventIndex += 1) {
    const result = makeNormalizedEvent({
      ...specs[eventIndex],
      sourceId,
      ordinal,
      eventIndex,
      adapter,
      fallbackSession,
    });
    if (result.errorCode) {
      return { sourceType: adapter, records: [], errorCode: result.errorCode };
    }
    records.push(result.event);
  }
  return { sourceType: adapter, records, errorCode: null };
}

function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseSkillFrontmatter(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) return null;
  let name = '';
  let description = '';
  for (let index = 1; index < end; index += 1) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[index]);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const raw = match[2];
    if (key === 'name') name = unquoteYamlScalar(raw);
    if (key === 'description') {
      if (/^[>|][-+]?$/.test(raw.trim())) {
        const continuation = [];
        while (index + 1 < end && /^\s+/.test(lines[index + 1])) {
          continuation.push(lines[index + 1].trim());
          index += 1;
        }
        description = continuation.join(' ');
      } else {
        description = unquoteYamlScalar(raw);
      }
    }
  }
  if (name.trim().length === 0 || description.trim().length === 0) return null;
  return { name: name.trim(), description: description.trim() };
}

function safeSkillName(name) {
  const normalized = name.normalize('NFKC').toLowerCase().trim();
  const safe =
    /^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized) &&
    !/[a-z0-9]{20,}/.test(normalized) &&
    !/(?:token|secret|password|credential)[_-][a-z0-9]{8,}/.test(normalized);
  return safe ? normalized : `skill-${sha256(`skill-name-v1:${name}`).slice(0, 12)}`;
}

function skillTopics(text) {
  const lower = text.toLowerCase();
  const topics = [];
  if (/\b(?:review|release|pull request|merge|gate)\b/.test(lower)) topics.push('review-workflow');
  if (/\b(?:setup|install|configure|repair|recover|root cause|failure)\b/.test(lower)) {
    topics.push('repair-loop');
  }
  if (/\b(?:deliver|commit|branch|issue|deploy|publish|trace)\b/.test(lower)) {
    topics.push('delivery-workflow');
  }
  if (/\b(?:preference|instruction|correction|rule|memory)\b/.test(lower)) {
    topics.push('recurring-correction');
  }
  if (/\b(?:tool|workflow|automation|sequence)\b/.test(lower)) topics.push('tool-sequence');
  return [...new Set(topics)].sort();
}

async function collectSkillFiles(root, state) {
  let stats;
  try {
    stats = await lstat(root);
  } catch {
    state.diagnostics.push({ code: 'SKILLS_ROOT_UNREADABLE', count: 1 });
    state.skippedEntries += 1;
    return;
  }
  if (stats.isSymbolicLink()) {
    state.diagnostics.push({ code: 'SKILLS_SYMLINK_SKIPPED', count: 1 });
    state.skippedEntries += 1;
    return;
  }
  if (stats.isFile()) {
    if (basename(root) === 'SKILL.md') state.files.push(root);
    else {
      state.diagnostics.push({ code: 'SKILLS_FILE_UNSUPPORTED', count: 1 });
      state.skippedEntries += 1;
    }
    return;
  }
  if (!stats.isDirectory()) {
    state.diagnostics.push({ code: 'SKILLS_ENTRY_UNSUPPORTED', count: 1 });
    state.skippedEntries += 1;
    return;
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    state.diagnostics.push({ code: 'SKILLS_ROOT_UNREADABLE', count: 1 });
    state.skippedEntries += 1;
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const child = resolve(root, entry.name);
    if (entry.isSymbolicLink()) {
      state.diagnostics.push({ code: 'SKILLS_SYMLINK_SKIPPED', count: 1 });
      state.skippedEntries += 1;
    } else if (entry.isDirectory()) {
      await collectSkillFiles(child, state);
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      state.files.push(child);
    }
  }
}

/**
 * Inspect only explicitly selected roots, without following symlinks. Returned
 * entries contain a safe capability name and derived hashes/topics, never raw
 * descriptions or filesystem paths.
 */
export async function loadSkillCatalog(roots = []) {
  const explicitRoots = Array.isArray(roots) ? roots : [roots];
  const state = { files: [], diagnostics: [], skippedEntries: 0 };
  for (const root of explicitRoots) await collectSkillFiles(root, state);
  state.files.sort((left, right) => left.localeCompare(right, 'en'));

  const skills = [];
  for (const file of state.files) {
    let handle;
    try {
      handle = await openRegularFileNoFollow(file, {
        symlinkCode: 'SKILL_SYMLINK_SKIPPED',
        notFileCode: 'SKILLS_FILE_UNSUPPORTED',
        changedCode: 'SKILL_CHANGED_DURING_OPEN',
        readCode: 'SKILL_READ_FAILED',
      });
      const bytes = await handle.readFile();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const frontmatter = parseSkillFrontmatter(text);
      if (!frontmatter) {
        state.diagnostics.push({ code: 'SKILL_FRONTMATTER_INVALID', count: 1 });
        state.skippedEntries += 1;
        continue;
      }
      const safeName = safeSkillName(frontmatter.name);
      const derivedText = `${frontmatter.name}\n${frontmatter.description}`;
      skills.push({
        name: safeName,
        skillId: `skill-${sha256(`skill-v1:${safeName}:${sha256(bytes)}`).slice(0, 16)}`,
        topics: skillTopics(derivedText),
        tokenHashes: hashTokens(derivedText),
      });
    } catch (error) {
      state.diagnostics.push({
        code: error instanceof SafeReadError ? error.code : 'SKILL_READ_FAILED',
        count: 1,
      });
      state.skippedEntries += 1;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  const byName = new Map();
  for (const skill of skills.sort((left, right) => {
    const nameOrder = left.name.localeCompare(right.name, 'en');
    return nameOrder !== 0 ? nameOrder : left.skillId.localeCompare(right.skillId, 'en');
  })) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return {
    skills: [...byName.values()],
    skippedEntries: state.skippedEntries,
    diagnostics: aggregateCounts(state.diagnostics),
  };
}

function aggregateCounts(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.code, (counts.get(item.code) ?? 0) + item.count);
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([code, count]) => ({ code, count }));
}

function jaccard(left, right) {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  let intersection = 0;
  for (const item of right) if (leftSet.has(item)) intersection += 1;
  return intersection / (leftSet.size + new Set(right).size - intersection);
}

function groupEvidence(events) {
  const groups = new Map();
  for (const event of events) {
    if (!event.day) continue;
    const key = `${event.sourceId}:${event.sessionKey}:${event.day}`;
    if (!groups.has(key)) {
      groups.set(key, {
        sourceId: event.sourceId,
        sessionKey: event.sessionKey,
        day: event.day,
        events: [],
      });
    }
    groups.get(key).events.push(event);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      events: group.events.sort(compareEvents),
    }))
    .sort((left, right) => {
      const dayOrder = left.day.localeCompare(right.day, 'en');
      if (dayOrder !== 0) return dayOrder;
      const sessionOrder = left.sessionKey.localeCompare(right.sessionKey, 'en');
      if (sessionOrder !== 0) return sessionOrder;
      return left.sourceId.localeCompare(right.sourceId, 'en');
    });
}

function compareEvents(left, right) {
  const leftTime = left.timestampMs ?? Number.MAX_SAFE_INTEGER;
  const rightTime = right.timestampMs ?? Number.MAX_SAFE_INTEGER;
  if (leftTime !== rightTime) return leftTime - rightTime;
  if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal;
  if (left.eventIndex !== right.eventIndex) return left.eventIndex - right.eventIndex;
  return left.sourceId.localeCompare(right.sourceId, 'en');
}

function falsePositiveRisks(patternType) {
  switch (patternType) {
    case 'repair-loop':
      return [
        'Similar failure wording can describe different root causes; inspect before changing a workflow.',
        'Repeated setup may be environment-specific rather than suitable for automation.',
      ];
    case 'review-workflow':
      return [
        'Repeated review language may refer to distinct release gates with different policies.',
      ];
    case 'delivery-workflow':
      return [
        'Shared delivery vocabulary does not prove the same end-to-end workflow.',
      ];
    case 'recurring-correction':
      return [
        'Lexical recurrence can group separate preferences; confirm the rule with the user.',
      ];
    case 'tool-sequence':
      return [
        'A repeated tool order can be incidental and does not establish safe automation boundaries.',
      ];
    default:
      return ['Rule-based evidence may share vocabulary without sharing intent.'];
  }
}

function chooseCapability(patternType, catalog, events) {
  const skills = (Array.isArray(catalog?.skills) ? catalog.skills : []).filter(
    (skill) => skill.name !== 'rapter-clever-girl-observe',
  );
  const preferredName =
    patternType === 'review-workflow'
      ? 'release-reviewer'
      : patternType === 'repair-loop'
        ? 'root-cause-fix'
        : null;
  if (preferredName) {
    const preferred = skills.find((skill) => skill.name === preferredName);
    if (preferred) {
      return {
        name: preferred.name,
        match: patternType === 'repair-loop' ? 'extend' : 'reuse',
        reason:
          patternType === 'repair-loop'
            ? 'Extend the inspected root-cause capability instead of automating a recurring workaround.'
            : 'The inspected release-reviewer capability directly covers repeated review and release gates.',
      };
    }
  }

  const candidateTokens = [
    ...new Set(events.flatMap((event) => event.features?.tokenHashes ?? [])),
  ].sort();
  const related = skills
    .filter((skill) => Array.isArray(skill.topics) && skill.topics.includes(patternType))
    .map((skill) => {
      const intersection = candidateTokens.filter((token) =>
        skill.tokenHashes.includes(token)).length;
      return {
        skill,
        intersection,
        similarity: jaccard(candidateTokens, skill.tokenHashes),
      };
    })
    .filter(({ intersection, similarity }) => intersection >= 2 && similarity >= 0.1)
    .sort((left, right) => {
      if (left.similarity !== right.similarity) return right.similarity - left.similarity;
      if (left.intersection !== right.intersection) return right.intersection - left.intersection;
      return left.skill.name.localeCompare(right.skill.name, 'en');
    })[0]?.skill;
  if (!related) return null;
  return {
    name: related.name,
    match: 'possible-overlap',
    reason:
      'The explicitly selected catalog has lexical signals related to this pattern; inspect it before creating a new capability.',
  };
}

function classificationFor(patternType, capability) {
  if (patternType === 'repair-loop') return 'root-cause-fix';
  if (capability?.match === 'reuse') return 'reuse-existing';
  if (capability?.match === 'extend') return 'extend-existing';
  if (patternType === 'tool-sequence') return 'new-automation-candidate';
  if (patternType === 'recurring-correction') return 'workflow-fix';
  return 'new-skill-candidate';
}

function activeFriction(candidateEvents, allEvents) {
  const evidenceKeys = new Set(
    candidateEvents.map(
      (event) => `${event.sourceId}:${event.sessionKey}:${event.ordinal}:${event.eventIndex}`,
    ),
  );
  const bySessionDay = new Map();
  for (const event of allEvents) {
    if (event.timestampMs === null || !event.day) continue;
    const key = `${event.sourceId}:${event.sessionKey}:${event.day}`;
    if (!bySessionDay.has(key)) bySessionDay.set(key, []);
    bySessionDay.get(key).push(event);
  }

  let lowerSeconds = 0;
  let upperSeconds = 0;
  let measuredGaps = 0;
  const seenPairs = new Set();
  for (const events of bySessionDay.values()) {
    events.sort(compareEvents);
    for (let index = 1; index < events.length; index += 1) {
      const previous = events[index - 1];
      const current = events[index];
      const previousKey = `${previous.sourceId}:${previous.sessionKey}:${previous.ordinal}:${previous.eventIndex}`;
      const currentKey = `${current.sourceId}:${current.sessionKey}:${current.ordinal}:${current.eventIndex}`;
      const previousIsEvidence = evidenceKeys.has(previousKey);
      const currentIsEvidence = evidenceKeys.has(currentKey);
      if (!previousIsEvidence && !currentIsEvidence) continue;
      const pairKey = `${previousKey}>${currentKey}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const rawSeconds = Math.floor((current.timestampMs - previous.timestampMs) / 1000);
      if (rawSeconds < 0) continue;
      const capped = Math.min(rawSeconds, ACTIVE_GAP_CAP_SECONDS);
      upperSeconds += capped;
      if (previousIsEvidence && currentIsEvidence) lowerSeconds += capped;
      measuredGaps += 1;
    }
  }

  if (measuredGaps === 0) {
    return {
      lowerSeconds: 0,
      upperSeconds: 0,
      method: 'capped-active-intervals-v1',
      confidence: 'unavailable',
    };
  }
  return {
    lowerSeconds,
    upperSeconds: Math.max(lowerSeconds, upperSeconds),
    method: 'capped-active-intervals-v1',
    confidence: lowerSeconds > 0 ? 'medium' : 'low',
  };
}

function makeEvidence(groups, aliases, ruleId) {
  return groups.slice(0, 20).map((group) => {
    const ordinals = [...new Set(group.events.map((event) => event.ordinal))].sort(
      (left, right) => left - right,
    );
    return {
      evidenceId: `evidence-${sha256(
        `${ruleId}:${group.sourceId}:${group.sessionKey}:${ordinals.join(',')}`,
      ).slice(0, 20)}`,
      sourceId: group.sourceId,
      sessionAlias: aliases.get(group.sessionKey),
      day: group.day,
      recordOrdinals: ordinals,
      ruleId,
    };
  });
}

function buildCandidate({
  patternType,
  clusterKey,
  events,
  evidenceGroups,
  aliases,
  allEvents,
  catalog,
  minSessions,
  minDays,
}) {
  const sessions = new Set(evidenceGroups.map((group) => group.sessionKey)).size;
  const activeDays = new Set(evidenceGroups.map((group) => group.day)).size;
  const occurrences = evidenceGroups.length;
  if (occurrences < 2 || sessions < 2 || activeDays < 1) return null;

  const confidence =
    sessions >= Math.max(minSessions, 3) &&
    activeDays >= Math.max(minDays, 2) &&
    occurrences >= Math.max(minSessions, 3)
      ? 'high'
      : 'medium';
  const capability = chooseCapability(patternType, catalog, events);
  const ruleId = RULE_IDS[patternType];
  return {
    candidateId: `candidate-${sha256(`${patternType}:${clusterKey}`).slice(0, 16)}`,
    label: LABELS[patternType],
    patternType,
    classification: classificationFor(patternType, capability),
    confidence,
    occurrences,
    sessions,
    activeDays,
    evidence: makeEvidence(evidenceGroups, aliases, ruleId),
    observedActiveFriction: activeFriction(events, allEvents),
    existingCapability: capability,
    falsePositiveRisks: falsePositiveRisks(patternType),
  };
}

function correctionClusters(events) {
  if (events.length === 0) return [];
  const parent = events.map((_, index) => index);
  const find = (index) => {
    let cursor = index;
    while (parent[cursor] !== cursor) {
      parent[cursor] = parent[parent[cursor]];
      cursor = parent[cursor];
    }
    return cursor;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  for (let left = 0; left < events.length; left += 1) {
    for (let right = left + 1; right < events.length; right += 1) {
      const leftTopics = events[left].features.correctionTopics;
      const rightTopics = events[right].features.correctionTopics;
      const sharedTopic =
        leftTopics.length > 0 && leftTopics.some((topic) => rightTopics.includes(topic));
      const leftTokens = events[left].features.tokenHashes;
      const rightTokens = events[right].features.tokenHashes;
      const intersection = leftTokens.filter((token) => rightTokens.includes(token)).length;
      const lexicallySimilar = intersection >= 2 && jaccard(leftTokens, rightTokens) >= 0.6;
      if (sharedTopic || lexicallySimilar) union(left, right);
    }
  }
  const clusters = new Map();
  for (let index = 0; index < events.length; index += 1) {
    const root = find(index);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(events[index]);
  }
  return [...clusters.values()].map((cluster) => {
    const topics = [...new Set(cluster.flatMap((event) => event.features.correctionTopics))].sort();
    const lexicalMaterial = cluster
      .flatMap((event) => event.features.tokenHashes)
      .sort()
      .slice(0, 32)
      .join(':');
    return {
      key: topics.length > 0 ? `topics:${topics.join(':')}` : `lexical:${sha256(lexicalMaterial)}`,
      events: cluster,
    };
  });
}

function toolSequenceClusters(events) {
  const bySessionDay = new Map();
  for (const event of events) {
    if (!event.day || !event.toolCategory) continue;
    const key = `${event.sourceId}:${event.sessionKey}:${event.day}`;
    if (!bySessionDay.has(key)) bySessionDay.set(key, []);
    bySessionDay.get(key).push(event);
  }

  const sequences = new Map();
  for (const sessionEvents of bySessionDay.values()) {
    sessionEvents.sort(compareEvents);
    const compressed = [];
    for (const event of sessionEvents) {
      const last = compressed[compressed.length - 1];
      if (last?.category === event.toolCategory) {
        last.events.push(event);
      } else {
        compressed.push({ category: event.toolCategory, events: [event] });
      }
    }
    for (const length of [3, 2]) {
      for (let start = 0; start + length <= compressed.length; start += 1) {
        const window = compressed.slice(start, start + length);
        const signature = window.map((entry) => entry.category).join('>');
        if (!sequences.has(signature)) sequences.set(signature, []);
        sequences.get(signature).push({
          sourceId: window[0].events[0].sourceId,
          sessionKey: window[0].events[0].sessionKey,
          day: window[0].events[0].day,
          events: window.flatMap((entry) => entry.events).sort(compareEvents),
          verificationOnly: window.every((entry) =>
            ['inspect', 'verification'].includes(entry.category),
          ),
        });
      }
    }
  }
  return [...sequences.entries()].map(([signature, occurrences]) => ({
    key: sha256(`tool-sequence-v1:${signature}`),
    occurrences,
  }));
}

/**
 * Mine conservative, deterministic patterns from already-normalized records.
 */
export function analyzeHistory(records, options = {}) {
  const flattened = records.flatMap((record) => (Array.isArray(record) ? record : [record]));
  const sinceMs = options.sinceMs ?? null;
  const untilMs = options.untilMs ?? null;
  const inWindow = flattened.filter((event) => {
    if (!event || typeof event !== 'object' || typeof event.sessionKey !== 'string') return false;
    if (event.timestampMs === null) return sinceMs === null && untilMs === null;
    if (sinceMs !== null && event.timestampMs < sinceMs) return false;
    if (untilMs !== null && event.timestampMs > untilMs) return false;
    return true;
  });

  const sessionKeys = [...new Set(inWindow.map((event) => event.sessionKey))].sort();
  const aliases = new Map(
    sessionKeys.map((sessionKey, index) => [
      sessionKey,
      `session-${String(index + 1).padStart(3, '0')}`,
    ]),
  );
  const excluded = {
    controlMessages: 0,
    belowEvidenceThreshold: 0,
    intentionalVerificationLoops: 0,
  };
  const candidateEvents = [];
  for (const event of inWindow) {
    if (event.features?.isControl) {
      excluded.controlMessages += 1;
      continue;
    }
    if (event.features?.verificationOnly) {
      excluded.intentionalVerificationLoops += 1;
      continue;
    }
    candidateEvents.push(event);
  }

  const userRepairEvents = candidateEvents.filter(
    (event) => event.role === 'user' && event.features?.repair,
  );
  const repairContexts = new Set(
    userRepairEvents.map(
      (event) => `${event.sourceId}:${event.sessionKey}:${event.day ?? 'undated'}`,
    ),
  );
  const definitions = [
    {
      patternType: 'repair-loop',
      clusterKey: 'repair-loop-v1',
      events: candidateEvents.filter(
        (event) =>
          (event.role === 'user' && event.features?.repair) ||
          (event.role === 'tool' &&
            event.statusError &&
            repairContexts.has(
              `${event.sourceId}:${event.sessionKey}:${event.day ?? 'undated'}`,
            )),
      ),
    },
    {
      patternType: 'review-workflow',
      clusterKey: 'review-workflow-v1',
      events: candidateEvents.filter(
        (event) => event.role === 'user' && event.features?.review,
      ),
    },
    {
      patternType: 'delivery-workflow',
      clusterKey: 'delivery-workflow-v1',
      events: candidateEvents.filter(
        (event) =>
          event.role === 'user' && event.features?.delivery && !event.features?.review,
      ),
    },
  ];

  for (const cluster of correctionClusters(
    candidateEvents.filter(
      (event) => event.role === 'user' && event.features?.correction,
    ),
  )) {
    definitions.push({
      patternType: 'recurring-correction',
      clusterKey: cluster.key,
      events: cluster.events,
    });
  }

  const toolDefinitions = toolSequenceClusters(candidateEvents);
  for (const sequence of toolDefinitions) {
    if (sequence.occurrences.length < 2) continue;
    if (sequence.occurrences.every((occurrence) => occurrence.verificationOnly)) {
      excluded.intentionalVerificationLoops += sequence.occurrences.length;
      continue;
    }
    definitions.push({
      patternType: 'tool-sequence',
      clusterKey: sequence.key,
      events: sequence.occurrences.flatMap((occurrence) => occurrence.events),
      explicitEvidenceGroups: sequence.occurrences,
    });
  }

  const candidates = [];
  for (const definition of definitions) {
    const evidenceGroups =
      definition.explicitEvidenceGroups ?? groupEvidence(definition.events);
    if (definition.events.length < 2) continue;
    const candidate = buildCandidate({
      ...definition,
      evidenceGroups,
      aliases,
      allEvents: inWindow,
      catalog: options.catalog ?? { skills: [] },
      minSessions: options.minSessions ?? 3,
      minDays: options.minDays ?? 2,
    });
    if (candidate) candidates.push(candidate);
    else excluded.belowEvidenceThreshold += 1;
  }

  candidates.sort((left, right) => {
    const confidenceOrder = CONFIDENCE_RANK[right.confidence] - CONFIDENCE_RANK[left.confidence];
    if (confidenceOrder !== 0) return confidenceOrder;
    if (left.occurrences !== right.occurrences) return right.occurrences - left.occurrences;
    if (left.sessions !== right.sessions) return right.sessions - left.sessions;
    if (left.activeDays !== right.activeDays) return right.activeDays - left.activeDays;
    return left.candidateId.localeCompare(right.candidateId, 'en');
  });

  return {
    sessions: sessionKeys.length,
    activeDays: new Set(inWindow.map((event) => event.day).filter(Boolean)).size,
    candidates: candidates.slice(0, MAX_CANDIDATES),
    excluded,
  };
}

function canonicalize(value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') {
    throw new TypeError('BigInt values are not supported by stableStringify.');
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (seen.has(value)) throw new TypeError('Circular values are not supported by stableStringify.');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry) => {
      const canonical = canonicalize(entry, seen);
      return canonical === undefined ? null : canonical;
    });
  } else {
    result = {};
    for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'))) {
      const canonical = canonicalize(value[key], seen);
      if (canonical !== undefined) result[key] = canonical;
    }
  }
  seen.delete(value);
  return result;
}

/**
 * JSON stringify with recursively sorted object keys.
 */
export function stableStringify(value, pretty = false) {
  const spacing =
    pretty === true
      ? 2
      : Number.isSafeInteger(pretty) && pretty >= 0 && pretty <= 10
        ? pretty
        : 0;
  return JSON.stringify(canonicalize(value, new Set()), null, spacing);
}

function diagnosticMessage(stage, code) {
  if (stage === 'read') return 'An explicitly selected source could not be read.';
  if (stage === 'parse' && code === 'INVALID_UTF8') {
    return 'A selected source was not valid UTF-8 and could not be parsed.';
  }
  if (stage === 'parse' && code === 'EMPTY_INPUT') return 'A selected source was empty.';
  if (stage === 'parse') return 'One or more source records were malformed and were counted.';
  if (stage === 'normalize' && code === 'INVALID_TIMESTAMP') {
    return 'One or more records had an invalid timestamp and were counted.';
  }
  if (stage === 'normalize') {
    return 'One or more records did not match the selected source adapter and were counted.';
  }
  if (stage === 'mine') {
    return 'One or more entries in an explicitly selected skill catalog could not be inspected.';
  }
  return 'A deterministic analysis stage reported a redacted diagnostic.';
}

function reportDiagnostic(source, status, stage, code) {
  return {
    sourceId: source.sourceId,
    status,
    stage,
    code,
    acceptedRecords: source.acceptedRecords,
    skippedRecords: source.skippedRecords,
    message: diagnosticMessage(stage, code),
  };
}

async function readSource(input, requestedSource, digestOccurrences) {
  let handle;
  let bytes;
  let readFailureCode = 'SOURCE_READ_FAILED';
  try {
    handle = await openRegularFileNoFollow(input);
    bytes = await handle.readFile();
  } catch (error) {
    if (error instanceof SafeReadError) readFailureCode = error.code;
    const digest = sha256(Buffer.alloc(0));
    const source = {
      sourceId: `source-${sha256(`unreadable-source-v1:${String(input)}`).slice(0, 12)}`,
      sourceType: requestedSource,
      sourceDigest: `sha256:${digest}`,
      status: 'failed',
      acceptedRecords: 0,
      skippedRecords: 1,
    };
    return {
      source,
      events: [],
      diagnostics: [reportDiagnostic(source, 'failed', 'read', readFailureCode)],
    };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }

  const digest = sha256(bytes);
  const occurrence = (digestOccurrences.get(digest) ?? 0) + 1;
  digestOccurrences.set(digest, occurrence);
  const sourceId = `source-${sha256(`source-v1:${digest}:${occurrence}`).slice(0, 12)}`;
  const parsed = parseHistoryBytes(bytes);
  const events = [];
  let acceptedRecords = 0;
  let skippedRecords = parsed.skippedRecords;
  let codexSessionFallback = sourceId;
  const normalizationIssues = [];
  const detectedSourceTypes = new Set();

  for (const parsedRecord of parsed.records) {
    const rawRecord = parsedRecord.value;
    if (
      (requestedSource === 'codex' ||
        (requestedSource === 'auto' && adapterMatches(rawRecord, 'codex'))) &&
      rawRecord?.type === 'session_meta'
    ) {
      const codexSessionId = valueFor(rawRecord.payload, 'id', 'sessionId', 'session_id');
      if (codexSessionId !== undefined && codexSessionId !== null) {
        codexSessionFallback = String(codexSessionId);
      }
    }
    const normalized = normalizeRecord(parsedRecord.value, {
      source: requestedSource,
      sourceId,
      ordinal: parsedRecord.ordinal,
      fallbackSession: codexSessionFallback,
    });
    if (normalized.errorCode) {
      skippedRecords += 1;
      normalizationIssues.push({ code: normalized.errorCode, count: 1 });
      continue;
    }
    acceptedRecords += 1;
    detectedSourceTypes.add(normalized.sourceType);
    events.push(...normalized.records);
  }

  const status = acceptedRecords === 0 ? 'failed' : skippedRecords > 0 ? 'partial' : 'ok';
  const detectedSourceType =
    requestedSource === 'auto' && detectedSourceTypes.size === 1
      ? [...detectedSourceTypes][0]
      : requestedSource;
  const source = {
    sourceId,
    sourceType: detectedSourceType,
    sourceDigest: `sha256:${digest}`,
    status,
    acceptedRecords,
    skippedRecords,
  };
  const diagnosticStatus = status === 'failed' ? 'failed' : 'partial';
  const diagnostics = [
    ...parsed.issues.map((issue) =>
      reportDiagnostic(source, diagnosticStatus, 'parse', issue.code),
    ),
    ...aggregateCounts(normalizationIssues).map((issue) =>
      reportDiagnostic(source, diagnosticStatus, 'normalize', issue.code),
    ),
  ];
  return { source, events, diagnostics };
}

function pathKey(value, platform = process.platform) {
  const absolute = resolve(value).normalize('NFC');
  return platform === 'win32' || platform === 'darwin' ? absolute.toLowerCase() : absolute;
}

async function canonicalFuturePath(value, platform = process.platform) {
  const absolute = resolve(value);
  try {
    return pathKey(await realpath(absolute), platform);
  } catch {
    try {
      const realParent = await realpath(dirname(absolute));
      return pathKey(resolve(realParent, basename(absolute)), platform);
    } catch {
      return pathKey(absolute, platform);
    }
  }
}

function pathIsWithin(child, parent) {
  const difference = relative(parent, child);
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference));
}

export async function validateOutputScope(options, platform = process.platform) {
  if (!options?.output) return;
  if (platform === 'win32') {
    throw new CliError(
      'OUTPUT_UNSUPPORTED_ON_WINDOWS',
      'Output error: private report files are not supported on Windows; use stdout.',
    );
  }

  const outputKey = await canonicalFuturePath(options.output, platform);
  for (const input of options.inputs ?? []) {
    if (outputKey === (await canonicalFuturePath(input, platform))) {
      throw new CliError(
        'OUTPUT_ALIASES_SOURCE',
        'Output error: the report path aliases an explicitly selected source.',
      );
    }
  }
  for (const root of options.skillsRoots ?? []) {
    const rootKey = await canonicalFuturePath(root, platform);
    if (pathIsWithin(outputKey, rootKey)) {
      throw new CliError(
        'OUTPUT_INSIDE_SKILLS_ROOT',
        'Output error: the report path must be outside every selected skill root.',
      );
    }
  }
  try {
    await lstat(options.output);
    throw new CliError(
      'OUTPUT_ALREADY_EXISTS',
      'Output error: refusing to replace an existing filesystem entry.',
    );
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error?.code !== 'ENOENT') {
      throw new CliError(
        'OUTPUT_SCOPE_UNVERIFIED',
        'Output error: the report destination could not be verified safely.',
      );
    }
  }
}

async function atomicWrite(output, text) {
  const parent = dirname(output);
  const temporary = resolve(
    parent,
    `.${basename(output)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let handle;
  let linked = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(text, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporary, 0o600);
    await link(temporary, output);
    linked = true;
    await chmod(output, 0o600);
    await unlink(temporary);
  } catch {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (linked) await unlink(output).catch(() => {});
    throw new CliError(
      'OUTPUT_WRITE_FAILED',
      'Output error: unable to write the explicitly selected output file.',
    );
  }
}

function ioWriter(stream, fallback) {
  if (stream && typeof stream.write === 'function') return (text) => stream.write(text);
  if (typeof stream === 'function') return stream;
  return fallback;
}

/**
 * Execute Observe Mode. The report is always written to stdout; an explicit
 * output path receives the same bytes atomically.
 */
export async function runObserveCli(argsOrOptions, io = {}) {
  const options = Array.isArray(argsOrOptions) ? parseArgs(argsOrOptions) : argsOrOptions;
  if (!options || options.mode !== 'observe' || !Array.isArray(options.inputs)) {
    throw new CliError('INVALID_OPTIONS', 'Configuration error: invalid observe options.');
  }
  await validateOutputScope(options);
  const writeStdout = ioWriter(io.stdout, (text) => process.stdout.write(text));
  const skillCatalog = await loadSkillCatalog(options.skillsRoots ?? []);
  const digestOccurrences = new Map();
  const sourceResults = [];
  for (let index = 0; index < options.inputs.length; index += 1) {
    sourceResults.push(
      await readSource(options.inputs[index], options.source ?? 'auto', digestOccurrences),
    );
  }
  sourceResults.sort((left, right) =>
    left.source.sourceId.localeCompare(right.source.sourceId, 'en'),
  );

  const sources = sourceResults.map((result) => result.source);
  const normalizedEvents = sourceResults.flatMap((result) => result.events);
  const analysis = analyzeHistory(normalizedEvents, {
    sinceMs: options.sinceMs ?? null,
    untilMs: options.untilMs ?? null,
    minSessions: options.minSessions ?? 3,
    minDays: options.minDays ?? 2,
    catalog: skillCatalog,
  });
  const acceptedRecords = sources.reduce((total, source) => total + source.acceptedRecords, 0);
  const skippedRecords = sources.reduce((total, source) => total + source.skippedRecords, 0);
  const anyAccepted = acceptedRecords > 0;
  let status = anyAccepted ? 'ok' : 'failed';
  if (
    anyAccepted &&
    (sources.some((source) => source.status !== 'ok') || skillCatalog.skippedEntries > 0)
  ) {
    status = 'partial';
  }

  const diagnostics = sourceResults.flatMap((result) => result.diagnostics);
  if (skillCatalog.skippedEntries > 0 && sources.length > 0) {
    const source = sources[0];
    diagnostics.push(
      reportDiagnostic(
        source,
        status === 'failed' ? 'failed' : 'partial',
        'mine',
        'SKILL_CATALOG_PARTIAL',
      ),
    );
  }

  const report = {
    schemaVersion: SCHEMA_VERSION,
    mode: 'observe',
    status,
    scope: {
      windowStart: options.since ?? null,
      windowEnd: options.until ?? null,
      minimumSessions: options.minSessions ?? 3,
      minimumActiveDays: options.minDays ?? 2,
      skillsRootsCount: (options.skillsRoots ?? []).length,
    },
    sources,
    summary: {
      sessions: analysis.sessions,
      activeDays: analysis.activeDays,
      acceptedRecords,
      skippedRecords,
      candidateCount: analysis.candidates.length,
      highConfidenceCandidateCount: analysis.candidates.filter(
        (candidate) => candidate.confidence === 'high',
      ).length,
    },
    candidates: analysis.candidates,
    excluded: analysis.excluded,
    diagnostics,
  };
  const text = `${stableStringify(report, options.pretty === true)}\n`;
  writeStdout(text);
  if (options.output) await atomicWrite(options.output, text);
  return { exitCode: status === 'failed' ? 1 : 0, report, text };
}

/**
 * CLI entry point. Usage/configuration errors are redacted and do not create a
 * report because there is no valid explicit source scope.
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const writeStderr = ioWriter(io.stderr, (text) => process.stderr.write(text));
  try {
    const result = await runObserveCli(argv, io);
    return result.exitCode;
  } catch (error) {
    const message =
      error instanceof CliError
        ? error.safeMessage
        : 'Observe mode failed before analysis could complete.';
    writeStderr(`${message}\n`);
    return 2;
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    const entryUrl = pathToFileURL(resolve(process.argv[1])).href;
    return process.platform === 'win32'
      ? entryUrl.toLowerCase() === import.meta.url.toLowerCase()
      : entryUrl === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
