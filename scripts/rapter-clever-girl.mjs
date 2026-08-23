#!/usr/bin/env node

import {
  chmod,
  link,
  lstat,
  open,
  opendir,
  realpath,
  unlink,
} from 'node:fs/promises';
import { constants as FS_CONSTANTS } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  EVIDENCE_LIMITS,
  EvidenceValidationError,
  matchCapabilities,
  mergeCapabilityCatalogs,
  parseCapabilityCatalog,
  parseEstateManifest,
  parseRepositoryActivity,
  priorityBasisPoints,
  repositoryCorroboration,
} from './rapter-clever-girl-context.mjs';
import {
  validateObserveReportShape,
  validateRepairSidecarShape,
} from './rapter-clever-girl-schema-validator.mjs';

const SCHEMA_VERSION_V2 = 'rapter-clever-girl.observe.v2';
const SCHEMA_VERSION_V3 = 'rapter-clever-girl.observe.v3';
const REPAIR_SIDECAR_SCHEMA_VERSION =
  'rapter-clever-girl.repair-assignments.v1';
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
const MAX_EVIDENCE_PER_CANDIDATE = 20;

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

export const REPAIR_FACETS = Object.freeze([
  'access-recovery',
  'dependency-recovery',
  'configuration-recovery',
  'environment-bootstrap',
  'deployment-recovery',
  'runtime-recovery',
  'filesystem-recovery',
  'tool-integration-recovery',
  'diagnostic-recovery',
]);

export const REPAIR_DOMAINS = Object.freeze([
  'identity-access',
  'dependencies',
  'configuration',
  'developer-environment',
  'ci-build',
  'deployment',
  'runtime-service',
  'filesystem',
  'developer-tooling',
  'general-workflow',
]);

const REPAIR_FACET_LABELS = Object.freeze({
  'access-recovery': 'access recovery',
  'dependency-recovery': 'dependency recovery',
  'configuration-recovery': 'configuration recovery',
  'environment-bootstrap': 'environment bootstrap',
  'deployment-recovery': 'deployment recovery',
  'runtime-recovery': 'runtime recovery',
  'filesystem-recovery': 'filesystem recovery',
  'tool-integration-recovery': 'tool integration recovery',
  'diagnostic-recovery': 'diagnostic recovery',
});

