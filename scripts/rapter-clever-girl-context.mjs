import { createHash } from 'node:crypto';

export const EVIDENCE_LIMITS = Object.freeze({
  maximumInputs: 64,
  maximumActivityInputs: 16,
  maximumCapabilityCatalogs: 16,
  maximumSkillsRoots: 16,
  maximumSourceBytes: 64 * 1024 * 1024,
  maximumMetadataBytes: 16 * 1024 * 1024,
  maximumRecordsPerSource: 50_000,
  maximumTotalRecords: 100_000,
  maximumActivityRecords: 50_000,
  maximumCapabilityEntries: 50_000,
  maximumEstateRepositories: 5_000,
  maximumCorrectionEvents: 2_000,
  maximumToolEvents: 25_000,
  maximumSkillDepth: 12,
  maximumSkillDirectories: 2_048,
  maximumSkillEntries: 10_000,
  maximumSkillMetadataBytes: 64 * 1024 * 1024,
});

const TOPIC_PATTERNS = Object.freeze({
  'review-workflow': /\b(?:review|release|pull|merge|gate|approval|audit)\b/,
  'repair-loop': /\b(?:setup|install|configure|doctor|repair|recover|root|failure|debug)\b/,
  'delivery-workflow': /\b(?:deliver|commit|branch|issue|deploy|publish|release|ship)\b/,
  'recurring-correction': /\b(?:preference|instruction|correction|rule|memory|policy)\b/,
  'tool-sequence': /\b(?:tool|workflow|automation|sequence|pipeline|orchestrat)\b/,
});

const PATTERN_KEYWORDS = Object.freeze({
  'review-workflow': ['review', 'release', 'pull', 'merge', 'gate', 'audit'],
  'repair-loop': ['setup', 'install', 'doctor', 'repair', 'recover', 'debug', 'root'],
  'delivery-workflow': ['deliver', 'commit', 'branch', 'deploy', 'publish', 'release', 'ship'],
  'recurring-correction': ['preference', 'instruction', 'correction', 'rule', 'memory', 'policy'],
  'tool-sequence': ['tool', 'workflow', 'automation', 'sequence', 'pipeline', 'orchestration'],
});

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

export class EvidenceValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'EvidenceValidationError';
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

function safeDateTime(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    return null;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function safeCapabilityName(value) {
  const original = typeof value === 'string' ? value : '';
  const normalized = original.normalize('NFKC').toLowerCase().trim();
  const safe = normalized
    .replace(/^@/, '')
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (
    /^[a-z0-9][a-z0-9_-]{0,63}$/.test(safe) &&
    !/(?:token|secret|password|credential)[_-][a-z0-9]{8,}/.test(safe)
  ) {
    return safe;
  }
  return `capability-${sha256(`capability-name-v1:${original}`).slice(0, 12)}`;
}

function opaqueEstateCapabilityName(matchName) {
  return `estate-capability-${sha256(
    `estate-capability-name-v1:${matchName}`,
  ).slice(0, 12)}`;
}

function boundedText(value, maximum = 4_096) {
  return typeof value === 'string' ? value.slice(0, maximum) : '';
}

function textTokens(text) {
  const matches = boundedText(text, 65_536)
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,31}/gu);
  if (!matches) return { tokens: [], truncated: false };
  const tokens = [...new Set(matches.filter((token) => !STOP_WORDS.has(token)))];
  return { tokens: tokens.slice(0, 256), truncated: tokens.length > 256 };
}

function tokenHashes(text) {
  const result = textTokens(text);
  return {
    hashes: result.tokens
      .map((token) => sha256(`capability-token-v1:${token}`).slice(0, 20))
      .sort(),
    truncated: result.truncated,
  };
}

function capabilityTopics(text) {
  const lower = boundedText(text, 65_536).normalize('NFKC').toLowerCase();
  return Object.entries(TOPIC_PATTERNS)
    .filter(([, pattern]) => pattern.test(lower))
    .map(([topic]) => topic)
    .sort();
}

