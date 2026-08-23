import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const boundary = read('docs/openrappter-personal-and-hosted-services.md');
const notice = read('NOTICE');
const seamText = read('contracts/xpedition-extension-v1.json');
const seam = JSON.parse(seamText) as {
  additionalProperties: boolean;
  required: string[];
  properties: Record<string, unknown>;
};
const fixtures = JSON.parse(
  read('contracts/xpedition-extension-v1-fixtures.json'),
) as {
  accepted: Record<string, unknown>[];
  rejected: { reason: string; value: Record<string, unknown> }[];
};
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateDescriptor = ajv.compile(seam);

interface TrackedEntry {
  mode: string;
  path: string;
}

function trackedEntries(): TrackedEntry[] {
  return execFileSync('git', ['ls-files', '--stage', '-z'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0').filter(Boolean).map((entry) => {
    const match = /^(\d{6}) [0-9a-f]+ \d\t(.+)$/.exec(entry);
    if (!match) throw new Error(`Unexpected git ls-files entry: ${entry}`);
    return { mode: match[1], path: match[2] };
  });
}

const repositoryEntries = trackedEntries();
const repositoryFiles = repositoryEntries.map(({ path }) => path);
const trackedExecutablePaths = new Set(
  repositoryEntries
    .filter(({ mode }) => mode === '100755')
    .map(({ path }) => path),
);

function trackedFiles(): string[] {
  return [...repositoryFiles];
}

const EXECUTABLE_SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.cts',
  '.js',
  '.jsx',
  '.cjs',
  '.mjs',
  '.py',
  '.swift',
  '.sh',
  '.ps1',
  '.bat',
  '.cmd',
  '.rb',
  '.scpt',
  '.html',
  '.css',
]);

const PACKAGED_TEXT_EXTENSIONS = new Set([
  ...EXECUTABLE_SOURCE_EXTENSIONS,
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.txt',
  '.md',
]);

const MANIFEST_PATTERN =
  /(^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|requirements[^/]*\.txt|Pipfile(?:\.lock)?|poetry\.lock|Package\.(?:swift|resolved)|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|Gemfile(?:\.lock)?)$/;

const PUBLIC_BOUNDARY_FILES = new Set([
  'contracts/xpedition-extension-v1.json',
  'contracts/xpedition-extension-v1-fixtures.json',
  'docs/openrappter-personal-and-hosted-services.md',
  'typescript/src/__tests__/docs/open-commercial-boundary.test.ts',
]);

interface ExclusionRule {
  reason: string;
  matches(path: string): boolean;
}

const AUDITED_EXCLUSIONS: ExclusionRule[] = [
  {
    reason:
      'boundary documentation and adversarial fixtures may name the private service descriptively',
    matches: (path) =>
      path === 'docs/openrappter-personal-and-hosted-services.md' ||
      path === 'contracts/xpedition-extension-v1-fixtures.json',
  },
  {
    reason: 'test code is not shipped as runtime or installer code',
    matches: (path) =>
      /(^|\/)(?:tests?|__tests__)(\/|$)/.test(path) ||
      /(?:^|\/)[^/]+\.test\.[^.]+$/.test(path),
  },
  {
    reason: 'fixture corpora are inert test inputs, not packaged runtime code',
    matches: (path) => /(^|\/)(?:fixtures?|__fixtures__)(\/|$)/.test(path),
  },
  {
    reason: 'generated build output is checked through its authored source',
    matches: (path) =>
      /(^|\/)(?:dist|release|coverage|generated)(\/|$)/.test(path),
  },
  {
    reason: 'vendored dependencies are governed by dependency manifests',
    matches: (path) => /(^|\/)(?:node_modules|vendor)(\/|$)/.test(path),
  },
];

interface PackageShipRules {
  base: string;
  include: RegExp[];
  exclude: RegExp[];
}

function fileRuleRegex(rule: string): RegExp {
  const escaped = rule
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\0')
    .replaceAll('*', '[^/]*')
    .replaceAll('\0', '.*');
  return new RegExp(`^${escaped}${rule.endsWith('/') ? '.*' : ''}$`);
}

const packageShipRules: PackageShipRules[] = repositoryFiles
  .filter((path) => basename(path) === 'package.json')
  .flatMap((path) => {
    const manifest = JSON.parse(read(path)) as {
      files?: string[];
      build?: { files?: string[] };
    };
    const rules = [...(manifest.files ?? []), ...(manifest.build?.files ?? [])]
      .filter((rule) => !rule.startsWith('node_modules/'));
    if (rules.length === 0) return [];
    return [{
      base: dirname(path) === '.' ? '' : `${dirname(path)}/`,
      include: rules
        .filter((rule) => !rule.startsWith('!'))
        .map(fileRuleRegex),
      exclude: rules
        .filter((rule) => rule.startsWith('!'))
        .map((rule) => fileRuleRegex(rule.slice(1))),
    }];
  });