const REPAIR_DOMAIN_LABELS = Object.freeze({
  'identity-access': 'identity and access',
  dependencies: 'dependency management',
  configuration: 'configuration',
  'developer-environment': 'developer environments',
  'ci-build': 'CI and build',
  deployment: 'deployment',
  'runtime-service': 'runtime services',
  filesystem: 'filesystem operations',
  'developer-tooling': 'developer tooling',
  'general-workflow': 'general workflows',
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
    activityInputs: [],
    capabilityCatalogs: [],
    estateManifest: null,
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
    facetSidecarOutput: null,
    reportVersion: '2',
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
      '--activity',
      '--capability-catalog',
      '--estate-manifest',
      '--skills-root',
      '--source',
      '--since',
      '--until',
      '--min-sessions',
      '--min-days',
      '--output',
      '--facet-sidecar-output',
      '--report-version',
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
    if (option === '--activity') {
      if (value === '-') {
        throw new CliError(
          'INVALID_ACTIVITY_INPUT',
          'Configuration error: --activity must explicitly name a source file.',
        );
      }
      options.activityInputs.push(value);
      continue;
    }
    if (option === '--capability-catalog') {
      if (value === '-') {
        throw new CliError(
          'INVALID_CAPABILITY_CATALOG',
          'Configuration error: --capability-catalog must explicitly name a source file.',
        );
      }
      options.capabilityCatalogs.push(value);
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
      case '--estate-manifest':
        if (value === '-') {
          throw new CliError(
            'INVALID_ESTATE_MANIFEST',
            'Configuration error: --estate-manifest must explicitly name a source file.',
          );
        }
        options.estateManifest = value;
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
      case '--facet-sidecar-output':
        if (value === '-') {
          throw new CliError(
            'INVALID_SIDECAR_OUTPUT',
            'Configuration error: --facet-sidecar-output must explicitly name a file.',
          );
        }
        options.facetSidecarOutput = value;
        break;
      case '--report-version':
        if (!['auto', '2', '3'].includes(value)) {
          throw new CliError(
            'INVALID_REPORT_VERSION',
            'Configuration error: --report-version must be auto, 2, or 3.',
          );
        }
        options.reportVersion = value;
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
  for (const [values, maximum, option] of [
    [options.inputs, EVIDENCE_LIMITS.maximumInputs, '--input'],
    [options.activityInputs, EVIDENCE_LIMITS.maximumActivityInputs, '--activity'],
    [
      options.capabilityCatalogs,
      EVIDENCE_LIMITS.maximumCapabilityCatalogs,
      '--capability-catalog',
    ],
    [options.skillsRoots, EVIDENCE_LIMITS.maximumSkillsRoots, '--skills-root'],
  ]) {
    if (values.length > maximum) {
      throw new CliError(
        'TOO_MANY_INPUTS',
        `Configuration error: ${option} exceeds its supported count.`,
      );
    }
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
  if (options.reportVersion === '2' && options.facetSidecarOutput !== null) {
    throw new CliError(
      'SIDECAR_REQUIRES_V3',
      'Configuration error: --facet-sidecar-output requires report version 3 or auto.',
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
export function parseHistoryBytes(bytes, options = {}) {
  const maximumRecords =
    Number.isSafeInteger(options.maximumRecords) && options.maximumRecords >= 0
      ? options.maximumRecords
      : EVIDENCE_LIMITS.maximumRecordsPerSource;
  let text;
  try {
    text = decodeHistoryBytes(bytes);
  } catch {
    return {
      format: 'unknown',
      records: [],
      skippedRecords: 1,
      attemptedRecords: 1,
      issues: [{ code: 'INVALID_UTF8', count: 1 }],
    };
  }

  if (text.trim().length === 0) {
    return {
      format: 'unknown',
      records: [],
      skippedRecords: 1,
      attemptedRecords: 0,
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
        attemptedRecords: 1,
        issues: [{ code: 'EMPTY_CONTAINER', count: 1 }],
      };
    }
    const acceptedValues = values.slice(0, maximumRecords);
    const limitedRecords = Math.max(0, values.length - acceptedValues.length);
    return {
      format: 'json',
      records: acceptedValues.map((value, index) => ({ ordinal: index + 1, value })),
      skippedRecords: limitedRecords,
      attemptedRecords: acceptedValues.length,
      issues:
        limitedRecords > 0
          ? [{ code: 'RECORD_LIMIT_REACHED', count: limitedRecords }]
          : [],
    };
  } catch {
    // A failed whole-document parse is expected for JSONL and is not itself a
    // skipped record. Each malformed nonblank JSONL row is counted below.
  }

  const records = [];
  let malformedRecords = 0;
  let limitedRecords = 0;
  let attemptedOrdinal = 0;
  let attemptedRecords = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    attemptedOrdinal += 1;
    if (attemptedRecords >= maximumRecords) {
      limitedRecords += 1;
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      const values = Array.isArray(parsed) ? parsed : [parsed];
      if (values.length === 0) {
        attemptedRecords += 1;
        malformedRecords += 1;
        continue;
      }
      for (const value of values) {
        if (attemptedRecords < maximumRecords) {
          attemptedRecords += 1;
          records.push({ ordinal: attemptedOrdinal, value });
        } else {
          limitedRecords += 1;
        }
      }
    } catch {
      attemptedRecords += 1;
      malformedRecords += 1;
    }
  }

  let skippedRecords = malformedRecords + limitedRecords;
  if (records.length === 0 && skippedRecords === 0) skippedRecords = 1;
  const issues = [];
  if (malformedRecords > 0) {
    issues.push({
      code: records.length === 0 && limitedRecords === 0
        ? 'UNPARSEABLE_INPUT'
        : 'MALFORMED_RECORDS',
      count: malformedRecords,
    });
  }
  if (limitedRecords > 0) {
    issues.push({ code: 'RECORD_LIMIT_REACHED', count: limitedRecords });
  }
  return {
    format: 'jsonl',
    records,
    skippedRecords,
    attemptedRecords,
    issues,
  };
}

function appendKnownText(value, state, depth = 0) {
  if (value === null || value === undefined) {
    return;
  }
  if (state.characters >= MAX_TEXT_CHARS || depth > 6) {
    state.truncated = true;
    return;
  }
  if (typeof value === 'string') {
    const remaining = MAX_TEXT_CHARS - state.characters;
    const selected = value.slice(0, remaining);
    state.parts.push(selected);
    state.characters += selected.length;
    if (selected.length < value.length) state.truncated = true;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) appendKnownText(item, state, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const key of ['text', 'content', 'message', 'input_text', 'output_text']) {
    if (own(value, key)) appendKnownText(value[key], state, depth + 1);
  }
}

function textFromWithStatus(...values) {
  const state = { parts: [], characters: 0, truncated: false };
  for (const value of values) appendKnownText(value, state);
  return {
    text: state.parts.join('\n').slice(0, MAX_TEXT_CHARS),
    truncated: state.truncated,
  };
}

function textFrom(...values) {
  return textFromWithStatus(...values).text;
}

function hashTokensWithStatus(text) {
  const tokens = text
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,31}/gu);
  if (!tokens) return { hashes: [], truncated: false };
  const hashes = new Set();
  for (const token of tokens) {
    if (!TOKEN_STOP_WORDS.has(token)) hashes.add(sha256(`token-v1:${token}`).slice(0, 20));
    if (hashes.size >= 128) break;
  }
  const uniqueTokens = new Set(tokens.filter((token) => !TOKEN_STOP_WORDS.has(token)));
  return {
    hashes: [...hashes].sort(),
    truncated: uniqueTokens.size > hashes.size,
  };
}

function hashTokens(text) {
  return hashTokensWithStatus(text).hashes;
}

function closedRepairFacetDomain(lower, signals) {
  const access =
    /\b(?:auth(?:enticate|entication|orization)?|login|sign[ -]?in|permission|denied|credential|token|access)\b/.test(
      lower,
    );
  const dependency =
    /\b(?:dependenc(?:y|ies)|package|module|library|install|installer|reinstall|version conflict)\b/.test(
      lower,
    );
  const configuration =
    /\b(?:config(?:ure|uration)?|setting|environment variable|env var|profile|preference)\b/.test(
      lower,
    );
  const bootstrap =
    /\b(?:setup|set up|bootstrap|first[- ]run|first time|environment|prerequisite)\b/.test(
      lower,
    );
  const deployment =
    /\b(?:deploy(?:ment)?|pipeline|release|publish|rollout)\b/.test(lower);
  const runtime =
    /\b(?:runtime|service|server|daemon|process|startup|start(?:ing|ed)?|launch(?:ing|ed)?|restart|timeout|stuck|stall(?:ed|ing)?|crash(?:ed|ing)?)\b/.test(
      lower,
    );
  const filesystem =
    /\b(?:file|path|directory|folder|disk|volume|workspace|worktree)\b/.test(lower);
  const tooling =
    /\b(?:tool|cli|command|shell|terminal|plugin|extension|integration)\b/.test(lower);
  const build = /\b(?:build|compile|typecheck|type-check|lint|test|ci)\b/.test(lower);
  const genericRepetition =
    /\b(?:again|repeat(?:ed|ing)?|recurr(?:ed|ing)?|keeps?|every time)\b/.test(lower);

  let facet;
  if (access) facet = 'access-recovery';
  else if (dependency) facet = 'dependency-recovery';
  else if (configuration) facet = 'configuration-recovery';
  else if (bootstrap) facet = 'environment-bootstrap';
  else if (deployment) facet = 'deployment-recovery';
  else if (runtime) facet = 'runtime-recovery';
  else if (filesystem) facet = 'filesystem-recovery';
  else if (tooling) facet = 'tool-integration-recovery';
  else facet = 'diagnostic-recovery';

  let domain;
  if (access) domain = 'identity-access';
  else if (dependency) domain = 'dependencies';
  else if (configuration) domain = 'configuration';
  else if (build) domain = 'ci-build';
  else if (deployment) domain = 'deployment';
  else if (runtime) domain = 'runtime-service';
  else if (filesystem) domain = 'filesystem';
  else if (tooling) domain = 'developer-tooling';
  else if (bootstrap) domain = 'developer-environment';
  else domain = 'general-workflow';

  const hasSpecificSignal =
    access ||
    dependency ||
    configuration ||
    bootstrap ||
    deployment ||
    runtime ||
    filesystem ||
    tooling;
  const genericControl =
    !hasSpecificSignal &&
    (signals.review || build || genericRepetition || signals.verification);
  const setupCandidate =
    !genericControl &&
    [
      'access-recovery',
      'dependency-recovery',
      'configuration-recovery',
      'environment-bootstrap',
    ].includes(facet);
  return { facet, domain, genericControl, setupCandidate };
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

  const repair =
    (setup && (failure || repairAction)) || (failure && repairAction);
  const repairAssignment = repair
    ? closedRepairFacetDomain(lower, { review, verification })
    : null;
  const workflowSignal =
    setup || failure || repairAction || review || deliverySignals >= 2 || correction;
  const tokenResult = hashTokensWithStatus(normalized);
  return {
    isControl: CONTROL_MESSAGE_RE.test(normalized),
    repair,
    repairFacet: repairAssignment?.facet ?? null,
    repairDomain: repairAssignment?.domain ?? null,
    genericRepairControl: repairAssignment?.genericControl ?? false,
    setupCandidate: repairAssignment?.setupCandidate ?? false,
    review,
    delivery: deliverySignals >= 2,
    correction,
    correctionTopics: [...new Set(correctionTopics)].sort(),
    verificationOnly: intentionalVerification || (verification && !workflowSignal),
    tokenHashes: tokenResult.hashes,
    limitCodes: tokenResult.truncated ? ['TOKEN_LIMIT_REACHED'] : [],
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

export async function readHandleBounded(
  handle,
  maximumBytes,
  tooLargeCode,
  changedCode = 'SOURCE_CHANGED_DURING_READ',
  hooks = {},
) {
  const before = await handle.stat();
  if (
    (Number.isSafeInteger(hooks.expectedSize) &&
      before.size !== hooks.expectedSize) ||
    !Number.isSafeInteger(before.size) ||
    before.size > maximumBytes
  ) {
    if (
      Number.isSafeInteger(hooks.expectedSize) &&
      before.size !== hooks.expectedSize
    ) {
      throw new SafeReadError(changedCode);
    }
    throw new SafeReadError(tooLargeCode);
  }
  if (typeof hooks.afterStat === 'function') await hooks.afterStat();

  const buffer = Buffer.alloc(before.size + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const after = await handle.stat();
  if (
    offset !== before.size ||
    after.size !== before.size ||
    String(before.dev) !== String(after.dev) ||
    String(before.ino) !== String(after.ino)
  ) {
    throw new SafeReadError(changedCode);
  }
  return buffer.subarray(0, offset);
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
  textTruncated = false,
}) {
  const parsedTimestamp = normalizedTimestamp(timestamp);
  if (parsedTimestamp.invalid) return { errorCode: 'INVALID_TIMESTAMP' };
  const safeText = typeof text === 'string' ? text.slice(0, MAX_TEXT_CHARS) : '';
  const classifiedFeatures = classifyText(safeText);
  const limitCodes = [
    ...(textTruncated ? ['TEXT_LIMIT_REACHED'] : []),
    ...classifiedFeatures.limitCodes,
  ];
  const { limitCodes: _limitCodes, ...features } = classifiedFeatures;
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
    issues: [...new Set(limitCodes)].sort(),
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
    const userText = textFromWithStatus(record.user_message);
    const assistantText = textFromWithStatus(record.assistant_response);
    if (userText.text.length > 0) {
      specs.push({
        sessionId,
        timestamp,
        role: 'user',
        kind: 'message',
        text: userText.text,
        textTruncated: userText.truncated,
      });
    }
    if (assistantText.text.length > 0) {
      specs.push({
        sessionId,
        timestamp,
        role: 'assistant',
        kind: 'message',
        text: assistantText.text,
        textTruncated: assistantText.truncated,
      });
    }
  } else if (adapter === 'claude') {
    const type = record.type;
    const content = textFromWithStatus(record.message, record.content, record.toolUseResult);
    specs.push({
      sessionId: record.sessionId,
      timestamp: record.timestamp,
      role: roleFrom(type, valueFor(record.message, 'role'), valueFor(record.content, 'role')),
      kind: type,
      text: content.text,
      textTruncated: content.truncated,
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
    const content = textFromWithStatus(
      valueFor(payload, 'message', 'content', 'text', 'input', 'output'),
    );
    specs.push({
      sessionId: codexSessionId,
      timestamp: record.timestamp,
      role: roleFrom(record.type, valueFor(payload, 'role', 'type')),
      kind: `${record.type} ${String(valueFor(payload, 'type') ?? '')}`,
      text: content.text,
      textTruncated: content.truncated,
      toolName:
        valueFor(payload, 'toolName', 'tool_name', 'name') ?? toolNameFromContent(payload),
      status: valueFor(payload, 'status', 'result_status'),
      durationMs: valueFor(payload, 'durationMs', 'duration_ms'),
    });
  } else if (adapter === 'openrappter') {
    const payload = record.payload;
    const content = textFromWithStatus(valueFor(payload, 'content', 'message', 'text'));
    specs.push({
      sessionId: record.sessionId,
      timestamp: record.timestamp,
      role: roleFrom(valueFor(payload, 'role'), record.kind, record.toolName),
      kind: record.kind,
      text: content.text,
      textTruncated: content.truncated,
      toolName: record.toolName ?? valueFor(payload, 'toolName', 'tool_name'),
      status: record.status,
      durationMs: record.durationMs,
    });
  } else {
    const role = valueFor(record, 'role', 'actor', 'type');
    const kind = valueFor(record, 'kind', 'eventType', 'event_type', 'type');
    const content = textFromWithStatus(
      valueFor(record, 'content', 'text', 'message', 'user_message', 'assistant_response'),
    );
    specs.push({
      sessionId: valueFor(record, 'sessionId', 'session_id'),
      timestamp: valueFor(record, 'timestamp', 'time'),
      role: roleFrom(role, kind),
      kind,
      text: content.text,
      textTruncated: content.truncated,
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
  const issues = [];
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
    issues.push(...result.issues);
  }
  return {
    sourceType: adapter,
    records,
    errorCode: null,
    issues: [...new Set(issues)].sort(),
  };
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

async function collectSkillFiles(root, state, depth = 0) {
  if (state.traversalStopped) return;
  if (depth > EVIDENCE_LIMITS.maximumSkillDepth) {
    state.diagnostics.push({ code: 'SKILL_DEPTH_LIMIT_REACHED', count: 1 });
    state.skippedEntries += 1;
    return;
  }
  if (state.files.length >= EVIDENCE_LIMITS.maximumCapabilityEntries) {
    state.diagnostics.push({ code: 'SKILL_ENTRY_LIMIT_REACHED', count: 1 });
    state.skippedEntries += 1;
    return;
  }
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
  if (state.visitedDirectories >= EVIDENCE_LIMITS.maximumSkillDirectories) {
    state.diagnostics.push({ code: 'SKILL_DIRECTORY_LIMIT_REACHED', count: 1 });
    state.skippedEntries += 1;
    state.traversalStopped = true;
    return;
  }
  state.visitedDirectories += 1;

  let entries;
  let directoryHandle;
  try {
    const noFollow = FS_CONSTANTS.O_NOFOLLOW ?? 0;
    const directoryFlag = FS_CONSTANTS.O_DIRECTORY ?? 0;
    directoryHandle = await open(
      root,
      FS_CONSTANTS.O_RDONLY | noFollow | directoryFlag,
    );
    const openedDirectory = await directoryHandle.stat();
    entries = [];
    const directory = await opendir(root);
    for await (const entry of directory) {
      if (state.visitedEntries >= EVIDENCE_LIMITS.maximumSkillEntries) {
        state.diagnostics.push({ code: 'SKILL_ENTRY_LIMIT_REACHED', count: 1 });
        state.skippedEntries += 1;
        state.traversalStopped = true;
        return;
      }
      state.visitedEntries += 1;
      entries.push(entry);
    }
    const currentDirectory = await lstat(root);
    if (
      currentDirectory.isSymbolicLink() ||
      !currentDirectory.isDirectory() ||
      String(openedDirectory.dev) !== String(currentDirectory.dev) ||
      String(openedDirectory.ino) !== String(currentDirectory.ino)
    ) {
      state.diagnostics.push({ code: 'SKILL_DIRECTORY_CHANGED_DURING_READ', count: 1 });
      state.skippedEntries += 1;
      return;
    }
  } catch {
    state.diagnostics.push({ code: 'SKILLS_ROOT_UNREADABLE', count: 1 });
    state.skippedEntries += 1;
    return;
  } finally {
    if (directoryHandle) await directoryHandle.close().catch(() => {});
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const child = resolve(root, entry.name);
    if (entry.isSymbolicLink()) {
      state.diagnostics.push({ code: 'SKILLS_SYMLINK_SKIPPED', count: 1 });
      state.skippedEntries += 1;
    } else if (entry.isDirectory()) {
      await collectSkillFiles(child, state, depth + 1);
      if (state.traversalStopped) return;
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
  const state = {
    files: [],
    diagnostics: [],
    skippedEntries: 0,
    visitedDirectories: 0,
    visitedEntries: 0,
    metadataBytes: 0,
    traversalStopped: false,
    metadataLimitReached: false,
    scopeRoots: [],
  };
  for (const root of explicitRoots) {
    try {
      const stats = await lstat(root);
      if (!stats.isSymbolicLink()) {
        state.scopeRoots.push(pathKey(await realpath(root)));
      }
    } catch {
      // collectSkillFiles emits the redacted diagnostic for unavailable roots.
    }
  }
  for (const root of explicitRoots) await collectSkillFiles(root, state);
  state.files.sort((left, right) => left.localeCompare(right, 'en'));

  const skills = [];
  for (const file of state.files) {
    if (state.metadataLimitReached) break;
    let handle;
    try {
      const canonicalBefore = pathKey(await realpath(file));
      if (!state.scopeRoots.some((root) => pathIsWithin(canonicalBefore, root))) {
        throw new SafeReadError('SKILL_SCOPE_ESCAPE_REFUSED');
      }
      handle = await openRegularFileNoFollow(file, {
        symlinkCode: 'SKILL_SYMLINK_SKIPPED',
        notFileCode: 'SKILLS_FILE_UNSUPPORTED',
        changedCode: 'SKILL_CHANGED_DURING_OPEN',
        readCode: 'SKILL_READ_FAILED',
      });
      const stats = await handle.stat();
      if (
        !Number.isSafeInteger(stats.size) ||
        stats.size > EVIDENCE_LIMITS.maximumMetadataBytes
      ) {
        throw new SafeReadError('SKILL_FILE_TOO_LARGE');
      }
      const reservedBytes = stats.size + 1;
      if (
        state.metadataBytes + reservedBytes >
        EVIDENCE_LIMITS.maximumSkillMetadataBytes
      ) {
        throw new SafeReadError('SKILL_TOTAL_BYTES_LIMIT_REACHED');
      }
      state.metadataBytes += reservedBytes;
      const remainingBytes =
        EVIDENCE_LIMITS.maximumSkillMetadataBytes -
        (state.metadataBytes - reservedBytes);
      const bytes = await readHandleBounded(
        handle,
        Math.min(EVIDENCE_LIMITS.maximumMetadataBytes, remainingBytes),
        stats.size > EVIDENCE_LIMITS.maximumMetadataBytes
          ? 'SKILL_FILE_TOO_LARGE'
          : 'SKILL_TOTAL_BYTES_LIMIT_REACHED',
        'SKILL_CHANGED_DURING_READ',
        { expectedSize: stats.size },
      );
      const pathStats = await lstat(file);
      const handleStats = await handle.stat();
      const canonicalAfter = pathKey(await realpath(file));
      if (
        pathStats.isSymbolicLink() ||
        String(pathStats.dev) !== String(handleStats.dev) ||
        String(pathStats.ino) !== String(handleStats.ino) ||
        canonicalAfter !== canonicalBefore ||
        !state.scopeRoots.some((root) => pathIsWithin(canonicalAfter, root))
      ) {
        throw new SafeReadError('SKILL_CHANGED_DURING_READ');
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const frontmatter = parseSkillFrontmatter(text);
      if (!frontmatter) {
        state.diagnostics.push({ code: 'SKILL_FRONTMATTER_INVALID', count: 1 });
        state.skippedEntries += 1;
        continue;
      }
      const safeName = safeSkillName(frontmatter.name);
      const derivedText = `${frontmatter.name}\n${frontmatter.description}`;
      const skillId = `capability-${sha256(
        `skill-v2:${safeName}:${sha256(bytes)}`,
      ).slice(0, 16)}`;
      skills.push({
        name: safeName,
        skillId,
        capabilityId: skillId,
        topics: skillTopics(derivedText),
        tokenHashes: hashTokens(derivedText),
        sourceTypes: ['skill-root'],
        sourceIds: [`source-${sha256(`skill-source-v1:${sha256(bytes)}`).slice(0, 12)}`],
        contractQualified: false,
        contractVersion: null,
        contractTestCount: 0,
      });
    } catch (error) {
      if (
        error instanceof SafeReadError &&
        error.code === 'SKILL_TOTAL_BYTES_LIMIT_REACHED'
      ) {
        state.metadataLimitReached = true;
      }
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
    coverage:
      explicitRoots.length === 0
        ? 'none'
        : state.skippedEntries > 0
          ? 'partial'
          : 'complete',
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

function chooseCapabilities(patternType, catalog, events, reportVersion = '2') {
  const capabilities = (
    Array.isArray(catalog?.capabilities)
      ? catalog.capabilities
      : Array.isArray(catalog?.skills)
        ? catalog.skills
        : []
  ).filter((capability) => capability.name !== 'rapter-clever-girl-observe');
  const candidateTokens = [
    ...new Set(events.flatMap((event) => event.features?.tokenHashes ?? [])),
  ].sort();
  return matchCapabilities(patternType, capabilities, candidateTokens, {
    requireBehavioralContract: reportVersion === '3',
  });
}

function classificationFor(patternType, capabilityMatches, catalogCoverage) {
  if (patternType === 'repair-loop') return 'root-cause-fix';
  const capability = capabilityMatches[0] ?? null;
  if (
    capabilityMatches.length >= 2 &&
    capabilityMatches[0].match === 'reuse' &&
    capabilityMatches[1].match === 'reuse' &&
    capabilityMatches[0].name !== capabilityMatches[1].name
  ) {
    return 'consolidate-existing';
  }
  if (capability?.match === 'reuse') return 'reuse-existing';
  if (capability?.match === 'extend') return 'extend-existing';
  if (capability === null && catalogCoverage !== 'complete') return 'insufficient-evidence';
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

  return finishActiveFriction(evidenceKeys, bySessionDay);
}

function eventKey(event) {
    return `${event.sourceId}:${event.sessionKey}:${event.ordinal}:${event.eventIndex}`;
  }

function repairOccurrenceClusters(candidateEvents, aliases) {
    const grouped = groupEvidence(candidateEvents);
    const assignments = [];
    const clusters = new Map();
    for (const group of grouped) {
      const repairSignals = group.events.filter(
        (event) =>
          event.role === 'user' &&
          event.features?.repair === true &&
          REPAIR_FACETS.includes(event.features?.repairFacet) &&
          REPAIR_DOMAINS.includes(event.features?.repairDomain),
      );
      if (repairSignals.length === 0) continue;
      const pairCounts = new Map();
      for (const event of repairSignals) {
        const pair = `${event.features.repairFacet}:${event.features.repairDomain}`;
        pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
      }
      const [primaryPair] = [...pairCounts.entries()].sort((left, right) => {
        if (left[1] !== right[1]) return right[1] - left[1];
        const [leftFacet, leftDomain] = left[0].split(':');
        const [rightFacet, rightDomain] = right[0].split(':');
        const facetOrder =
          REPAIR_FACETS.indexOf(leftFacet) - REPAIR_FACETS.indexOf(rightFacet);
        if (facetOrder !== 0) return facetOrder;
        return REPAIR_DOMAINS.indexOf(leftDomain) - REPAIR_DOMAINS.indexOf(rightDomain);
      })[0];
      const [facet, domain] = primaryPair.split(':');
      const clusterKey = `${facet}:${domain}`;
      const genericControl = repairSignals.every(
        (event) => event.features.genericRepairControl === true,
      );
      const assignment = {
        assignmentId: `assignment-${sha256(
          `repair-assignment-v1:${group.sourceId}:${group.sessionKey}:${group.day}`,
        ).slice(0, 20)}`,
        sourceId: group.sourceId,
        sessionAlias: aliases.get(group.sessionKey),
        day: group.day,
        facet,
        domain,
        signalEvents: group.events.length,
        duplicateSignals: Math.max(0, group.events.length - 1),
        genericControl,
        group,
        clusterKey,
      };
      assignments.push(assignment);
      if (!clusters.has(clusterKey)) {
        clusters.set(clusterKey, {
          facet,
          domain,
          events: [],
          evidenceGroups: [],
          genericOccurrences: 0,
        });
      }
      const cluster = clusters.get(clusterKey);
      cluster.events.push(...group.events);
      cluster.evidenceGroups.push(group);
      if (genericControl) cluster.genericOccurrences += 1;
    }
    assignments.sort((left, right) =>
      left.assignmentId.localeCompare(right.assignmentId, 'en'));
    return {
      assignments,
      clusters: [...clusters.entries()]
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([clusterKey, cluster]) => ({ clusterKey, ...cluster })),
    };
  }

function splitRepairFriction(assignments, allEvents) {
    const assignmentByEvent = new Map();
    for (const assignment of assignments) {
      for (const event of assignment.group.events) {
        assignmentByEvent.set(eventKey(event), assignment.clusterKey);
      }
    }
    const bySessionDay = new Map();
    for (const event of allEvents) {
      if (event.timestampMs === null || !event.day) continue;
      const key = `${event.sourceId}:${event.sessionKey}:${event.day}`;
      if (!bySessionDay.has(key)) bySessionDay.set(key, []);
      bySessionDay.get(key).push(event);
    }

    const perCluster = new Map();
    let originalLowerSeconds = 0;
    let originalUpperSeconds = 0;
    let measuredIntervals = 0;
    for (const events of bySessionDay.values()) {
      events.sort(compareEvents);
      for (let index = 1; index < events.length; index += 1) {
        const previous = events[index - 1];
        const current = events[index];
        const previousCluster = assignmentByEvent.get(eventKey(previous));
        const currentCluster = assignmentByEvent.get(eventKey(current));
        if (!previousCluster && !currentCluster) continue;
        const rawSeconds = Math.floor((current.timestampMs - previous.timestampMs) / 1000);
        if (rawSeconds < 0) continue;
        const capped = Math.min(rawSeconds, ACTIVE_GAP_CAP_SECONDS);
        const clusterKey = [previousCluster, currentCluster]
          .filter(Boolean)
          .sort((left, right) => left.localeCompare(right, 'en'))[0];
        if (!perCluster.has(clusterKey)) {
          perCluster.set(clusterKey, {
            lowerSeconds: 0,
            upperSeconds: 0,
            measuredIntervals: 0,
          });
        }
        const cluster = perCluster.get(clusterKey);
        cluster.upperSeconds += capped;
        originalUpperSeconds += capped;
        if (previousCluster && currentCluster) {
          cluster.lowerSeconds += capped;
          originalLowerSeconds += capped;
        }
        cluster.measuredIntervals += 1;
        measuredIntervals += 1;
      }
    }

    let unionLowerSeconds = 0;
    let unionUpperSeconds = 0;
    const frictionByCluster = new Map();
    for (const [clusterKey, friction] of perCluster) {
      unionLowerSeconds += friction.lowerSeconds;
      unionUpperSeconds += friction.upperSeconds;
      frictionByCluster.set(clusterKey, {
        lowerSeconds: friction.lowerSeconds,
        upperSeconds: friction.upperSeconds,
        method: 'disjoint-capped-active-interval-union-v1',
        confidence:
          friction.measuredIntervals === 0
            ? 'unavailable'
            : friction.lowerSeconds > 0
              ? 'medium'
              : 'low',
      });
    }
    return {
      frictionByCluster,
      summary: {
        method: 'disjoint-capped-active-interval-union-v1',
        measuredIntervals,
        original: {
          lowerSeconds: originalLowerSeconds,
          upperSeconds: originalUpperSeconds,
        },
        union: {
          lowerSeconds: unionLowerSeconds,
          upperSeconds: unionUpperSeconds,
        },
        overlapSeconds: 0,
        withinOriginalBounds:
          unionLowerSeconds <= originalLowerSeconds &&
          unionUpperSeconds <= originalUpperSeconds,
      },
    };
  }

function finishActiveFriction(evidenceKeys, bySessionDay) {
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
  return groups.slice(0, MAX_EVIDENCE_PER_CANDIDATE).map((group) => {
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
  activityEvents,
  reportVersion = '2',
  facet = null,
  domain = null,
  frictionOverride = null,
  genericOccurrences = 0,
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
  const capabilityMatches = chooseCapabilities(
    patternType,
    catalog,
    events,
    reportVersion,
  );
  const capability = capabilityMatches[0] ?? null;
  const repositoryEvidence = repositoryCorroboration(patternType, activityEvents);
  const ruleId =
    reportVersion === '3' && patternType === 'repair-loop'
      ? 'detector.repair-facet-domain.v1'
      : RULE_IDS[patternType];
  const sourceDistribution = [...new Map(
    evidenceGroups.map((group) => [group.sourceId, 0]),
  )].map(([sourceId]) => ({
    sourceId,
    occurrences: evidenceGroups.filter((group) => group.sourceId === sourceId).length,
  })).sort((left, right) => left.sourceId.localeCompare(right.sourceId, 'en'));
  const dominantSourceOccurrences = Math.max(
    0,
    ...sourceDistribution.map(({ occurrences: count }) => count),
  );
  const promotionBlockers = [];
  if (confidence !== 'high') promotionBlockers.push('recurrence-threshold');
  if (sourceDistribution.length < 2) promotionBlockers.push('single-source');
  if (
    ['reuse-existing', 'extend-existing', 'consolidate-existing'].includes(
      classificationFor(patternType, capabilityMatches, catalog?.coverage ?? 'none'),
    ) &&
    !capabilityMatches.some(({ contractQualified }) => contractQualified === true)
  ) {
    promotionBlockers.push('behavioral-contract-required');
  }
  if (
    reportVersion === '3' &&
    patternType === 'repair-loop' &&
    genericOccurrences === occurrences
  ) {
    promotionBlockers.push('generic-control');
  }
  const candidate = {
    candidateId: `candidate-${sha256(`${patternType}:${clusterKey}`).slice(0, 16)}`,
    label:
      reportVersion === '3' && patternType === 'repair-loop'
        ? `Repeated ${REPAIR_FACET_LABELS[facet]} in ${REPAIR_DOMAIN_LABELS[domain]}`
        : LABELS[patternType],
    patternType,
    classification: classificationFor(
      patternType,
      capabilityMatches,
      catalog?.coverage ?? 'none',
    ),
    confidence,
    occurrences,
    sessions,
    activeDays,
    evidence: makeEvidence(evidenceGroups, aliases, ruleId),
    observedActiveFriction:
      frictionOverride ?? activeFriction(events, allEvents),
    existingCapability:
      capability === null
        ? null
        : reportVersion === '3'
          ? {
              name: capability.name,
              match: capability.match,
              reason: capability.reason,
              contractQualified: capability.contractQualified,
              contractConflict: capability.contractConflict,
              contractVersion: capability.contractVersion,
              contractTestCount: capability.contractTestCount,
              contractDigest: capability.contractDigest,
            }
          : {
            name: capability.name,
            match: capability.match,
            reason: capability.reason,
          },
    capabilityMatches,
    catalogCoverage: catalog?.coverage ?? 'none',
    repositoryEvidence,
    falsePositiveRisks: falsePositiveRisks(patternType),
    _excludedEvidence: Math.max(
      0,
      evidenceGroups.length - MAX_EVIDENCE_PER_CANDIDATE,
    ),
  };
  if (reportVersion === '3') {
    candidate.facet = facet;
    candidate.domain = domain;
    candidate.deduplication = {
      rawSignals: events.length,
      uniqueOccurrences: occurrences,
      duplicateSignals: Math.max(0, events.length - occurrences),
      key: 'source-session-day',
    };
    candidate.sourceSkew = {
      sourceCount: sourceDistribution.length,
      dominantSourceOccurrences,
      dominantSourceBasisPoints:
        occurrences === 0
          ? 0
          : Math.floor((dominantSourceOccurrences * 10_000) / occurrences),
      distribution: sourceDistribution,
    };
    candidate.controlProfile = {
      genericOccurrences,
      setupCandidate:
        patternType === 'repair-loop' &&
        genericOccurrences < occurrences &&
        [
          'access-recovery',
          'dependency-recovery',
          'configuration-recovery',
          'environment-bootstrap',
        ].includes(facet),
    };
    candidate.promotion = {
      eligible: promotionBlockers.length === 0,
      verdict:
        promotionBlockers.length === 0
          ? 'eligible-for-human-review'
          : 'not-eligible',
      blockers: promotionBlockers.sort(),
    };
  }
  candidate.priorityBasisPoints = priorityBasisPoints(candidate, repositoryEvidence);
  return candidate;
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
    candidateCap: 0,
    evidenceItems: 0,
    workLimitEvents: 0,
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

  const correctionEvents = candidateEvents
    .filter((event) => event.role === 'user' && event.features?.correction)
    .sort(compareEvents);
  excluded.workLimitEvents += Math.max(
    0,
    correctionEvents.length - EVIDENCE_LIMITS.maximumCorrectionEvents,
  );
  for (const cluster of correctionClusters(
    correctionEvents.slice(0, EVIDENCE_LIMITS.maximumCorrectionEvents),
  )) {
    definitions.push({
      patternType: 'recurring-correction',
      clusterKey: cluster.key,
      events: cluster.events,
    });
  }

  const orderedToolEvents = candidateEvents
    .filter((event) => event.toolCategory)
    .sort(compareEvents);
  excluded.workLimitEvents += Math.max(
    0,
    orderedToolEvents.length - EVIDENCE_LIMITS.maximumToolEvents,
  );
  const toolDefinitions = toolSequenceClusters(
    orderedToolEvents.slice(0, EVIDENCE_LIMITS.maximumToolEvents),
  );
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
      activityEvents: options.activityEvents ?? [],
    });
    if (candidate) {
      excluded.evidenceItems += candidate._excludedEvidence;
      delete candidate._excludedEvidence;
      candidates.push(candidate);
    }
    else excluded.belowEvidenceThreshold += 1;
  }

  candidates.sort((left, right) => {
    if (left.priorityBasisPoints !== right.priorityBasisPoints) {
      return right.priorityBasisPoints - left.priorityBasisPoints;
    }
    const confidenceOrder = CONFIDENCE_RANK[right.confidence] - CONFIDENCE_RANK[left.confidence];
    if (confidenceOrder !== 0) return confidenceOrder;
    if (left.occurrences !== right.occurrences) return right.occurrences - left.occurrences;
    if (left.sessions !== right.sessions) return right.sessions - left.sessions;
    if (left.activeDays !== right.activeDays) return right.activeDays - left.activeDays;
    return left.candidateId.localeCompare(right.candidateId, 'en');
  });
  excluded.candidateCap = Math.max(0, candidates.length - MAX_CANDIDATES);

  return {
    sessions: sessionKeys.length,
    activeDays: new Set(inWindow.map((event) => event.day).filter(Boolean)).size,
    candidates: candidates.slice(0, MAX_CANDIDATES),
    excluded,
  };
}

/**
 * Mine the v3 closed facet × domain detector without changing v2 semantics.
 */
export function analyzeHistoryV3(records, options = {}) {
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
    candidateCap: 0,
    evidenceItems: 0,
    workLimitEvents: 0,
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
  const repairEvents = candidateEvents.filter(
    (event) =>
      (event.role === 'user' && event.features?.repair) ||
      (event.role === 'tool' &&
        event.statusError &&
        repairContexts.has(
          `${event.sourceId}:${event.sessionKey}:${event.day ?? 'undated'}`,
        )),
  );
  const repairStructure = repairOccurrenceClusters(repairEvents, aliases);
  const repairFriction = splitRepairFriction(
    repairStructure.assignments,
    inWindow,
  );
  const definitions = repairStructure.clusters.map((cluster) => ({
    patternType: 'repair-loop',
    ...cluster,
    explicitEvidenceGroups: cluster.evidenceGroups,
    frictionOverride:
      repairFriction.frictionByCluster.get(cluster.clusterKey) ?? {
        lowerSeconds: 0,
        upperSeconds: 0,
        method: 'disjoint-capped-active-interval-union-v1',
        confidence: 'unavailable',
      },
  }));
  definitions.push(
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
  );

  const correctionEvents = candidateEvents
    .filter((event) => event.role === 'user' && event.features?.correction)
    .sort(compareEvents);
  excluded.workLimitEvents += Math.max(
    0,
    correctionEvents.length - EVIDENCE_LIMITS.maximumCorrectionEvents,
  );
  for (const cluster of correctionClusters(
    correctionEvents.slice(0, EVIDENCE_LIMITS.maximumCorrectionEvents),
  )) {
    definitions.push({
      patternType: 'recurring-correction',
      clusterKey: cluster.key,
      events: cluster.events,
    });
  }

  const orderedToolEvents = candidateEvents
    .filter((event) => event.toolCategory)
    .sort(compareEvents);
  excluded.workLimitEvents += Math.max(
    0,
    orderedToolEvents.length - EVIDENCE_LIMITS.maximumToolEvents,
  );
  for (const sequence of toolSequenceClusters(
    orderedToolEvents.slice(0, EVIDENCE_LIMITS.maximumToolEvents),
  )) {
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
      activityEvents: options.activityEvents ?? [],
      reportVersion: '3',
    });
    if (candidate) {
      excluded.evidenceItems += candidate._excludedEvidence;
      delete candidate._excludedEvidence;
      candidates.push(candidate);
    } else {
      excluded.belowEvidenceThreshold += 1;
    }
  }

  candidates.sort((left, right) => {
    if (left.priorityBasisPoints !== right.priorityBasisPoints) {
      return right.priorityBasisPoints - left.priorityBasisPoints;
    }
    const confidenceOrder =
      CONFIDENCE_RANK[right.confidence] - CONFIDENCE_RANK[left.confidence];
    if (confidenceOrder !== 0) return confidenceOrder;
    if (left.occurrences !== right.occurrences) return right.occurrences - left.occurrences;
    if (left.sessions !== right.sessions) return right.sessions - left.sessions;
    if (left.activeDays !== right.activeDays) return right.activeDays - left.activeDays;
    return left.candidateId.localeCompare(right.candidateId, 'en');
  });
  excluded.candidateCap = Math.max(0, candidates.length - MAX_CANDIDATES);

  const safeAssignments = repairStructure.assignments.map((assignment) => ({
    assignmentId: assignment.assignmentId,
    sourceId: assignment.sourceId,
    sessionAlias: assignment.sessionAlias,
    day: assignment.day,
    facet: assignment.facet,
    domain: assignment.domain,
    signalEvents: assignment.signalEvents,
    duplicateSignals: assignment.duplicateSignals,
    genericControl: assignment.genericControl,
  }));
  return {
    sessions: sessionKeys.length,
    activeDays: new Set(inWindow.map((event) => event.day).filter(Boolean)).size,
    candidates: candidates.slice(0, MAX_CANDIDATES),
    excluded,
    detector: {
      facetTaxonomyVersion: 'closed-repair-facets.v1',
      domainTaxonomyVersion: 'closed-repair-domains.v1',
      eligibleRepairOccurrences: safeAssignments.length,
      assignedRepairOccurrences: safeAssignments.length,
      unassignedRepairOccurrences: 0,
      rawRepairSignals: repairEvents.length,
      duplicateRepairSignals: Math.max(0, repairEvents.length - safeAssignments.length),
      facetDomainClusterCount: repairStructure.clusters.length,
      facetDomainDistribution: repairStructure.clusters.map(
        ({ facet, domain, events, evidenceGroups, genericOccurrences }) => ({
          facet,
          domain,
          occurrences: evidenceGroups.length,
          rawSignals: events.length,
          genericOccurrences,
        }),
      ),
      splitFriction: repairFriction.summary,
    },
    repairAssignments: safeAssignments,
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
  if (stage === 'estate') {
    return 'The explicitly selected estate manifest was invalid, incomplete, or unreadable.';
  }
  if (stage === 'catalog') {
    return 'An explicitly selected capability catalog was invalid, incomplete, or unreadable.';
  }
  if (stage === 'activity') {
    return 'An explicitly selected repository activity source was invalid, incomplete, or unreadable.';
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

async function readSource(input, requestedSource, seenDigests, maximumRecords) {
  let handle;
  let bytes;
  let readFailureCode = 'SOURCE_READ_FAILED';
  try {
    handle = await openRegularFileNoFollow(input);
    bytes = await readHandleBounded(
      handle,
      EVIDENCE_LIMITS.maximumSourceBytes,
      'SOURCE_TOO_LARGE',
      'SOURCE_CHANGED_DURING_READ',
    );
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
      attemptedRecords: 0,
    };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }

  const digest = sha256(bytes);
  if (seenDigests.has(digest)) {
    return {
      duplicate: true,
      source: null,
      events: [],
      diagnostics: [],
      attemptedRecords: 0,
    };
  }
  seenDigests.add(digest);
  const sourceId = `source-${sha256(`source-v2:${digest}`).slice(0, 12)}`;
  const parsed = parseHistoryBytes(bytes, { maximumRecords });
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
    for (const code of normalized.issues ?? []) {
      normalizationIssues.push({ code, count: 1 });
    }
  }

  const status =
    acceptedRecords === 0
      ? 'failed'
      : skippedRecords > 0 || normalizationIssues.length > 0
        ? 'partial'
        : 'ok';
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
  return {
    source,
    events,
    diagnostics,
    attemptedRecords: parsed.attemptedRecords,
  };
}

function totalRecordLimitResult(input, requestedSource) {
  const source = {
    sourceId: `source-${sha256(`record-limit-v1:${String(input)}`).slice(0, 12)}`,
    sourceType: requestedSource,
    sourceDigest: `sha256:${sha256(Buffer.alloc(0))}`,
    status: 'failed',
    acceptedRecords: 0,
    skippedRecords: 1,
  };
  return {
    source,
    events: [],
    diagnostics: [
      reportDiagnostic(source, 'failed', 'parse', 'TOTAL_RECORD_LIMIT_REACHED'),
    ],
    attemptedRecords: 0,
  };
}

async function readContextBytes(input, {
  maximumBytes = EVIDENCE_LIMITS.maximumMetadataBytes,
  tooLargeCode,
  symlinkCode,
  notFileCode,
  changedCode,
  readChangedCode,
  readCode,
}) {
  let handle;
  try {
    handle = await openRegularFileNoFollow(input, {
      symlinkCode,
      notFileCode,
      changedCode,
      readCode,
    });
    return await readHandleBounded(
      handle,
      maximumBytes,
      tooLargeCode,
      readChangedCode,
    );
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function failedContextSummary(input, sourceType, fields = {}) {
  return {
    sourceId: `source-${sha256(`context-failure-v1:${sourceType}:${String(input)}`).slice(0, 12)}`,
    sourceType,
    sourceDigest: `sha256:${sha256(Buffer.alloc(0))}`,
    status: 'failed',
    acceptedRecords: 0,
    skippedRecords: 1,
    ...fields,
  };
}

function decodeJsonBytes(bytes, code) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new EvidenceValidationError(code);
  }
}

async function readEstateContext(input) {
  try {
    const bytes = await readContextBytes(input, {
      tooLargeCode: 'ESTATE_MANIFEST_TOO_LARGE',
      symlinkCode: 'ESTATE_MANIFEST_SYMLINK_REFUSED',
      notFileCode: 'ESTATE_MANIFEST_NOT_FILE',
      changedCode: 'ESTATE_MANIFEST_CHANGED_DURING_OPEN',
      readChangedCode: 'ESTATE_MANIFEST_CHANGED_DURING_READ',
      readCode: 'ESTATE_MANIFEST_READ_FAILED',
    });
    const digest = sha256(bytes);
    const sourceId = `source-${sha256(`estate-v1:${digest}`).slice(0, 12)}`;
    const parsed = parseEstateManifest(
      decodeJsonBytes(bytes, 'ESTATE_MANIFEST_INVALID'),
      { sourceId, sourceDigest: `sha256:${digest}` },
    );
    const diagnostics =
      parsed.summary.status === 'partial'
        ? [reportDiagnostic(parsed.summary, 'partial', 'estate', 'ESTATE_MANIFEST_PARTIAL')]
        : [];
    return { ...parsed, diagnostics };
  } catch (error) {
    const summary = failedContextSummary(input, 'rapp-monorepo-manifest', {
      schema: null,
      snapshotAt: null,
      repositoryCount: 0,
      withheldFiles: 0,
      skippedLargeFiles: 0,
    });
    const code =
      error instanceof SafeReadError || error instanceof EvidenceValidationError
        ? error.code
        : 'ESTATE_MANIFEST_READ_FAILED';
    return {
      summary,
      capabilities: [],
      diagnostics: [reportDiagnostic(summary, 'failed', 'estate', code)],
    };
  }
}

async function readCapabilityContext(input, seenDigests) {
  try {
    const bytes = await readContextBytes(input, {
      tooLargeCode: 'CAPABILITY_CATALOG_TOO_LARGE',
      symlinkCode: 'CAPABILITY_CATALOG_SYMLINK_REFUSED',
      notFileCode: 'CAPABILITY_CATALOG_NOT_FILE',
      changedCode: 'CAPABILITY_CATALOG_CHANGED_DURING_OPEN',
      readChangedCode: 'CAPABILITY_CATALOG_CHANGED_DURING_READ',
      readCode: 'CAPABILITY_CATALOG_READ_FAILED',
    });
    const digest = sha256(bytes);
    if (seenDigests.has(digest)) {
      return { duplicate: true, summary: null, capabilities: [], diagnostics: [] };
    }
    seenDigests.add(digest);
    const sourceId = `source-${sha256(`catalog-v1:${digest}`).slice(0, 12)}`;
    const parsed = parseCapabilityCatalog(
      decodeJsonBytes(bytes, 'CAPABILITY_CATALOG_INVALID'),
      { sourceId, sourceDigest: `sha256:${digest}` },
    );
    const diagnostics =
      parsed.summary.status === 'partial'
        ? [reportDiagnostic(parsed.summary, 'partial', 'catalog', 'CAPABILITY_CATALOG_PARTIAL')]
        : [];
    return { ...parsed, diagnostics };
  } catch (error) {
    const summary = failedContextSummary(input, 'capability-catalog', { schema: null });
    const code =
      error instanceof SafeReadError || error instanceof EvidenceValidationError
        ? error.code
        : 'CAPABILITY_CATALOG_READ_FAILED';
    return {
      duplicate: false,
      summary,
      capabilities: [],
      diagnostics: [reportDiagnostic(summary, 'failed', 'catalog', code)],
    };
  }
}

async function readActivityContext(input, seenDigests) {
  try {
    const bytes = await readContextBytes(input, {
      maximumBytes: EVIDENCE_LIMITS.maximumSourceBytes,
      tooLargeCode: 'REPOSITORY_ACTIVITY_TOO_LARGE',
      symlinkCode: 'REPOSITORY_ACTIVITY_SYMLINK_REFUSED',
      notFileCode: 'REPOSITORY_ACTIVITY_NOT_FILE',
      changedCode: 'REPOSITORY_ACTIVITY_CHANGED_DURING_OPEN',
      readChangedCode: 'REPOSITORY_ACTIVITY_CHANGED_DURING_READ',
      readCode: 'REPOSITORY_ACTIVITY_READ_FAILED',
    });
    const digest = sha256(bytes);
    if (seenDigests.has(digest)) {
      return { duplicate: true, summary: null, events: [], diagnostics: [] };
    }
    seenDigests.add(digest);
    const sourceId = `source-${sha256(`activity-v1:${digest}`).slice(0, 12)}`;
    const parsedBytes = parseHistoryBytes(bytes, {
      maximumRecords: EVIDENCE_LIMITS.maximumActivityRecords,
    });
    const parsed = parseRepositoryActivity(parsedBytes.records, {
      sourceId,
      sourceDigest: `sha256:${digest}`,
      skippedRecords: parsedBytes.skippedRecords,
    });
    const diagnostics = parsedBytes.issues.map((issue) =>
      reportDiagnostic(parsed.summary, 'partial', 'activity', issue.code));
    if (parsed.summary.status === 'partial' && diagnostics.length === 0) {
      diagnostics.push(
        reportDiagnostic(
          parsed.summary,
          'partial',
          'activity',
          'REPOSITORY_ACTIVITY_PARTIAL',
        ),
      );
    }
    return { ...parsed, diagnostics };
  } catch (error) {
    const summary = failedContextSummary(input, 'repository-activity');
    const code =
      error instanceof SafeReadError || error instanceof EvidenceValidationError
        ? error.code
        : 'REPOSITORY_ACTIVITY_READ_FAILED';
    return {
      duplicate: false,
      summary,
      events: [],
      diagnostics: [reportDiagnostic(summary, 'failed', 'activity', code)],
    };
  }
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
  const outputs = [options?.output, options?.facetSidecarOutput].filter(Boolean);
  if (outputs.length === 0) return;
  if (platform === 'win32') {
    throw new CliError(
      'OUTPUT_UNSUPPORTED_ON_WINDOWS',
      'Output error: private report files are not supported on Windows; use stdout.',
    );
  }

  const outputKeys = [];
  for (const output of outputs) {
    outputKeys.push(await canonicalFuturePath(output, platform));
  }
  if (new Set(outputKeys).size !== outputKeys.length) {
    throw new CliError(
      'OUTPUTS_ALIAS',
      'Output error: report and sidecar destinations must be distinct.',
    );
  }
  const selectedFiles = [
    ...(options.inputs ?? []),
    ...(options.activityInputs ?? []),
    ...(options.capabilityCatalogs ?? []),
    ...(options.estateManifest ? [options.estateManifest] : []),
  ];
  for (const outputKey of outputKeys) {
    for (const input of selectedFiles) {
      if (outputKey === (await canonicalFuturePath(input, platform))) {
        throw new CliError(
          'OUTPUT_ALIASES_SOURCE',
          'Output error: a destination aliases an explicitly selected source.',
        );
      }
    }
    for (const root of options.skillsRoots ?? []) {
      const rootKey = await canonicalFuturePath(root, platform);
      if (pathIsWithin(outputKey, rootKey)) {
        throw new CliError(
          'OUTPUT_INSIDE_SKILLS_ROOT',
          'Output error: destinations must be outside every selected skill root.',
        );
      }
    }
  }
  for (const output of outputs) {
    try {
      await lstat(output);
      throw new CliError(
        'OUTPUT_ALREADY_EXISTS',
        'Output error: refusing to replace an existing filesystem entry.',
      );
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (error?.code !== 'ENOENT') {
        throw new CliError(
          'OUTPUT_SCOPE_UNVERIFIED',
          'Output error: a destination could not be verified safely.',
        );
      }
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
  const seenSourceDigests = new Set();
  const sourceResults = [];
  let remainingRecords = EVIDENCE_LIMITS.maximumTotalRecords;
  for (let index = 0; index < options.inputs.length; index += 1) {
    const result =
      remainingRecords === 0
        ? totalRecordLimitResult(options.inputs[index], options.source ?? 'auto')
        : await readSource(
            options.inputs[index],
            options.source ?? 'auto',
            seenSourceDigests,
            Math.min(EVIDENCE_LIMITS.maximumRecordsPerSource, remainingRecords),
          );
    sourceResults.push(result);
    remainingRecords = Math.max(
      0,
      remainingRecords - result.attemptedRecords,
    );
  }
  const duplicateSources = sourceResults.filter((result) => result.duplicate).length;
  const uniqueSourceResults = sourceResults.filter((result) => !result.duplicate);
  uniqueSourceResults.sort((left, right) =>
    left.source.sourceId.localeCompare(right.source.sourceId, 'en'),
  );

  const estateResult = options.estateManifest
    ? await readEstateContext(options.estateManifest)
    : null;
  const seenCatalogDigests = new Set();
  const capabilityResults = [];
  for (const input of options.capabilityCatalogs ?? []) {
    capabilityResults.push(await readCapabilityContext(input, seenCatalogDigests));
  }
  const duplicateCatalogs = capabilityResults.filter((result) => result.duplicate).length;
  const uniqueCapabilityResults = capabilityResults.filter((result) => !result.duplicate);
  uniqueCapabilityResults.sort((left, right) =>
    left.summary.sourceId.localeCompare(right.summary.sourceId, 'en'));

  const seenActivityDigests = new Set();
  const activityResults = [];
  for (const input of options.activityInputs ?? []) {
    activityResults.push(await readActivityContext(input, seenActivityDigests));
  }
  const duplicateActivitySources = activityResults.filter((result) => result.duplicate).length;
  const uniqueActivityResults = activityResults.filter((result) => !result.duplicate);
  uniqueActivityResults.sort((left, right) =>
    left.summary.sourceId.localeCompare(right.summary.sourceId, 'en'));

  const localCapabilities = skillCatalog.skills.map((skill) => ({ ...skill }));
  const mergedCapabilities = mergeCapabilityCatalogs([
    { capabilities: localCapabilities },
    ...(estateResult ? [estateResult] : []),
    ...uniqueCapabilityResults,
  ]);
  const capabilitySourceStatuses = [
    ...(options.skillsRoots?.length > 0
      ? [skillCatalog.skippedEntries > 0 ? 'partial' : 'ok']
      : []),
    ...(estateResult ? [estateResult.summary.status] : []),
    ...uniqueCapabilityResults.map((result) => result.summary.status),
  ];
  const catalogCoverage =
    capabilitySourceStatuses.length === 0
      ? 'none'
      : capabilitySourceStatuses.every((status) => status === 'ok')
        ? 'complete'
        : 'partial';

  const sources = uniqueSourceResults.map((result) => result.source);
  const normalizedEvents = uniqueSourceResults.flatMap((result) => result.events);
  const activityEvents = uniqueActivityResults.flatMap((result) => result.events);
  const hasClosedRepairEvidence = normalizedEvents.some(
    (event) =>
      event.role === 'user' &&
      event.features?.repair === true &&
      REPAIR_FACETS.includes(event.features?.repairFacet) &&
      REPAIR_DOMAINS.includes(event.features?.repairDomain),
  );
  const hasBehavioralContractEvidence = mergedCapabilities.some(
    (capability) => capability.contractQualified === true,
  );
  const reportVersion =
    options.reportVersion === '3' ||
    (
      (options.reportVersion ?? 'auto') === 'auto' &&
      (
        hasClosedRepairEvidence ||
        hasBehavioralContractEvidence ||
        options.facetSidecarOutput !== null
      )
    )
      ? '3'
      : '2';
  const analysisFunction =
    reportVersion === '3' ? analyzeHistoryV3 : analyzeHistory;
  const analysis = analysisFunction(normalizedEvents, {
    sinceMs: options.sinceMs ?? null,
    untilMs: options.untilMs ?? null,
    minSessions: options.minSessions ?? 3,
    minDays: options.minDays ?? 2,
    catalog: { capabilities: mergedCapabilities, coverage: catalogCoverage },
    activityEvents,
  });
  const acceptedRecords = sources.reduce((total, source) => total + source.acceptedRecords, 0);
  const skippedRecords = sources.reduce((total, source) => total + source.skippedRecords, 0);
  const anyAccepted = acceptedRecords > 0;
  let status = anyAccepted ? 'ok' : 'failed';
  if (
    anyAccepted &&
    (
      sources.some((source) => source.status !== 'ok') ||
      skillCatalog.skippedEntries > 0 ||
      duplicateSources > 0 ||
      duplicateCatalogs > 0 ||
      duplicateActivitySources > 0 ||
      capabilitySourceStatuses.some((sourceStatus) => sourceStatus !== 'ok') ||
      uniqueActivityResults.some((result) => result.summary.status !== 'ok') ||
      analysis.excluded.candidateCap > 0 ||
      analysis.excluded.evidenceItems > 0 ||
      analysis.excluded.workLimitEvents > 0
    )
  ) {
    status = 'partial';
  }

  const diagnostics = [
    ...uniqueSourceResults.flatMap((result) => result.diagnostics),
    ...(estateResult?.diagnostics ?? []),
    ...uniqueCapabilityResults.flatMap((result) => result.diagnostics),
    ...uniqueActivityResults.flatMap((result) => result.diagnostics),
  ];
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

  const fingerprintMaterial = {
    sources: sources.map((source) => source.sourceDigest).sort(),
    estate: estateResult?.summary.sourceDigest ?? null,
    catalogs: uniqueCapabilityResults
      .map((result) => result.summary.sourceDigest)
      .sort(),
    localSkills: {
      capabilities: localCapabilities
        .map((capability) => ({
          capabilityId: capability.capabilityId,
          sourceIds: capability.sourceIds,
        }))
        .sort((left, right) =>
          left.capabilityId.localeCompare(right.capabilityId, 'en')),
      coverage: skillCatalog.coverage,
      skippedEntries: skillCatalog.skippedEntries,
      diagnostics: skillCatalog.diagnostics,
    },
    catalogCoverage,
    activities: uniqueActivityResults
      .map((result) => result.summary.sourceDigest)
      .sort(),
    scope: {
      since: options.since ?? null,
      until: options.until ?? null,
      minSessions: options.minSessions ?? 3,
      minDays: options.minDays ?? 2,
    },
  };
  if (reportVersion === '3') {
    fingerprintMaterial.detector = {
      analyzerVersion: '3',
      facetTaxonomyVersion: analysis.detector.facetTaxonomyVersion,
      domainTaxonomyVersion: analysis.detector.domainTaxonomyVersion,
    };
  }
  const analysisFingerprint = `sha256:${sha256(
    stableStringify(fingerprintMaterial),
  )}`;
  const report = {
    schemaVersion:
      reportVersion === '3' ? SCHEMA_VERSION_V3 : SCHEMA_VERSION_V2,
    mode: 'observe',
    status,
    scope: {
      windowStart: options.since ?? null,
      windowEnd: options.until ?? null,
      minimumSessions: options.minSessions ?? 3,
      minimumActiveDays: options.minDays ?? 2,
      skillsRootsCount: (options.skillsRoots ?? []).length,
      repositoryActivityInputsCount: (options.activityInputs ?? []).length,
      capabilityCatalogInputsCount: (options.capabilityCatalogs ?? []).length,
      estateManifestProvided: options.estateManifest !== null,
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
      selectedCandidateId: analysis.candidates[0]?.candidateId ?? null,
      repositoryActivityRecords: uniqueActivityResults.reduce(
        (total, result) => total + result.summary.acceptedRecords,
        0,
      ),
      capabilitiesInspected: mergedCapabilities.length,
    },
    candidates: analysis.candidates,
    excluded: {
      ...analysis.excluded,
      duplicateSources,
      duplicateCatalogs,
      duplicateActivitySources,
    },
    context: {
      estateManifest:
        reportVersion === '2' &&
        estateResult?.summary.sourceType === 'generic-estate-manifest'
          ? {
              ...estateResult.summary,
              sourceType: 'rapp-monorepo-manifest',
            }
          : estateResult?.summary ?? null,
      capabilityCatalogs: uniqueCapabilityResults.map((result) =>
        reportVersion === '2' &&
        result.summary.sourceType === 'behavioral-capabilities'
          ? {
              ...result.summary,
              sourceType: 'normalized-capabilities',
            }
          : result.summary),
      repositoryActivitySources: uniqueActivityResults.map((result) => result.summary),
      catalogCoverage,
    },
    replay: {
      analyzerVersion: reportVersion,
      analysisFingerprint,
    },
    diagnostics,
  };
  if (reportVersion === '3') {
    report.summary.promotionEligibleCandidateCount =
      analysis.candidates.filter((candidate) => candidate.promotion.eligible).length;
    report.context.behavioralCapabilityContracts = {
      qualifiedCapabilities: mergedCapabilities.filter(
        (capability) => capability.contractQualified === true,
      ).length,
      unqualifiedCapabilities: mergedCapabilities.filter(
        (capability) => capability.contractQualified !== true,
      ).length,
      conflictingCapabilities: mergedCapabilities.filter(
        (capability) => capability.contractConflict === true,
      ).length,
      requirement:
        'reuse-and-extend-require-versioned-behavioral-contract-v1',
    };
    report.detector = analysis.detector;
  }
  const text = `${stableStringify(report, options.pretty === true)}\n`;
  let sidecar = null;
  let sidecarText = null;
  if (options.facetSidecarOutput) {
    sidecar = {
      schemaVersion: REPAIR_SIDECAR_SCHEMA_VERSION,
      mode: 'repair-assignment-sidecar',
      detector: analysis.detector,
      summary: {
        assignments: analysis.repairAssignments.length,
        sources: new Set(
          analysis.repairAssignments.map(({ sourceId }) => sourceId),
        ).size,
        sessions: new Set(
          analysis.repairAssignments.map(
            ({ sourceId, sessionAlias }) => `${sourceId}:${sessionAlias}`,
          ),
        ).size,
        activeDays: new Set(
          analysis.repairAssignments.map(({ day }) => day),
        ).size,
      },
      assignments: analysis.repairAssignments,
      replay: {
        analyzerVersion: '3',
        analysisFingerprint,
        sidecarFingerprint: `sha256:${sha256(
          stableStringify(analysis.repairAssignments),
        )}`,
      },
    };
    sidecarText = `${stableStringify(sidecar, options.pretty === true)}\n`;
  }
  if (!validateObserveReportShape(report.schemaVersion, report)) {
    throw new Error('Generated report did not satisfy its closed contract.');
  }
  if (sidecar !== null && !validateRepairSidecarShape(sidecar)) {
    throw new Error('Generated sidecar did not satisfy its closed contract.');
  }
  writeStdout(text);
  if (options.output) await atomicWrite(options.output, text);
  if (options.facetSidecarOutput) {
    await atomicWrite(options.facetSidecarOutput, sidecarText);
  }
  return {
    exitCode: status === 'failed' ? 1 : 0,
    report,
    text,
    sidecar,
    sidecarText,
  };
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