function capabilityEntry({
  name,
  text,
  sourceType,
  sourceId,
  nativeDigest = '',
  opaqueName = false,
  behavioralContract = null,
}) {
  const matchName = safeCapabilityName(name);
  const publicName = opaqueName
    ? opaqueEstateCapabilityName(matchName)
    : matchName;
  const material = `${matchName}\n${boundedText(text, 65_536)}`;
  const tokens = tokenHashes(material);
  return {
    name: publicName,
    matchName,
    capabilityId: `capability-${sha256(
      `capability-v2:${matchName}:${nativeDigest}:${sha256(material)}`,
    ).slice(0, 16)}`,
    topics: capabilityTopics(material),
    tokenHashes: tokens.hashes,
    sourceTypes: [sourceType],
    sourceIds: [sourceId],
    contractQualified: behavioralContract !== null,
    contractVersion: behavioralContract?.version ?? null,
    contractTestCount: behavioralContract?.tests.length ?? 0,
    limited: tokens.truncated,
  };
}

function boundedContractString(value, maximum = 1_024) {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum;
}

function validContractField(field) {
  return (
    field !== null &&
    typeof field === 'object' &&
    !Array.isArray(field) &&
    boundedContractString(field.name, 64) &&
    /^[a-z][a-z0-9_-]{0,63}$/.test(field.name) &&
    boundedContractString(field.type, 64) &&
    boundedContractString(field.description)
  );
}

function validContractPermission(permission) {
  return (
    permission !== null &&
    typeof permission === 'object' &&
    !Array.isArray(permission) &&
    boundedContractString(permission.resource, 64) &&
    /^[a-z][a-z0-9_.-]{0,63}$/.test(permission.resource) &&
    ['none', 'read', 'write', 'execute'].includes(permission.access) &&
    boundedContractString(permission.reason)
  );
}

function validContractFailure(failure) {
  return (
    failure !== null &&
    typeof failure === 'object' &&
    !Array.isArray(failure) &&
    boundedContractString(failure.code, 64) &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code) &&
    boundedContractString(failure.condition) &&
    boundedContractString(failure.behavior)
  );
}

function validContractTest(test) {
  return (
    test !== null &&
    typeof test === 'object' &&
    !Array.isArray(test) &&
    boundedContractString(test.id, 64) &&
    /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(test.id) &&
    boundedContractString(test.assertion)
  );
}

function parseBehavioralContract(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.schemaVersion !== 'rapter-clever-girl.capability-contract.v1' ||
    !boundedContractString(value.version, 64) ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(
      value.version,
    ) ||
    !Array.isArray(value.inputs) ||
    value.inputs.length < 1 ||
    value.inputs.length > 64 ||
    !value.inputs.every(validContractField) ||
    !Array.isArray(value.outputs) ||
    value.outputs.length < 1 ||
    value.outputs.length > 64 ||
    !value.outputs.every(validContractField) ||
    !Array.isArray(value.permissions) ||
    value.permissions.length < 1 ||
    value.permissions.length > 64 ||
    !value.permissions.every(validContractPermission) ||
    !Array.isArray(value.failures) ||
    value.failures.length < 1 ||
    value.failures.length > 64 ||
    !value.failures.every(validContractFailure) ||
    !Array.isArray(value.limitations) ||
    value.limitations.length < 1 ||
    value.limitations.length > 64 ||
    !value.limitations.every((entry) => boundedContractString(entry)) ||
    !Array.isArray(value.tests) ||
    value.tests.length < 1 ||
    value.tests.length > 256 ||
    !value.tests.every(validContractTest)
  ) {
    throw new EvidenceValidationError('CAPABILITY_CONTRACT_INVALID');
  }
  return {
    version: value.version,
    tests: value.tests,
  };
}

function requirePlainObject(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new EvidenceValidationError(code);
  }
  return value;
}

