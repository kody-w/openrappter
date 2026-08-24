import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [bundle, docs] = process.argv.slice(2);
if (!bundle || !docs) throw new Error('usage: verify-pages-installer <candidate.tar.gz> <docs>');
const work = path.resolve('.pages-installer-verify');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work);
try {
  const result = spawnSync('tar', ['-xzf', bundle, '-C', work], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`candidate extraction failed: ${result.stderr}`);
  const provenance = JSON.parse(fs.readFileSync(path.join(work, 'provenance.json')));
  if (provenance.schema !== 'openrappter-candidate-provenance/v1' || provenance.stable !== false) {
    throw new Error('candidate provenance rejected');
  }
  for (const name of ['install.sh', 'install.ps1']) {
    const candidate = fs.readFileSync(path.join(work, name));
    const served = fs.readFileSync(path.join(docs, name));
    if (!candidate.equals(served)) throw new Error(`mutable public installer refused: ${name}`);
  }
  console.log('Pages installers match finalized stable candidate bytes');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
