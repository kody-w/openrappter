import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ARTIFACT_POLICY, AUTHORITY, canonical, digest, exactKeys, invariant, readContract, sha256, validateHash, validateMode } from './common.mjs';
import { fileDigest, inventoryTree, sourceSnapshot, validateInventory, verifySource } from './inventory.mjs';
import { scanApplication, scanSource } from './legacy.mjs';
import { AppleVerifier, validateTeamIdentifier } from './apple.mjs';

const SCHEMA = 'rapp-work.release/1';
const RECEIPT_SCHEMA = 'rapp-work.build/1';
const RECEIPT_PATH = 'Contents/Resources/rapp-work-build.json';
const SOURCE_KEYS = ['commit', 'dirty', 'digest', 'entries', 'locks'];

export function releaseFilename(version, mode) {
  validateMode(mode);
  invariant(typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(version), 'Release version must be a plain semantic version');
  return `RAPP-Work-${version}-macos-arm64${mode === 'development-unsigned' ? '-UNSIGNED-DEVELOPMENT' : ''}.dmg`;
}

export function publicKeyId(key) {
  const publicKey = key?.type === 'public' ? key : createPublicKey(key);
  invariant(publicKey.asymmetricKeyType === 'ed25519', 'Provenance requires an Ed25519 key');
  return sha256(publicKey.export({ type: 'spki', format: 'der' }));
}

export async function captureBuildInputs(root, mode) {
  validateMode(mode);
  const scanned = await scanSource(root);
  if (mode === 'production') invariant(canonical(scanned.workspaces) === canonical([...readContract('legacy-policy.json').workspaceDirectories].sort()), 'Production requires the complete clean application and package set');
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  invariant(lock.name === 'rapp-work' && lock.lockfileVersion === 3, 'Release requires the clean root npm v3 dependency lock');
  for (const directory of scanned.workspaces) {
    const manifest = JSON.parse(await readFile(path.join(root, directory, 'package.json'), 'utf8'));
    invariant(lock.packages?.[directory]?.version === manifest.version, `Workspace is not pinned in the root lock: ${directory}`);
  }
  const source = await sourceSnapshot(root, { requireClean: mode === 'production' });
  const fixtures = await inventoryTree(path.join(root, ARTIFACT_POLICY.canonicalFixturesRoot));
  invariant(fixtures.entries.some(entry => entry.type === 'file'), 'Canonical RAPP/1 fixtures are required');
  const selected = JSON.parse(await readFile(path.join(root, 'contracts/rapp1-authority.json'), 'utf8'));
  invariant(canonical(selected) === canonical(AUTHORITY), 'Source selected a different RAPP/1 authority');
  return { source, fixtures };
}

export function buildReceipt({ version, mode, source, fixtures }) {
  releaseFilename(version, mode);
  return {
    schema: RECEIPT_SCHEMA,
    product: 'RAPP Work',
    version,
    mode,
    platform: 'darwin',
    architecture: 'arm64',
    authority: AUTHORITY,
    source: { commit: source.commit, digest: source.digest, locksDigest: source.locks.digest, dirty: source.dirty },
    fixturesDigest: fixtures.digest,
  };
}

export async function writeBuildReceipt(appPath, inputs) {
  const receipt = buildReceipt(inputs);
  await writeFile(path.join(appPath, RECEIPT_PATH), `${canonical(receipt)}\n`, { flag: 'wx', mode: 0o644 });
  return receipt;
}

export async function assertBuildReceipt(appPath, payload) {
  const receipt = JSON.parse(await readFile(path.join(appPath, RECEIPT_PATH), 'utf8'));
  const expected = buildReceipt(payload);
  invariant(canonical(receipt) === canonical(expected), 'The sealed application build receipt does not match provenance');
}

function signEnvelope(payload, privateKey) {
  if (payload.mode === 'development-unsigned') {
    invariant(!privateKey, 'Unsigned development provenance must not carry a production signing key');
    return { payload, signature: null };
  }
  invariant(privateKey, 'Production provenance requires a signing key; unsigned production is forbidden');
  const key = privateKey.type === 'private' ? privateKey : createPrivateKey(privateKey);
  invariant(key.asymmetricKeyType === 'ed25519', 'Provenance requires an Ed25519 private key');
  return {
    payload,
    signature: {
      algorithm: 'ed25519',
      keyId: publicKeyId(key),
      value: sign(null, Buffer.from(canonical(payload)), key).toString('base64'),
    },
  };
}