export function parseEstateManifest(value, { sourceId, sourceDigest }) {
  const manifest = requirePlainObject(value, 'ESTATE_MANIFEST_INVALID');
  let shape;
  if (manifest.schema === 'rapp-monorepo/1.0') {
    shape = {
      sourceType: 'rapp-monorepo-manifest',
      snapshotAt: manifest.captured_at,
      repositories: manifest.repos,
      notCaptured: manifest.not_captured,
      repositoryName: (repository) => repository.repo,
      revision: (repository) => repository.commit,
      files: (repository) => repository.files,
      bytes: (repository) => repository.bytes,
      skippedLarge: (repository) => repository.skipped_large,
      withheld: (repository) => repository.withheld,
    };
  } else if (manifest.schema === 'clevergirl-estate/1.0') {
    shape = {
      sourceType: 'generic-estate-manifest',
      snapshotAt: manifest.capturedAt,
      repositories: manifest.repositories,
      notCaptured: manifest.notCaptured,
      repositoryName: (repository) => repository.name,
      revision: (repository) => repository.revision,
      files: (repository) => repository.files,
      bytes: (repository) => repository.bytes,
      skippedLarge: (repository) => repository.skippedLarge,
      withheld: (repository) => repository.withheld,
    };
  } else {
    throw new EvidenceValidationError('ESTATE_MANIFEST_SCHEMA_UNSUPPORTED');
  }
  if (
    safeDateTime(shape.snapshotAt) === null ||
    !Array.isArray(shape.repositories) ||
    shape.repositories.length < 1 ||
    shape.repositories.length > EVIDENCE_LIMITS.maximumEstateRepositories ||
    !Array.isArray(shape.notCaptured)
  ) {
    throw new EvidenceValidationError('ESTATE_MANIFEST_INVALID');
  }

  const names = new Set();
  let withheldFiles = 0;
  let skippedLargeFiles = 0;
  const capabilities = [];
  for (const repository of shape.repositories) {
    requirePlainObject(repository, 'ESTATE_REPOSITORY_INVALID');
    const repositoryName = shape.repositoryName(repository);
    const revision = shape.revision(repository);
    const files = shape.files(repository);
    const bytes = shape.bytes(repository);
    const skippedLarge = shape.skippedLarge(repository);
    const withheld = shape.withheld(repository);
    if (
      typeof repositoryName !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(repositoryName) ||
      names.has(repositoryName) ||
      typeof revision !== 'string' ||
      !/^[A-Za-z0-9._:@/+~-]{1,128}$/.test(revision) ||
      !Number.isSafeInteger(files) ||
      files < 0 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      !Array.isArray(skippedLarge) ||
      !Array.isArray(withheld)
    ) {
      throw new EvidenceValidationError('ESTATE_REPOSITORY_INVALID');
    }
    if (
      manifest.schema === 'rapp-monorepo/1.0' &&
      !/^[0-9a-f]{40}$/.test(revision)
    ) {
      throw new EvidenceValidationError('ESTATE_REPOSITORY_INVALID');
    }
    names.add(repositoryName);
    withheldFiles += withheld.length;
    skippedLargeFiles += skippedLarge.length;
    const capability = capabilityEntry({
        name: repositoryName,
        text: repositoryName.replace(/[-_.]+/g, ' '),
        sourceType: 'estate-repository',
        sourceId,
        nativeDigest: revision,
        opaqueName: true,
      });
    delete capability.limited;
    capabilities.push(capability);
  }

  const skippedRecords = shape.notCaptured.length;
  return {
    summary: {
      sourceId,
      sourceType: shape.sourceType,
      sourceDigest,
      status: skippedRecords > 0 || withheldFiles > 0 || skippedLargeFiles > 0 ? 'partial' : 'ok',
      schema: manifest.schema,
      snapshotAt: safeDateTime(shape.snapshotAt),
      acceptedRecords: shape.repositories.length,
      skippedRecords,
      repositoryCount: shape.repositories.length,
      withheldFiles,
      skippedLargeFiles,
    },
    capabilities,
  };
}

function catalogShape(value) {
  const catalog = requirePlainObject(value, 'CAPABILITY_CATALOG_INVALID');
  switch (catalog.schema) {
    case 'rapp-registry/1.1':
      return { schema: catalog.schema, entries: catalog.agents, sourceType: 'rapp-registry' };
    case 'rapp-store/1.0':
      return { schema: catalog.schema, entries: catalog.rapplications, sourceType: 'rapp-store' };
    case 'rapp-skills-cat-catalog/1.0':
      return { schema: catalog.schema, entries: catalog.skills, sourceType: 'rapp-skills' };
    case 'rar-match/1.0':
      return {
        schema: catalog.schema,
        entries: Array.isArray(catalog.use_cases)
          ? catalog.use_cases.flatMap((useCase) =>
              Array.isArray(useCase?.matches) ? useCase.matches : [])
          : null,
        sourceType: 'rar-match',
      };
    case 'rapter-clever-girl.capabilities.v1':
      return {
        schema: catalog.schema,
        entries: catalog.capabilities,
        sourceType: 'normalized-capabilities',
        requiresBehavioralContract: false,
      };
    case 'rapter-clever-girl.capabilities.v2':
      return {
        schema: catalog.schema,
        entries: catalog.capabilities,
        sourceType: 'behavioral-capabilities',
        requiresBehavioralContract: true,
      };
    default:
      throw new EvidenceValidationError('CAPABILITY_CATALOG_SCHEMA_UNSUPPORTED');
  }
}

