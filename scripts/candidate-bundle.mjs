import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function buildProvenance(root, sourceCommit, version, releaseTag, candidateKind, sourceDateEpoch) {
  const files = fs.readdirSync(root)
    .filter(name => name !== 'provenance.json')
    .sort()
    .map(name => ({ path: name, sha256: sha256(path.join(root, name)) }));
  return {
    schema: 'openrappter-candidate-provenance/v1',
    channel: 'candidate',
    stable: false,
    candidate_kind: candidateKind,
    release_tag: releaseTag,
    source_repository: 'kody-w/openrappter',
    source_commit: sourceCommit,
    source_date_epoch: sourceDateEpoch,
    version,
    files,
  };
}

export function verifyProvenance(root, provenance) {
  const expected = buildProvenance(root, provenance.source_commit, provenance.version, provenance.release_tag, provenance.candidate_kind, provenance.source_date_epoch);
  if (JSON.stringify(expected) !== JSON.stringify(provenance)) {
    throw new Error('candidate provenance or inner bytes changed');
  }
  const names = provenance.files.map(file => file.path);
  if (names.filter(name => /^openrappter-.*\.tgz$/.test(name)).length !== 1) {
    throw new Error('candidate must contain exactly one npm tarball');
  }
  if (!names.some(name => /\.whl$/.test(name)) || !names.some(name => /\.tar\.gz$/.test(name))) {
    throw new Error('candidate must contain Python wheel and sdist');
  }
  for (const installer of ['install.sh', 'install.ps1']) {
    if (!names.includes(installer)) throw new Error(`candidate missing ${installer}`);
  }
}