export async function createProvenance({
  root, appPath, dmgPath, version, mode = 'production', teamIdentifier,
  privateKey, source: capturedSource, fixtures: capturedFixtures, apple = new AppleVerifier(),
}) {
  validateMode(mode);
  invariant(path.basename(dmgPath) === releaseFilename(version, mode), 'DMG filename does not identify this release and mode');
  if (mode === 'production') validateTeamIdentifier(teamIdentifier);
  const inputs = await captureBuildInputs(root, mode);
  if (capturedSource) invariant(canonical(inputs.source) === canonical(capturedSource), 'Source changed during packaging');
  if (capturedFixtures) invariant(canonical(inputs.fixtures) === canonical(capturedFixtures), 'Canonical fixtures changed during packaging');
  const { source, fixtures } = inputs;
  const app = await scanApplication(appPath);
  const signing = await apple.application(appPath, { mode, teamIdentifier, version });
  await apple.dmg(dmgPath, { mode, teamIdentifier });
  const payload = {
    schema: SCHEMA,
    product: 'RAPP Work',
    version,
    mode,
    platform: 'darwin',
    architecture: 'arm64',
    authority: AUTHORITY,
    source,
    fixtures,
    app: { name: ARTIFACT_POLICY.applicationName, bundleIdentifier: ARTIFACT_POLICY.bundleIdentifier, ...app },
    dmg: { name: path.basename(dmgPath), ...await fileDigest(dmgPath) },
    signing,
  };
  await assertBuildReceipt(appPath, payload);
  const after = await sourceSnapshot(root, { requireClean: mode === 'production' });
  invariant(canonical(after) === canonical(source), 'Source changed while release evidence was being verified');
  const envelope = signEnvelope(payload, privateKey);
  validatePayload(payload);
  return envelope;
}

function validatePayload(payload) {
  exactKeys(payload, ['schema', 'product', 'version', 'mode', 'platform', 'architecture', 'authority', 'source', 'fixtures', 'app', 'dmg', 'signing'], 'Release payload');
  invariant(payload.schema === SCHEMA && payload.product === 'RAPP Work', 'Unexpected release schema or product');
  validateMode(payload.mode);
  invariant(payload.platform === 'darwin' && payload.architecture === 'arm64', 'Only macOS arm64 artifacts are releasable');
  invariant(canonical(payload.authority) === canonical(AUTHORITY), 'Noncanonical RAPP/1 authority identity');
  invariant(payload.dmg.name === releaseFilename(payload.version, payload.mode), 'DMG release identity mismatch');
  exactKeys(payload.dmg, ['name', 'size', 'sha256'], 'DMG');
  validateHash(payload.dmg.sha256, 'DMG digest');
  invariant(Number.isSafeInteger(payload.dmg.size) && payload.dmg.size > 0, 'DMG size is invalid');
  exactKeys(payload.source, SOURCE_KEYS, 'Source');
  invariant(/^[a-f0-9]{40}$/u.test(payload.source.commit), 'Source commit is invalid');
  invariant(typeof payload.source.dirty === 'boolean', 'Source cleanliness is not explicit');
  validateInventory(payload.source, 'Complete source');
  validateInventory(payload.source.locks, 'Lockfiles');
  const expectedLocks = payload.source.entries.filter(entry => /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/u.test(entry.path));
  invariant(expectedLocks.some(entry => entry.path === 'package-lock.json'), 'The committed root dependency lock is missing');
  invariant(canonical(expectedLocks) === canonical(payload.source.locks.entries), 'The lockfile inventory is incomplete');
  validateInventory(payload.fixtures, 'Canonical fixtures');
  const fixtureFiles = payload.fixtures.entries.filter(entry => entry.type !== 'directory');
  const fixturePrefix = `${ARTIFACT_POLICY.canonicalFixturesRoot}/`;
  const sourceFixtures = payload.source.entries.filter(entry => entry.path.startsWith(fixturePrefix))
    .map(entry => ({ ...entry, path: entry.path.slice(fixturePrefix.length) }));
  invariant(canonical(fixtureFiles) === canonical(sourceFixtures), 'Canonical fixture inventory is not the complete source fixture set');
  validateInventory(payload.app, 'Application');
  invariant(payload.app.name === ARTIFACT_POLICY.applicationName && payload.app.bundleIdentifier === ARTIFACT_POLICY.bundleIdentifier, 'Application identity mismatch');
  invariant(payload.app.asar && Array.isArray(payload.app.asar.entries) && Array.isArray(payload.app.asar.modules), 'Complete ASAR module inventory is required');
  invariant(digest(payload.app.asar.entries) === payload.app.asar.digest, 'ASAR inventory digest mismatch');
  if (payload.mode === 'production') {
    invariant(payload.source.dirty === false, 'Production artifacts cannot originate from dirty source');
    exactKeys(payload.signing, ['teamIdentifier', 'bundleIdentifier', 'hardenedRuntime', 'notarized', 'stapled'], 'Apple signing evidence');
    validateTeamIdentifier(payload.signing.teamIdentifier);
    invariant(payload.signing.bundleIdentifier === ARTIFACT_POLICY.bundleIdentifier, 'Signed application identity mismatch');
    invariant(payload.signing.hardenedRuntime === true && payload.signing.notarized === true && payload.signing.stapled === true, 'Production requires signing, hardened runtime, notarization and stapling');
  } else invariant(payload.signing === null, 'An unsigned development artifact must not claim Apple production verification');
}

