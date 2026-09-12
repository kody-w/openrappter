import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { canonical, exactKeys, invariant, safeRelative, sha256, validateHash } from './common.mjs';

const CREDENTIAL = /(?:-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b|(?:api[_-]?key|password|client[_-]?secret|access[_-]?token|authorization)\s*[:=]\s*(?!\[REDACTED\])\S+)/iu;

function text(value, maximum = 65_536) {
  invariant(typeof value === 'string' && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), 'Migration text must be bounded inert text');
  invariant(!CREDENTIAL.test(value), 'Migration text contains an unredacted credential');
}

function timestamp(value) {
  invariant(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'Migration timestamp must be an exact UTC instant');
}

function inertContent(content) {
  exactKeys(content, ['schema', 'sourceHash', 'sourceModifiedAt', 'kind', 'data'], 'Inert import');
  invariant(content.schema === 'rapp-work.inert-import/v1', 'Unexpected inert import schema');
  validateHash(content.sourceHash, 'Migration source hash');
  timestamp(content.sourceModifiedAt);
  const data = content.data;
  invariant(data?.kind === content.kind, 'Migration content kind mismatch');
  if (content.kind === 'agent') {
    exactKeys(data, ['kind', 'name', 'instructions', 'enabled', 'policyReviewRequired'], 'Imported agent');
    text(data.name, 200);
    text(data.instructions);
    invariant(data.name.length > 0 && data.enabled === false && data.policyReviewRequired === true, 'Imported agents must be disabled and require policy review');
  } else if (content.kind === 'task') {
    exactKeys(data, ['kind', 'title', 'description', 'status', 'legacyStatus'], 'Imported task');
    text(data.title, 200);
    text(data.description);
    text(data.legacyStatus, 200);
    invariant(data.title.length > 0 && data.status === 'draft', 'Imported tasks must be drafts, never completed-work evidence');
  } else {
    invariant(content.kind === 'memory', 'Only inert agent, task and memory data may be migrated');
    exactKeys(data, ['kind', 'content', 'tags', 'trusted'], 'Imported memory');
    text(data.content);
    invariant(data.trusted === false && Array.isArray(data.tags) && data.tags.length <= 32, 'Imported memory must remain untrusted');
    for (const tag of data.tags) text(tag, 80);
  }
  return content;
}

export function validateMigrationPlan(input) {
  exactKeys(input, ['schema', 'mode', 'authoritative', 'requiresAuthorization', 'target', 'items', 'sourceDisposition'], 'Migration plan');
  invariant(input.schema === 'rapp-work.import-plan/v1' && input.mode === 'review-only'
    && input.authoritative === false && input.requiresAuthorization === true && input.sourceDisposition === 'leave-unchanged',
  'Migration plans are review-only proposals and cannot grant authority or delete sources');
  exactKeys(input.target, ['agentId', 'workspaceId'], 'Migration target');
  for (const value of Object.values(input.target)) invariant(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(value), 'Migration target IDs must be inert locators');
  invariant(Array.isArray(input.items) && input.items.length <= 10_000, 'Migration item limit exceeded');
  const ids = new Set();
  const paths = new Set();
  for (const item of input.items) {
    exactKeys(item, ['recordId', 'targetPath', 'content', 'sha256', 'proposedEvent'], 'Migration item');
    invariant(typeof item.recordId === 'string' && item.recordId.length <= 512 && !ids.has(item.recordId), 'Migration record IDs must be unique');
    const separator = item.recordId.lastIndexOf(':');
    const sourceId = item.recordId.slice(0, separator);
    const index = item.recordId.slice(separator + 1);
    invariant(separator > 0 && !/[\u0000-\u001f\u007f]/u.test(sourceId) && /^(?:0|[1-9]\d*)$/u.test(index) && Number.isSafeInteger(Number(index)), 'Migration record identity is invalid');
    ids.add(item.recordId);
    safeRelative(item.targetPath);
    invariant(!paths.has(item.targetPath), 'Migration destinations must be unique');
    paths.add(item.targetPath);
    invariant(typeof item.content === 'string' && item.content.length <= 600_000, 'Migration content must be bounded JSON data');
    validateHash(item.sha256, 'Migration artifact hash');
    invariant(sha256(item.content) === item.sha256, 'Migration artifact content hash mismatch');
    const content = inertContent(JSON.parse(item.content));
    invariant(item.targetPath === `imports/${content.sourceHash}-${sha256(sourceId)}-${index}.json`, 'Migration target must be an exact content-addressed inert import path');
    exactKeys(item.proposedEvent, ['type', 'sourceHash', 'sourceModifiedAt', 'plannedAt', 'targetPath', 'artifactHash', 'kind', 'reviewRequired'], 'Proposed migration event');
    const event = item.proposedEvent;
    timestamp(event.plannedAt);
    invariant(event.type === 'migration.import.proposed' && event.reviewRequired === true
      && event.sourceHash === content.sourceHash && event.sourceModifiedAt === content.sourceModifiedAt
      && event.targetPath === item.targetPath && event.artifactHash === item.sha256 && event.kind === content.kind,
    'Migration event is not bound to the exact reviewed data');
  }
  return JSON.parse(canonical(input));
}

export function verifySelectedImport(input, selectedSources) {
  const plan = validateMigrationPlan(input);
  const selected = new Map();
  for (const item of plan.items) {
    const sourceId = item.recordId.slice(0, item.recordId.lastIndexOf(':'));
    const hash = JSON.parse(item.content).sourceHash;
    invariant(!selected.has(sourceId) || selected.get(sourceId) === hash, 'Inconsistent reviewed source identity');
    selected.set(sourceId, hash);
  }
  invariant(selectedSources instanceof Map && selectedSources.size === selected.size, 'Migration source selection must match the reviewed plan exactly');
  for (const [sourceId, expectedHash] of selected) {
    const bytes = selectedSources.get(sourceId);
    invariant(bytes instanceof Uint8Array && sha256(bytes) === expectedHash, 'Migration source changed after review');
  }
  return plan;
}

export async function readMigrationPlan(filename) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    invariant(stat.isFile() && stat.size <= 16 * 1024 * 1024, 'Migration plan must be a bounded regular JSON file');
    return validateMigrationPlan(JSON.parse(await handle.readFile('utf8')));
  } finally { await handle.close(); }
}
