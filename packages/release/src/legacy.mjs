import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { ARTIFACT_POLICY, digest, invariant, readContract, requireRealDirectory, safeRelative } from './common.mjs';
import { inspectAsar, machOArchitectures } from './asar.mjs';
import { inventoryTree } from './inventory.mjs';

const POLICY = readContract('legacy-policy.json');
const ALLOWLIST = readContract('legacy-allowlist.json');
invariant(ALLOWLIST.schema === 'rapp-work.legacy-allowlist/1'
  && ALLOWLIST.migrationFixtures.every(entry => /^tests\/fixtures\/migration\/[a-z0-9-]+\.json$/u.test(entry.path) && typeof entry.reason === 'string' && entry.reason.length > 0)
  && ALLOWLIST.normativeWireIdentifiers.every(entry => /^[a-z][a-z0-9-]+\/[1-9]\d*$/u.test(entry.identifier) && typeof entry.reason === 'string' && entry.reason.length > 0),
'Only exact normative wire identifiers and inert JSON migration fixtures may be allowlisted');
const CODE = /\.(?:[cm]?[jt]sx?)$/iu;
const TEST_FIXTURES = new Set(ALLOWLIST.migrationFixtures.map(entry => entry.path));
const WIRE_IDS = new Set(ALLOWLIST.normativeWireIdentifiers.map(entry => entry.identifier));

function decoded(text) {
  return text.replace(/\\u\{([a-f\d]{1,6})\}|\\u([a-f\d]{4})|\\x([a-f\d]{2})/giu, (_, wide, short, byte) => {
    const code = Number.parseInt(wide ?? short ?? byte, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
  }).replace(/\\(["'`/])/gu, '$1');
}

function maskWireIdentifiers(text) {
  return text.replace(/(["'`])([^"'`\r\n]*)\1/gu, (whole, quote, value) => WIRE_IDS.has(value) ? `${quote}normative-wire-identifier${quote}` : whole);
}

function forbiddenIdentifier(text) {
  const lower = text.toLowerCase();
  return POLICY.forbiddenIdentifiers.find(identifier => lower.includes(identifier.toLowerCase()));
}

function checkName(relative, errors) {
  const parts = relative.toLowerCase().split('/');
  if (parts.some(part => POLICY.forbiddenPathSegments.includes(part))) errors.push(`Removed path: ${relative}`);
  if (POLICY.forbiddenExtensions.some(extension => relative.toLowerCase().endsWith(extension))) errors.push(`Removed executable/asset type: ${relative}`);
  if (POLICY.forbiddenFiles.some(file => path.posix.basename(relative).toLowerCase() === file.toLowerCase())) errors.push(`Removed file: ${relative}`);
  const identifier = forbiddenIdentifier(relative);
  if (identifier) errors.push(`Removed identifier in path: ${relative}`);
}

function checkImports(text, relative, errors) {
  function checkSpecifier(specifier) {
    const parts = specifier.replaceAll('\\', '/').split('/');
    if (forbiddenIdentifier(specifier) || parts.some(part => POLICY.forbiddenRoots.includes(part) && specifier !== 'typescript')) {
      errors.push(`Removed source import in ${relative}: ${specifier}`);
    }
    if (/^(?:https?:|file:|\/)/u.test(specifier)) errors.push(`Non-hermetic source import in ${relative}: ${specifier}`);
    if (specifier.startsWith('.')) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
      if (resolved === '..' || resolved.startsWith('../')) errors.push(`Source import escapes repository: ${relative}`);
    }
  }
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) errors.push(`Unparseable source cannot pass the import gate: ${relative}`);
  function literal(node) {
    while (node && ts.isParenthesizedExpression(node)) node = node.expression;
    return node && ts.isStringLiteralLike(node) ? node.text : null;
  }
  function inspect(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const specifier = literal(node.moduleSpecifier);
      if (specifier === null) errors.push(`Computed module loading is not allowlisted: ${relative}`);
      else checkSpecifier(specifier);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = literal(node.moduleReference.expression);
      if (specifier === null) errors.push(`Computed module loading is not allowlisted: ${relative}`);
      else checkSpecifier(specifier);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const specifier = literal(node.argument.literal);
      if (specifier !== null) checkSpecifier(specifier);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'require'))) {
      const specifier = literal(node.arguments[0]);
      if (specifier === null) errors.push(`Computed module loading is not allowlisted: ${relative}`);
      else checkSpecifier(specifier);
    }
    ts.forEachChild(node, inspect);
  }
  inspect(source);
}

function checkBytes(bytes, relative, errors, { source = false, inspectImports = true } = {}) {
  if (source && TEST_FIXTURES.has(relative)) return;
  const text = decoded(bytes.toString('utf8'));
  const identifier = forbiddenIdentifier(maskWireIdentifiers(text));
  if (identifier) errors.push(`Removed identifier ${identifier} in ${relative}`);
  if (CODE.test(relative) && inspectImports) checkImports(bytes.toString('utf8'), relative, errors);
}

function packageNameAt(parts, index) {
  return parts[index + 1]?.startsWith('@') ? `${parts[index + 1]}/${parts[index + 2] ?? ''}` : parts[index + 1];
}

function asarPathAllowed(relative) {
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] === 'node_modules' && !ARTIFACT_POLICY.runtimePackages.includes(packageNameAt(parts, i))) return false;
  }
  if (ARTIFACT_POLICY.asarFiles.includes(relative)) return true;
  if (ARTIFACT_POLICY.asarDirectories.includes(parts[0])) return /^dist\/[A-Za-z0-9_-]+\.(?:js|cjs|mjs)$/u.test(relative);
  if (parts[0] !== 'node_modules') return false;
  return true;
}