function packageShips(path: string): boolean {
  return packageShipRules.some(({ base, include, exclude }) => {
    if (!path.startsWith(base)) return false;
    const relative = path.slice(base.length);
    return include.some((pattern) => pattern.test(relative)) &&
      !exclude.some((pattern) => pattern.test(relative));
  });
}

function isEligibleTrackedPath(path: string): boolean {
  if (PUBLIC_BOUNDARY_FILES.has(path)) return true;
  if (MANIFEST_PATTERN.test(path)) return true;
  if (trackedExecutablePaths.has(path)) return true;
  if (EXECUTABLE_SOURCE_EXTENSIONS.has(extname(path))) return true;
  return packageShips(path) && PACKAGED_TEXT_EXTENSIONS.has(extname(path));
}

function exclusionFor(path: string): ExclusionRule | undefined {
  return AUDITED_EXCLUSIONS.find((rule) => rule.matches(path));
}

interface Inventory {
  eligible: string[];
  scanned: string[];
  excluded: Map<string, string>;
}

function buildInventory(paths: string[]): Inventory {
  const eligible = paths.filter(isEligibleTrackedPath);
  const excluded = new Map<string, string>();
  const scanned: string[] = [];
  for (const path of eligible) {
    if (MANIFEST_PATTERN.test(path)) {
      scanned.push(path);
      continue;
    }
    const exclusion = exclusionFor(path);
    if (exclusion) excluded.set(path, exclusion.reason);
    else scanned.push(path);
  }
  return { eligible, scanned, excluded };
}

function unclassifiedEligiblePaths(
  paths: string[],
  scanned: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
): string[] {
  return paths.filter((path) =>
    isEligibleTrackedPath(path) &&
    !scanned.has(path) &&
    !excluded.has(path)
  );
}

interface RootAssertion {
  name: string;
  matches(path: string): boolean;
}

// Assertions only: these do not decide what gets scanned. Eligibility is
// extension/package driven, so a new executable path is covered by default.
const KNOWN_SHIPPING_ROOTS: RootAssertion[] = [
  { name: 'TypeScript runtime', matches: (path) => path.startsWith('typescript/src/') },
  { name: 'TypeScript UI', matches: (path) => path.startsWith('typescript/ui/src/') },
  {
    name: 'TypeScript desktop',
    matches: (path) => path.startsWith('typescript/desktop/src/'),
  },
  { name: 'beta Electron', matches: (path) => path.startsWith('beta/electron/') },
  { name: 'beta frontier', matches: (path) => path.startsWith('beta/frontier/') },
  { name: 'beta scripts', matches: (path) => path.startsWith('beta/scripts/') },
  { name: 'beta UI', matches: (path) => path.startsWith('beta/ui/') },
  { name: 'beta packaged resources', matches: (path) => path.startsWith('beta/resources/') },
  {
    name: 'TypeScript packaged skills',
    matches: (path) => path.startsWith('typescript/skills/'),
  },
  {
    name: 'Python runtime',
    matches: (path) =>
      path.startsWith('python/openrappter/') ||
      path.startsWith('python/nanorappter/'),
  },
  { name: 'brainstem runtime', matches: (path) => path.startsWith('rapp_brainstem/') },
  { name: 'macOS Swift', matches: (path) => path.startsWith('macos/Sources/') },
  { name: 'root tools', matches: (path) => path.startsWith('tools/') },
  { name: 'root scripts', matches: (path) => path.startsWith('scripts/') },
  {
    name: 'installers',
    matches: (path) =>
      /(^|\/)(?:install|install-pinned)\.(?:sh|ps1|bat|cmd)$/.test(path) ||
      path.startsWith('macos/scripts/') ||
      path.startsWith('typescript/desktop/scripts/'),
  },
];

const KNOWN_MANIFEST_ROOTS: RootAssertion[] = [
  {
    name: 'TypeScript package',
    matches: (path) => /^typescript\/(?:package|npm-shrinkwrap)/.test(path),
  },
  {
    name: 'TypeScript UI package',
    matches: (path) => path.startsWith('typescript/ui/package'),
  },
  {
    name: 'TypeScript desktop package',
    matches: (path) => path.startsWith('typescript/desktop/package'),
  },
  { name: 'beta package', matches: (path) => /^beta\/package/.test(path) },
  {
    name: 'beta e2e package',
    matches: (path) => path === 'beta/tests/e2e/package.json',
  },
  { name: 'Python package', matches: (path) => path === 'python/pyproject.toml' },
  {
    name: 'brainstem requirements',
    matches: (path) => path.startsWith('rapp_brainstem/requirements'),
  },
  { name: 'macOS package', matches: (path) => path === 'macos/Package.swift' },
];