function catalogEntryText(entry) {
  const tags = Array.isArray(entry.tags)
    ? entry.tags.filter((tag) => typeof tag === 'string').slice(0, 64).join(' ')
    : '';
  const values = [
    entry.name,
    entry.display_name,
    entry.description,
    entry.summary,
    entry.tagline,
    entry.category,
    entry.tool,
  ];
  return {
    text: [
    boundedText(entry.name),
    boundedText(entry.display_name),
    boundedText(entry.description),
    boundedText(entry.summary),
    boundedText(entry.tagline),
    boundedText(entry.category),
    boundedText(entry.tool),
    tags,
    ].join('\n'),
    truncated:
      values.some((value) => typeof value === 'string' && value.length > 4_096) ||
      (Array.isArray(entry.tags) && entry.tags.length > 64),
  };
}

export function parseCapabilityCatalog(value, { sourceId, sourceDigest }) {
  const shape = catalogShape(value);
  if (
    !Array.isArray(shape.entries) ||
    shape.entries.length > EVIDENCE_LIMITS.maximumCapabilityEntries
  ) {
    throw new EvidenceValidationError('CAPABILITY_CATALOG_INVALID');
  }

  const capabilities = [];
  let skippedRecords = 0;
  for (const entry of shape.entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      skippedRecords += 1;
      continue;
    }
    const rawName =
      entry.name ?? entry.slug ?? entry.id ?? entry.display_name ?? entry.tool;
    if (typeof rawName !== 'string' || rawName.trim().length === 0) {
      skippedRecords += 1;
      continue;
    }
    const nativeDigest =
      typeof entry._sha256 === 'string'
        ? entry._sha256
        : typeof entry.skillSha256 === 'string'
          ? entry.skillSha256
          : typeof entry.singleton_sha256 === 'string'
            ? entry.singleton_sha256
            : '';
    let behavioralContract = null;
    if (shape.requiresBehavioralContract) {
      behavioralContract = parseBehavioralContract(entry.behavioralContract);
    }
    const catalogText = catalogEntryText(entry);
    const capability = capabilityEntry({
        name: rawName,
        text: catalogText.text,
        sourceType: shape.sourceType,
        sourceId,
        nativeDigest,
        behavioralContract,
      });
    if (catalogText.truncated || capability.limited) skippedRecords += 1;
    delete capability.limited;
    capabilities.push(capability);
  }
  if (capabilities.length === 0) {
    throw new EvidenceValidationError('CAPABILITY_CATALOG_EMPTY');
  }
  return {
    summary: {
      sourceId,
      sourceType: shape.sourceType,
      sourceDigest,
      status: skippedRecords > 0 ? 'partial' : 'ok',
      schema: shape.schema,
      acceptedRecords: capabilities.length,
      skippedRecords,
    },
    capabilities,
  };
}

function activityKind(value) {
  const normalized = typeof value === 'string'
    ? value.normalize('NFKC').toLowerCase().replace(/[_\s.]+/g, '-')
    : '';
  if (/^(?:pr|pull-request|pullrequest)$/.test(normalized)) return 'pull-request';
  if (/^(?:check|check-run|workflow|workflow-run|ci)$/.test(normalized)) return 'check-run';
  if (/^(?:review|pull-request-review)$/.test(normalized)) return 'review';
  if (/^(?:commit|push)$/.test(normalized)) return 'commit';
  if (/^(?:release|deployment|deploy)$/.test(normalized)) return 'release';
  return null;
}

function activityState(record) {
  const material = [
    record.state,
    record.status,
    record.conclusion,
    record.result,
  ]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  if (/\b(?:failure|failed|error|cancelled|timed-out|timeout|denied)\b/.test(material)) {
    return 'failed';
  }
  if (/\b(?:success|succeeded|passed|completed)\b/.test(material)) return 'succeeded';
  if (/\bmerged\b/.test(material)) return 'merged';
  if (/\b(?:open|opened)\b/.test(material)) return 'opened';
  if (/\b(?:closed|dismissed)\b/.test(material)) return 'closed';
  if (/\b(?:queued|pending|in-progress|running)\b/.test(material)) return 'pending';
  return 'unknown';
}

function firstString(record, keys) {
  for (const key of keys) {
    if (
      own(record, key) &&
      typeof record[key] === 'string' &&
      record[key].length > 0 &&
      record[key].length <= 1_024
    ) {
      return record[key];
    }
  }
  return null;
}