export async function scanAsar(filename) {
  const errors = [];
  const entries = await inspectAsar(filename);
  const modules = new Set();
  for (const entry of entries) {
    checkName(entry.path, errors);
    if (!asarPathAllowed(entry.path)) errors.push(`Unallowlisted ASAR entry: ${entry.path}`);
    const vendor = entry.path.startsWith('node_modules/');
    checkBytes(entry.bytes, `app.asar/${entry.path}`, errors, { inspectImports: !vendor });
    for (const architecture of machOArchitectures(entry.bytes)) {
      if (architecture !== 'arm64') errors.push(`Non-arm64 ASAR executable: ${entry.path}`);
    }
    if (entry.path === 'package.json' || /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/u.test(entry.path)) {
      const manifest = JSON.parse(entry.bytes.toString('utf8'));
      invariant(typeof manifest.name === 'string' && manifest.name.length > 0, `Packaged module has no name: ${entry.path}`);
      modules.add(manifest.name);
      if (entry.path !== 'package.json' && !ARTIFACT_POLICY.runtimePackages.includes(manifest.name)) errors.push(`Unallowlisted packaged module: ${manifest.name}`);
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        if (!ARTIFACT_POLICY.runtimePackages.includes(dependency)) errors.push(`Unallowlisted runtime dependency: ${dependency}`);
      }
      if (entry.path === 'package.json') {
        if (manifest.name !== '@rapp-work/desktop') errors.push('ASAR product package identity mismatch');
        const main = manifest.main;
        if (main !== 'dist/main.js' || !entries.some(candidate => candidate.path === main)) errors.push('ASAR entrypoint is missing or unallowlisted');
      }
    }
  }
  for (const required of ARTIFACT_POLICY.requiredAsarFiles) {
    if (!entries.some(entry => entry.path === required)) errors.push(`Missing ASAR file: ${required}`);
  }
  invariant(errors.length === 0, `Clean ASAR gate failed:\n${errors.join('\n')}`);
  const files = entries.map(({ bytes: _bytes, ...entry }) => entry);
  return { digest: digest(files), entries: files, modules: [...modules].sort() };
}