interface LeakagePattern {
  name: string;
  pattern: RegExp;
}

const FORBIDDEN_RUNTIME_PATTERNS: LeakagePattern[] = [
  {
    name: 'RapterOS or RapterBox private identity',
    pattern: /rapteros|rapterbox/i,
  },
  {
    name: 'private tenant/billing/control-plane contract',
    pattern:
      /\b(?:TenantContext|TenantRepository|TenantStore|TenantScoped(?:Query|Repository)|BillingProvider|BillingWebhook|Entitlement(?:Contract|Provider|Service)|ControlPlane(?:Client|Server|Service|Repository))\b/i,
  },
  {
    name: 'private API endpoint marker',
    pattern:
      /['"`]\/(?:(?:api\/)?v\d+\/)(?:tenants?|billing|entitlements?|control-plane)(?:\/|['"`])/i,
  },
  {
    name: 'private telemetry hook',
    pattern:
      /\b(?:TenantTelemetryHook|BillingTelemetryHook|ControlPlaneTelemetry|CommercialTelemetryHook|PrivateTelemetryHook)\b/i,
  },
];

function findLeakage(content: string): string[] {
  return FORBIDDEN_RUNTIME_PATTERNS
    .filter(({ pattern }) => pattern.test(content))
    .map(({ name }) => name);
}

const DEPENDENCY_MAP_KEYS = new Set([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'bundledDependencies',
]);

function dependencyEntries(value: unknown): [string, string][] {
  if (!value || typeof value !== 'object') return [];
  const entries: [string, string][] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (DEPENDENCY_MAP_KEYS.has(key) && child && typeof child === 'object') {
      for (const [name, specifier] of Object.entries(
        child as Record<string, unknown>,
      )) {
        entries.push([name, String(specifier)]);
      }
    }
    entries.push(...dependencyEntries(child));
  }
  return entries;
}

function inspectManifest(path: string, content: string): string[] {
  const findings = new Set(findLeakage(content));
  if (basename(path).endsWith('.json')) {
    const parsed = JSON.parse(content) as unknown;
    for (const [name, specifier] of dependencyEntries(parsed)) {
      for (const finding of findLeakage(`${name}\n${specifier}`)) {
        findings.add(`dependency: ${finding}`);
      }
    }
  }
  return [...findings];
}