export function parseRepositoryActivity(records, { sourceId, sourceDigest, skippedRecords = 0 }) {
  if (!Array.isArray(records)) {
    throw new EvidenceValidationError('REPOSITORY_ACTIVITY_INVALID');
  }
  const events = [];
  let rejected = skippedRecords;
  for (const parsed of records.slice(0, EVIDENCE_LIMITS.maximumActivityRecords)) {
    const record = parsed?.value;
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      rejected += 1;
      continue;
    }
    const kind = activityKind(record.kind ?? record.type ?? record.event);
    const repository = firstString(record, ['repository', 'repo', 'repositoryName']);
    const timestamp = safeDateTime(record.observedAt ?? record.timestamp ?? record.createdAt);
    if (kind === null || repository === null || timestamp === null) {
      rejected += 1;
      continue;
    }
    const artifact = firstString(record, [
      'artifactKey',
      'pullRequest',
      'pullRequestId',
      'checkRunId',
      'headSha',
      'commit',
      'id',
    ]) ?? `${kind}:${parsed.ordinal}`;
    const duration =
      typeof record.durationMs === 'number' &&
      Number.isFinite(record.durationMs) &&
      record.durationMs >= 0
        ? Math.floor(record.durationMs)
        : null;
    events.push({
      sourceId,
      ordinal: parsed.ordinal,
      kind,
      timestamp,
      day: timestamp.slice(0, 10),
      repositoryAlias: `repository-${sha256(`repo-v1:${repository}`).slice(0, 12)}`,
      artifactId: `artifact-${sha256(`artifact-v1:${repository}:${artifact}`).slice(0, 16)}`,
      state: activityState(record),
      durationMs: duration,
    });
  }
  rejected += Math.max(0, records.length - EVIDENCE_LIMITS.maximumActivityRecords);
  if (events.length === 0) {
    throw new EvidenceValidationError('REPOSITORY_ACTIVITY_EMPTY');
  }
  return {
    summary: {
      sourceId,
      sourceType: 'repository-activity',
      sourceDigest,
      status: rejected > 0 ? 'partial' : 'ok',
      acceptedRecords: events.length,
      skippedRecords: rejected,
    },
    events,
  };
}

function mergeStringArrays(left = [], right = []) {
  return [...new Set([...left, ...right])].sort((a, b) => a.localeCompare(b, 'en'));
}

export function mergeCapabilityCatalogs(catalogs) {
  const merged = new Map();
  for (const catalog of catalogs) {
    for (const capability of catalog?.capabilities ?? []) {
      const key = capability.matchName ?? capability.name;
      const current = merged.get(key);
      if (!current) {
        merged.set(key, {
          ...capability,
          topics: [...capability.topics],
          tokenHashes: [...capability.tokenHashes],
          sourceTypes: [...capability.sourceTypes],
          sourceIds: [...capability.sourceIds],
          contractQualified: capability.contractQualified === true,
          contractVersion: capability.contractVersion ?? null,
          contractTestCount: capability.contractTestCount ?? 0,
          contractVersions:
            capability.contractQualified === true
              ? [capability.contractVersion]
              : [],
        });
        continue;
      }
      current.topics = mergeStringArrays(current.topics, capability.topics);
      current.tokenHashes = mergeStringArrays(current.tokenHashes, capability.tokenHashes);
      current.sourceTypes = mergeStringArrays(current.sourceTypes, capability.sourceTypes);
      current.sourceIds = mergeStringArrays(current.sourceIds, capability.sourceIds);
      current.contractVersions = mergeStringArrays(
        current.contractVersions,
        capability.contractQualified === true
          ? [capability.contractVersion]
          : [],
      );
      current.contractQualified = current.contractVersions.length === 1;
      current.contractVersion = current.contractQualified
        ? current.contractVersions[0]
        : null;
      current.contractTestCount = current.contractQualified
        ? Math.max(current.contractTestCount, capability.contractTestCount ?? 0)
        : 0;
      if (current.sourceTypes.includes('estate-repository')) {
        current.name = opaqueEstateCapabilityName(key);
      }
      current.capabilityId = `capability-${sha256(
        `merged-capability-v1:${current.name}:${current.sourceIds.join(':')}`,
      ).slice(0, 16)}`;
    }
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name, 'en'));
}

function jaccard(left, right) {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const item of rightSet) if (leftSet.has(item)) intersection += 1;
  return intersection / (leftSet.size + rightSet.size - intersection);
}