export function verifyProvenance(envelope, { mode = 'production', trustedPublicKey, teamIdentifier, expectedCommit } = {}) {
  validateMode(mode);
  exactKeys(envelope, ['payload', 'signature'], 'Provenance envelope');
  validatePayload(envelope.payload);
  const payload = envelope.payload;
  invariant(payload.mode === mode, 'Artifact mode differs from the explicitly requested installation mode');
  if (mode === 'production') {
    invariant(trustedPublicKey, 'Production verification requires an independently trusted public key');
    validateTeamIdentifier(teamIdentifier);
    invariant(payload.signing.teamIdentifier === teamIdentifier, 'Provenance signer team differs from the trusted team');
    exactKeys(envelope.signature, ['algorithm', 'keyId', 'value'], 'Provenance signature');
    const key = trustedPublicKey.type === 'public' ? trustedPublicKey : createPublicKey(trustedPublicKey);
    invariant(envelope.signature.algorithm === 'ed25519' && envelope.signature.keyId === publicKeyId(key), 'Provenance signing key is not trusted');
    invariant(typeof envelope.signature.value === 'string' && /^[A-Za-z0-9+/]{86}==$/u.test(envelope.signature.value), 'Malformed provenance signature');
    invariant(verify(null, Buffer.from(canonical(payload)), key, Buffer.from(envelope.signature.value, 'base64')), 'Provenance signature verification failed');
  } else invariant(envelope.signature === null, 'Development mode only accepts explicitly unsigned development artifacts');
  if (expectedCommit) invariant(payload.source.commit === expectedCommit, 'Artifact source commit differs from the trusted release commit');
  return payload;
}

export async function verifyDmgBytes(dmgPath, envelope, trust = {}) {
  const payload = verifyProvenance(envelope, trust);
  invariant(path.basename(dmgPath) === payload.dmg.name, 'DMG filename mismatch');
  const actual = await fileDigest(dmgPath);
  invariant(actual.sha256 === payload.dmg.sha256 && actual.size === payload.dmg.size, 'DMG checksum mismatch; artifact was altered');
  return payload;
}

export async function verifyApplication(appPath, envelope, { apple = new AppleVerifier(), ...trust } = {}) {
  const payload = verifyProvenance(envelope, trust);
  const actual = await scanApplication(appPath);
  invariant(actual.digest === payload.app.digest && canonical(actual.entries) === canonical(payload.app.entries), 'Complete application tree mismatch; artifact was altered');
  invariant(canonical(actual.asar) === canonical(payload.app.asar), 'Complete packaged module inventory mismatch');
  await assertBuildReceipt(appPath, payload);
  const signing = await apple.application(appPath, { mode: payload.mode, teamIdentifier: trust.teamIdentifier, version: payload.version });
  invariant(canonical(signing) === canonical(payload.signing), 'Apple verification differs from signed release evidence');
  return payload;
}

export async function verifyRelease({ root, appPath, dmgPath, envelope, apple = new AppleVerifier(), ...trust }) {
  const payload = await verifyDmgBytes(dmgPath, envelope, trust);
  await verifyApplication(appPath, envelope, { ...trust, apple });
  await apple.dmg(dmgPath, { mode: payload.mode, teamIdentifier: trust.teamIdentifier });
  if (root) {
    await scanSource(root);
    await verifySource(root, payload.source);
    invariant((await inventoryTree(path.join(root, ARTIFACT_POLICY.canonicalFixturesRoot))).digest === payload.fixtures.digest, 'Canonical fixture tree differs from provenance');
  }
  return { status: 'verified', mode: payload.mode, commit: payload.source.commit, appDigest: payload.app.digest, dmgDigest: payload.dmg.sha256 };
}