describe('open core and separately operated service boundary', () => {
  it('accurately scopes the repository license and imported carve-outs', () => {
    expect(read('LICENSE')).toContain('Apache License');
    expect(JSON.parse(read('typescript/package.json')).license).toBe('Apache-2.0');
    expect(boundary).toContain('OpenRappter-authored');
    expect(boundary).toContain('[`LICENSE`](../LICENSE)');
    expect(boundary).toContain('[`NOTICE`](../NOTICE)');
    expect(boundary).toContain('mixed-license repository');
    expect(boundary).toContain('`beta/` and `rapp_brainstem/`');
    expect(boundary).toContain('licenses/aibast-agents-library-MIT.txt');
    expect(notice).toContain('`beta/` and `rapp_brainstem/`');
    expect(notice).toContain('under the MIT License');
    expect(read('licenses/aibast-agents-library-MIT.txt')).toContain('MIT License');
  });

  it('uses only closed trusted-registry selector fields', () => {
    expect(seam.additionalProperties).toBe(false);
    expect(seam.required).toEqual(['appId', 'surfaceVersion']);
    expect(Object.keys(seam.properties).sort()).toEqual([
      'appId',
      'capabilityIds',
      'order',
      'surfaceVersion',
    ]);
    for (const forbiddenField of [
      'id',
      'title',
      'description',
      'glyph',
      'href',
      'url',
      'fragment',
      'routeId',
      'code',
    ]) {
      expect(seam.properties).not.toHaveProperty(forbiddenField);
    }
    expect(boundary).toMatch(
      /trusted\s+OpenRappter host registry supplies/,
    );
    expect(boundary).toMatch(
      /future, separately reviewed and sandboxed contract/,
    );
  });

  it('accepts registered selectors and rejects every former payload shape', () => {
    for (const fixture of fixtures.accepted) {
      expect(validateDescriptor(fixture), JSON.stringify(validateDescriptor.errors))
        .toBe(true);
    }
    expect(fixtures.rejected.length).toBeGreaterThanOrEqual(15);
    for (const fixture of fixtures.rejected) {
      expect(
        validateDescriptor(fixture.value),
        `${fixture.reason}: ${JSON.stringify(fixture.value)}`,
      ).toBe(false);
    }
  });

  it('builds a default-cover inventory with audited exclusions only', () => {
    const tracked = trackedFiles();
    const inventory = buildInventory(tracked);
    expect(inventory.scanned.length).toBeGreaterThan(700);
    expect(inventory.excluded.size).toBeGreaterThan(100);
    expect(
      unclassifiedEligiblePaths(
        tracked,
        new Set(inventory.scanned),
        new Set(inventory.excluded.keys()),
      ),
    ).toEqual([]);

    for (const rootAssertion of KNOWN_SHIPPING_ROOTS) {
      const count = inventory.scanned.filter(rootAssertion.matches).length;
      expect(count, `${rootAssertion.name} contributed no scanned files`)
        .toBeGreaterThan(0);
    }
    for (const manifestAssertion of KNOWN_MANIFEST_ROOTS) {
      const count = inventory.scanned.filter((path) =>
        MANIFEST_PATTERN.test(path) && manifestAssertion.matches(path)
      ).length;
      expect(count, `${manifestAssertion.name} contributed no manifest`)
        .toBeGreaterThan(0);
    }
    for (const [path, reason] of inventory.excluded) {
      expect(reason.length, `${path} has no audited exclusion reason`)
        .toBeGreaterThan(10);
    }
    expect(
      inventory.excluded.get(
        'docs/openrappter-personal-and-hosted-services.md',
      ),
    ).toContain('boundary documentation');
    expect(
      inventory.excluded.get(
        'contracts/xpedition-extension-v1-fixtures.json',
      ),
    ).toContain('adversarial fixtures');
  });

  it('scans every eligible runtime source and dependency manifest', () => {
    const inventory = buildInventory(trackedFiles());
    for (const path of inventory.scanned) {
      const content = read(path);
      const findings = MANIFEST_PATTERN.test(path)
        ? inspectManifest(path, content)
        : findLeakage(content);
      expect(findings, path).toEqual([]);
    }
  });

  it('trips for every omitted surface and private dependency syntax', () => {
    const runtimeFixtures = [
      ['typescript/desktop/src/private.tsx', "import('@RapterBox/private')"],
      ['beta/electron/private.cjs', "require('RapterOS-control-plane')"],
      ['beta/frontier/private.py', 'from rapteros.private import Client'],
      ['beta/scripts/private.mjs', "fetch('/v1/billing/subscription')"],
      ['beta/ui/private.js', 'const context = new TenantContext()'],
      ['beta/resources/private.json', '{"hook":"BillingTelemetryHook"}'],
      ['python/openrappter/private.py', 'provider: BillingProvider'],
      ['macos/Sources/OpenRappterBar/Private.swift', 'ControlPlaneClient()'],
      ['tools/private.mjs', "import('RAPTEROS/private')"],
      ['install-private.bat', 'curl //api.RapterBox.example/control-plane'],
    ] as const;
    for (const [path, content] of runtimeFixtures) {
      expect(isEligibleTrackedPath(path), `${path} is not eligible`).toBe(true);
      expect(exclusionFor(path), `${path} was unexpectedly excluded`).toBeUndefined();
      expect(findLeakage(content), path).not.toEqual([]);
    }

    const dependencyFixtures = [
      ['package.json', '{"dependencies":{"@RapterBox/sdk":"1.0.0"}}'],
      [
        'package-lock.json',
        '{"packages":{"":{"dependencies":{"rapteros-sdk":"RapterBox/private"}}}}',
      ],
      [
        'npm-shrinkwrap.json',
        '{"dependencies":{"private":{"version":"git+ssh://git@github.com/RapterOS/private.git"}}}',
      ],
      [
        'python/pyproject.toml',
        'dependencies = ["private @ git+ssh://git@github.com/RapterBox/private.git"]',
      ],
      [
        'rapp_brainstem/requirements.txt',
        'private @ git+ssh://git@github.com/RapterOS/private.git',
      ],
      [
        'macos/Package.swift',
        '.package(url: "git@github.com:RapterBox/private.git", from: "1.0.0")',
      ],
      [
        'typescript/package.json',
        '{"dependencies":{"private":"github:RapterOS/private"}}',
      ],
    ] as const;
    for (const [path, content] of dependencyFixtures) {
      expect(MANIFEST_PATTERN.test(path), `${path} is not a manifest`).toBe(true);
      expect(inspectManifest(path, content), path).not.toEqual([]);
    }
  });

  it('reverse inventory fails when a new eligible tracked path is unaccounted', () => {
    const tracked = trackedFiles();
    const inventory = buildInventory(tracked);
    const injected = 'future/new-runtime/private-surface.ts';
    expect(isEligibleTrackedPath(injected)).toBe(true);
    expect(
      unclassifiedEligiblePaths(
        [...tracked, injected],
        new Set(inventory.scanned),
        new Set(inventory.excluded.keys()),
      ),
    ).toEqual([injected]);

    const refreshed = buildInventory([...tracked, injected]);
    expect(refreshed.scanned).toContain(injected);
  });
});