function matchReason(match) {
  if (match === 'reuse') {
    return 'Selected capability catalogs contain a strong deterministic match for this recurring pattern.';
  }
  if (match === 'extend') {
    return 'Selected capability catalogs contain a related capability that may cover part of this pattern.';
  }
  return 'Selected capability catalogs contain a lexical or topical overlap that requires inspection.';
}

function opaqueBehavioralCapabilityName(capabilityId) {
  return `contract-capability-${sha256(
    `behavioral-capability-name-v1:${capabilityId}`,
  ).slice(0, 12)}`;
}

export function matchCapabilities(
  patternType,
  capabilities,
  candidateTokenHashes,
  { requireBehavioralContract = false } = {},
) {
  const keywords = PATTERN_KEYWORDS[patternType] ?? [];
  const candidates = [];
  for (const capability of capabilities ?? []) {
    const matchName = capability.matchName ?? capability.name;
    const topicMatch = capability.topics.includes(patternType);
    const keywordHits = keywords.filter((keyword) => matchName.includes(keyword)).length;
    const intersection = candidateTokenHashes.filter((token) =>
      capability.tokenHashes.includes(token)).length;
    const similarity = jaccard(candidateTokenHashes, capability.tokenHashes);
    const preferred =
      (patternType === 'review-workflow' && matchName === 'release-reviewer') ||
      (patternType === 'repair-loop' &&
        ['root-cause-fix', 'first-run-doctor'].includes(matchName));
    const score =
      (preferred ? 10_000 : 0) +
      (topicMatch ? 2_000 : 0) +
      keywordHits * 700 +
      Math.min(intersection, 8) * 250 +
      Math.round(similarity * 1_000);
    if (score < 700) continue;
    const lexicalMatch =
      score >= 2_700 ? 'reuse' : score >= 1_700 ? 'extend' : 'possible-overlap';
    const contractQualified = capability.contractQualified === true;
    const match =
      requireBehavioralContract && !contractQualified
        ? 'possible-overlap'
        : lexicalMatch;
    const candidate = {
      capabilityId: capability.capabilityId,
      name: requireBehavioralContract
        ? opaqueBehavioralCapabilityName(capability.capabilityId)
        : capability.name,
      match,
      reason:
        requireBehavioralContract && !contractQualified
          ? 'Selected metadata overlaps, but reuse or extension requires a complete versioned behavioral capability contract.'
          : matchReason(match),
      sourceTypes: capability.sourceTypes,
      score,
    };
    if (requireBehavioralContract) {
      candidate.contractQualified = contractQualified;
      candidate.contractVersion = contractQualified
        ? capability.contractVersion
        : null;
      candidate.contractTestCount = contractQualified
        ? capability.contractTestCount
        : 0;
    }
    candidates.push(candidate);
  }
  return candidates
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      return left.name.localeCompare(right.name, 'en');
    })
    .slice(0, 3)
    .map(({ score: _score, ...match }) => match);
}

export function repositoryCorroboration(patternType, events) {
  const relevant = (events ?? []).filter((event) => {
    if (patternType === 'repair-loop') {
      return event.kind === 'check-run' && event.state === 'failed';
    }
    if (patternType === 'review-workflow') {
      return ['pull-request', 'review', 'check-run'].includes(event.kind);
    }
    if (patternType === 'delivery-workflow') {
      return ['pull-request', 'commit', 'release'].includes(event.kind);
    }
    return false;
  });
  return {
    status: events?.length > 0 ? 'available' : 'unavailable',
    events: relevant.length,
    repositories: new Set(relevant.map((event) => event.repositoryAlias)).size,
    pullRequests: new Set(
      relevant
        .filter((event) => event.kind === 'pull-request' || event.kind === 'review')
        .map((event) => event.artifactId),
    ).size,
    failedChecks: relevant.filter(
      (event) => event.kind === 'check-run' && event.state === 'failed',
    ).length,
  };
}

export function priorityBasisPoints(candidate, repositoryEvidence) {
  const confidence = { high: 2_500, medium: 1_500, low: 500 }[candidate.confidence] ?? 0;
  const breadth = Math.min(2_000, candidate.sessions * 350 + candidate.activeDays * 200);
  const recurrence = Math.min(1_500, candidate.occurrences * 250);
  const friction = Math.min(
    3_000,
    Math.floor((candidate.observedActiveFriction.lowerSeconds / 3_600) * 3_000),
  );
  const corroboration = Math.min(
    500,
    repositoryEvidence.events * 25 + repositoryEvidence.repositories * 75,
  );
  return Math.min(10_000, confidence + breadth + recurrence + friction + corroboration);
}