function appPathAllowed(relative, type) {
  if (relative === 'Contents') return type === 'directory';
  if (['Contents/Info.plist', 'Contents/PkgInfo'].includes(relative)) return type === 'file';
  const parts = relative.split('/');
  if (parts[0] !== 'Contents') return false;
  if (parts[1] === '_CodeSignature') return parts.length === 2 || (parts.length === 3 && parts[2] === 'CodeResources');
  if (parts[1] === 'MacOS') return parts.length === 2 || (parts.length === 3 && parts[2] === 'RAPP Work');
  if (parts[1] === 'Frameworks') return parts.length === 2 || ARTIFACT_POLICY.frameworks.includes(parts[2]);
  if (parts[1] !== 'Resources') return false;
  if (parts.length === 2) return true;
  if (parts[2] === 'host') return parts.length === 3 || (parts.length === 4 && parts[3] === 'host.cjs');
  if (parts[2] === 'ui') {
    return parts.length === 3 || (parts.length === 4 && ['index.html', 'icon.svg'].includes(parts[3]))
      || (parts[3] === 'assets' && (parts.length === 4 || (parts.length === 5 && /^[a-zA-Z0-9_.-]+\.(?:js|css|png|svg|woff2)$/u.test(parts[4]))));
  }
  if (parts[2] === 'app.asar.unpacked') return parts.length === 3 || asarPathAllowed(parts.slice(3).join('/'));
  if (/^[a-z]{2,3}(?:[_-][A-Za-z0-9]+)*\.lproj$/u.test(parts[2])) return parts.length === 3 || (parts.length === 4 && ['locale.pak', 'InfoPlist.strings'].includes(parts[3]));
  return parts.length === 3 && ARTIFACT_POLICY.resources.includes(parts[2]);
}

export async function scanApplication(appPath) {
  const inventory = await inventoryTree(appPath);
  const errors = [];
  let mainArchitecture = false;
  for (const entry of inventory.entries) {
    checkName(entry.path, errors);
    if (!appPathAllowed(entry.path, entry.type)) errors.push(`Unallowlisted application entry: ${entry.path}`);
    if (entry.type !== 'file') continue;
    if (entry.path === 'Contents/Resources/app.asar') continue;
    const bytes = await readFile(path.join(appPath, entry.path));
    checkBytes(bytes, entry.path, errors, { inspectImports: false });
    const architectures = machOArchitectures(bytes);
    if (architectures.length && (architectures.length !== 1 || architectures[0] !== 'arm64')) errors.push(`Application executable is not exclusively arm64: ${entry.path}`);
    if (ARTIFACT_POLICY.nativeFiles.includes(entry.path) && (architectures.length !== 1 || architectures[0] !== 'arm64')) errors.push(`Required native component is not arm64 Mach-O: ${entry.path}`);
    if (entry.path === 'Contents/MacOS/RAPP Work') mainArchitecture = architectures.length === 1 && architectures[0] === 'arm64';
  }
  if (!mainArchitecture) errors.push('The application entrypoint is not an arm64 Mach-O executable');
  for (const resource of ARTIFACT_POLICY.requiredResources) {
    if (!inventory.entries.some(entry => entry.type === 'file' && entry.path === `Contents/Resources/${resource}`)) errors.push(`Missing application resource: ${resource}`);
  }
  for (const component of ARTIFACT_POLICY.requiredComponents) {
    if (!inventory.entries.some(entry => entry.type === 'file' && entry.path === component)) errors.push(`Missing application component: ${component}`);
  }
  invariant(errors.length === 0, `Clean application gate failed:\n${errors.join('\n')}`);
  const asar = await scanAsar(path.join(appPath, 'Contents/Resources/app.asar'));
  return { ...inventory, asar };
}

export async function scanResources(resourcesPath) {
  const inventory = await inventoryTree(resourcesPath);
  const errors = [];
  for (const entry of inventory.entries) {
    checkName(entry.path, errors);
    if (!appPathAllowed(`Contents/Resources/${entry.path}`, entry.type)) errors.push(`Unallowlisted resource: ${entry.path}`);
    if (entry.type === 'file' && entry.path !== 'app.asar') checkBytes(await readFile(path.join(resourcesPath, entry.path)), entry.path, errors, { inspectImports: false });
  }
  invariant(errors.length === 0, `Clean resource gate failed:\n${errors.join('\n')}`);
  return { ...inventory, asar: await scanAsar(path.join(resourcesPath, 'app.asar')) };
}

