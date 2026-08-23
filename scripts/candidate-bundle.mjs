import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function candidateStoragePath(sourceCommit, kind, id) {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit) || !['snapshot', 'release'].includes(kind) || !/^[A-Za-z0-9._%-]+$/.test(id)) {
    throw new Error('invalid candidate namespace');
  }
  return `candidates/${sourceCommit}/${kind}/${id}`;
}

export function addCandidateIndexEntry(index, entry) {
  const value = structuredClone(index);
  const key = entry.kind === 'release' ? 'releases' : 'snapshots';
  const old = value[key].find(row => row.id === entry.id);
  const stored = {
    id: entry.id,
    bundle_sha256: entry.bundle_sha256,
    path: entry.path,
    provenance_path: `${entry.path}/provenance.json`,
    source_date_epoch: entry.source_date_epoch,
  };
  if (old && JSON.stringify(old) !== JSON.stringify(stored)) {
    throw new Error('conflicting rebuild for immutable candidate id');
  }
  if (!old) value[key].push(stored);
  value[key].sort((a, b) => a.source_date_epoch - b.source_date_epoch || a.id.localeCompare(b.id));
  return value;
}

export function buildProvenance(root, sourceCommit, versions, releaseTag, candidateKind, candidateId, sourceDateEpoch) {
  const files = fs.readdirSync(root)
    .filter(name => name !== 'provenance.json')
    .sort()
    .map(name => ({ path: name, sha256: sha256(path.join(root, name)) }));
  return {
    schema: 'openrappter-candidate-provenance/v1',
    channel: 'candidate',
    stable: false,
    candidate_kind: candidateKind,
    candidate_id: candidateId,
    release_tag: releaseTag,
    source_repository: 'kody-w/openrappter',
    source_commit: sourceCommit,
    source_date_epoch: sourceDateEpoch,
    versions,
    files,
  };
}

export function verifyProvenance(root, provenance) {
  const expected = buildProvenance(root, provenance.source_commit, provenance.versions, provenance.release_tag, provenance.candidate_kind, provenance.candidate_id, provenance.source_date_epoch);
  if (JSON.stringify(expected) !== JSON.stringify(provenance)) {
    throw new Error('candidate provenance or inner bytes changed');
  }
  if (
    JSON.stringify(Object.keys(provenance.versions).sort())
      !== JSON.stringify(['channel', 'npm', 'pypi', 'runtime'])
    || !Object.values(provenance.versions).every(value => typeof value === 'string' && value.length > 0)
  ) throw new Error('candidate version identities are incomplete');
  if (
    provenance.candidate_kind === 'release'
      ? provenance.release_tag !== `v${provenance.versions.channel}`
      : provenance.release_tag !== null
  ) throw new Error('candidate channel tag contract mismatch');
  const names = provenance.files.map(file => file.path);
  if (names.filter(name => name === `openrappter-${provenance.versions.npm}.tgz`).length !== 1) {
    throw new Error('candidate must contain exactly one npm tarball');
  }
  const pythonVersion = provenance.versions.pypi.replace(/-/g, '_');
  if (
    !names.some(name => name.startsWith(`openrappter-${pythonVersion}-`) && name.endsWith('.whl'))
    || !names.includes(`openrappter-${provenance.versions.pypi}.tar.gz`)
  ) {
    throw new Error('candidate must contain Python wheel and sdist');
  }
  for (const installer of ['install.sh', 'install.ps1']) {
    if (!names.includes(installer)) throw new Error(`candidate missing ${installer}`);
  }
}