export async function scanSource(root) {
  root = await requireRealDirectory(root);
  const errors = [];
  const files = [];
  const ignored = new Set(POLICY.ignoredSourceDirectories);
  async function walk(relative = '') {
    const directory = path.join(root, relative);
    for (const name of (await readdir(directory)).sort()) {
      if (ignored.has(name)) continue;
      const candidate = relative ? `${relative}/${name}` : name;
      const stat = await lstat(path.join(root, candidate));
      if (!relative && POLICY.forbiddenRoots.includes(name)) {
        errors.push(`Removed source root still exists: ${name}`);
        continue;
      }
      if (candidate === 'contracts/legacy-policy.json') {
        if (!stat.isFile() || stat.isSymbolicLink()) errors.push('The legacy policy must be a regular source data file');
        continue;
      }
      checkName(candidate, errors);
      if (stat.isDirectory()) await walk(candidate);
      else if (stat.isSymbolicLink()) errors.push(`Source symlink is not allowlisted: ${candidate}`);
      else if (stat.isFile()) {
        files.push(candidate);
        checkBytes(await readFile(path.join(root, candidate)), candidate, errors, { source: true });
      } else errors.push(`Special source file: ${candidate}`);
    }
  }
  await walk();
  const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const workspaces = rootManifest.workspaces;
  invariant(Array.isArray(workspaces) && workspaces.length > 0, 'A declared clean workspace set is required');
  const actual = [];
  for (const workspace of workspaces) {
    invariant(typeof workspace === 'string' && /^(?:apps|packages)\/(?:\*|[a-z][a-z0-9-]*)$/u.test(workspace), `Unallowlisted workspace pattern: ${workspace}`);
    if (workspace.endsWith('/*')) {
      const base = workspace.slice(0, -2);
      for (const file of files) {
        if (file.startsWith(`${base}/`) && file.endsWith('/package.json') && file.split('/').length === 3) actual.push(path.posix.dirname(file));
      }
    } else actual.push(workspace);
  }
  for (const directory of [...new Set(actual)]) {
    if (!POLICY.workspaceDirectories.includes(directory)) errors.push(`Unallowlisted workspace: ${directory}`);
    const manifest = JSON.parse(await readFile(path.join(root, directory, 'package.json'), 'utf8'));
    if (manifest.name !== `@rapp-work/${path.posix.basename(directory)}`) errors.push(`Unexpected workspace package identity: ${directory}`);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        if (forbiddenIdentifier(name) || forbiddenIdentifier(String(version))) errors.push(`Removed workspace dependency: ${directory}: ${name}`);
        if (/^(?:file:|link:)/u.test(String(version))) {
          const resolved = path.posix.normalize(path.posix.join(directory, String(version).slice(5)));
          if (!POLICY.workspaceDirectories.includes(resolved)) errors.push(`Dependency escapes clean workspace: ${directory}: ${name}`);
        }
      }
    }
  }
  invariant(errors.length === 0, `Legacy absence gate failed:\n${errors.slice(0, 80).join('\n')}${errors.length > 80 ? `\n... ${errors.length - 80} more violations` : ''}`);
  return { files: files.length, workspaces: [...new Set(actual)].sort(), allowlist: 'contracts/legacy-allowlist.json' };
}

export async function checkLegacyAbsence({ root, app, asar, resources } = {}) {
  const result = {};
  if (root) result.source = await scanSource(root);
  if (app) result.application = await scanApplication(app);
  if (asar) result.asar = await scanAsar(asar);
  if (resources) result.resources = await scanResources(resources);
  invariant(Object.keys(result).length > 0, 'Select a source tree, application, ASAR, or resources directory');
  return result;
}
