import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const boundary = read('docs/openrappter-personal-and-hosted-services.md');
const notice = read('NOTICE');
const seamText = read('contracts/xpedition-extension-v1.json');
const seam = JSON.parse(seamText) as Schema;
const fixtures = JSON.parse(
  read('contracts/xpedition-extension-v1-fixtures.json'),
) as {
  accepted: Record<string, unknown>[];
  rejected: { reason: string; value: Record<string, unknown> }[];
};

interface SchemaProperty {
  $ref?: string;
  type?: string;
  const?: number;
  pattern?: string;
  enum?: string[];
  minLength?: number;
  maxLength?: number;
}

interface Schema {
  additionalProperties: boolean;
  $defs: Record<string, SchemaProperty>;
  required: string[];
  properties: Record<string, SchemaProperty>;
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0').filter(Boolean);
}

const SHIPPING_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.cts',
  '.js',
  '.cjs',
  '.mjs',
  '.py',
  '.swift',
  '.sh',
  '.ps1',
  '.rb',
  '.html',
  '.css',
]);

const DELIBERATE_EXCLUSIONS = [
  '/__tests__/',
  '/tests/',
  '/fixtures/',
  '/__fixtures__/',
  '/node_modules/',
  '/vendor/',
  '/dist/',
  '/build/',
];

interface InventoryGroup {
  name: string;
  includes(path: string): boolean;
}

const SHIPPING_SURFACES: InventoryGroup[] = [
  { name: 'typescript-core', includes: (path) => path.startsWith('typescript/src/') },
  { name: 'typescript-ui', includes: (path) => path.startsWith('typescript/ui/src/') },
  {
    name: 'typescript-desktop',
    includes: (path) => path.startsWith('typescript/desktop/src/'),
  },
  { name: 'beta-electron', includes: (path) => path.startsWith('beta/electron/') },
  { name: 'beta-frontier', includes: (path) => path.startsWith('beta/frontier/') },
  { name: 'beta-scripts', includes: (path) => path.startsWith('beta/scripts/') },
  { name: 'beta-ui', includes: (path) => path.startsWith('beta/ui/') },
  {
    name: 'python-runtime',
    includes: (path) =>
      path.startsWith('python/openrappter/') ||
      path.startsWith('python/nanorappter/'),
  },
  {
    name: 'brainstem-runtime',
    includes: (path) => path.startsWith('rapp_brainstem/'),
  },
  { name: 'macos-swift', includes: (path) => path.startsWith('macos/Sources/') },
  {
    name: 'installers-and-scripts',
    includes: (path) =>
      path.startsWith('scripts/') ||
      path.startsWith('typescript/bin/') ||
      path.startsWith('typescript/scripts/') ||
      path.startsWith('typescript/desktop/scripts/') ||
      path.startsWith('python/scripts/') ||
      path.startsWith('macos/scripts/') ||
      path.startsWith('macos/homebrew/') ||
      path === 'install.sh' ||
      path === 'install.ps1' ||
      path === 'install-pinned.sh' ||
      path === 'beta/install.sh' ||
      path === 'docs/install.sh' ||
      path === 'docs/install.ps1',
  },
];

const MANIFEST_PATTERN =
  /(^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pyproject\.toml|requirements[^/]*\.txt|Package\.swift)$/;

const MANIFEST_GROUPS: InventoryGroup[] = [
  {
    name: 'typescript-package',
    includes: (path) => /^typescript\/(?:package|npm-shrinkwrap)/.test(path),
  },
  {
    name: 'typescript-ui-package',
    includes: (path) => path.startsWith('typescript/ui/package'),
  },
  {
    name: 'typescript-desktop-package',
    includes: (path) => path.startsWith('typescript/desktop/package'),
  },
  {
    name: 'beta-package',
    includes: (path) => /^beta\/package/.test(path),
  },
  {
    name: 'beta-e2e-package',
    includes: (path) => path === 'beta/tests/e2e/package.json',
  },
  {
    name: 'python-package',
    includes: (path) => path === 'python/pyproject.toml',
  },
  {
    name: 'brainstem-package',
    includes: (path) => path.startsWith('rapp_brainstem/requirements'),
  },
  {
    name: 'macos-package',
    includes: (path) => path === 'macos/Package.swift',
  },
];

const FORBIDDEN_RUNTIME_PATTERNS: { name: string; pattern: RegExp }[] = [
  {
    name: 'proprietary package scope',
    pattern: /@(?:rapterbox|rapteros)\//i,
  },
  {
    name: 'proprietary Python import',
    pattern: /(?:from|import)\s+rapteros(?:[.\s]|$)/i,
  },
  {
    name: 'private service URL',
    pattern:
      /https?:\/\/(?:[^/"'\s]*\.)?(?:rapteros|rapterbox)\.|https?:\/\/github\.com\/(?:rapterbox|rapteros)(?:\/|$)/i,
  },
  {
    name: 'private API path',
    pattern:
      /['"`]\/(?:(?:api\/)?v\d+\/)?(?:tenants?|billing|entitlements?|control-plane)(?:\/|['"`])/i,
  },
  {
    name: 'private runtime artifact',
    pattern:
      /\b(?:RapterOSClient|RapterOSTenant|RapterOSBilling|RapterOSControlPlane|rapterosTelemetry)\b/,
  },
  {
    name: 'private environment hook',
    pattern: /\bRAPTEROS_(?:TOKEN|API|TENANT|BILLING|TELEMETRY|CONTROL_PLANE)\b/,
  },
  {
    name: 'private telemetry endpoint',
    pattern: /\btelemetry\.(?:rapteros|rapterbox)\b/i,
  },
];

function deliberatelyExcluded(path: string): boolean {
  return DELIBERATE_EXCLUSIONS.some((part) => path.includes(part)) ||
    /(?:^|\/)[^/]+\.test\.[^.]+$/.test(path);
}

function shippingGroupsFor(path: string): InventoryGroup[] {
  if (!SHIPPING_EXTENSIONS.has(extname(path)) || deliberatelyExcluded(path)) {
    return [];
  }
  return SHIPPING_SURFACES.filter((surface) => surface.includes(path));
}

function manifestGroupsFor(path: string): InventoryGroup[] {
  if (!MANIFEST_PATTERN.test(path)) return [];
  return MANIFEST_GROUPS.filter((group) => group.includes(path));
}

function findLeakage(content: string): string[] {
  return FORBIDDEN_RUNTIME_PATTERNS
    .filter(({ pattern }) => pattern.test(content))
    .map(({ name }) => name);
}

function validatesDescriptor(value: Record<string, unknown>): boolean {
  const allowed = new Set(Object.keys(seam.properties));
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (seam.required.some((key) => !(key in value))) return false;
  for (const [key, rule] of Object.entries(seam.properties)) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    const referenced = rule.$ref
      ? seam.$defs[rule.$ref.replace('#/$defs/', '')]
      : undefined;
    const effective = { ...referenced, ...rule };
    if (effective.const !== undefined && candidate !== effective.const) return false;
    if (effective.type && typeof candidate !== effective.type) return false;
    if (
      effective.enum &&
      (typeof candidate !== 'string' || !effective.enum.includes(candidate))
    ) return false;
    if (
      effective.pattern &&
      (typeof candidate !== 'string' ||
        !new RegExp(effective.pattern).test(candidate))
    ) return false;
    if (
      typeof candidate === 'string' &&
      effective.minLength !== undefined &&
      candidate.length < effective.minLength
    ) return false;
    if (
      typeof candidate === 'string' &&
      effective.maxLength !== undefined &&
      candidate.length > effective.maxLength
    ) return false;
  }
  return true;
}

describe('open core and separately operated service boundary', () => {
  it('accurately scopes the repository license and its imported carve-outs', () => {
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

  it('preserves open self-host rights without promising hosted entitlement', () => {
    expect(boundary).toContain('self-host or mutate their fork');
    expect(boundary).toContain('do not automatically create');
    expect(boundary).toContain('implementation, service, and data');
    expect(boundary).toContain('not legal advice');
  });

  it('accepts only closed local routes and public read/view capabilities', () => {
    expect(seam.additionalProperties).toBe(false);
    expect(seam.required).toContain('routeId');
    expect(seam.required).not.toContain('href');
    expect(seam.properties.routeId?.enum).toHaveLength(19);
    expect(seam.properties.requiredCapability?.enum).toEqual([
      'ui:view',
      'agent:read',
      'channel:read',
      'session:read',
      'skill:read',
      'system:read',
      'memory:read',
    ]);
    expect(seam.properties.fragment?.pattern).toBe(
      '^#(?!.*(?:tenant|billing|admin|control-plane|telemetry|token|secret|authorization))[a-z][a-z0-9-]{0,63}$',
    );
    expect(seam.properties.title?.$ref).toBe('#/$defs/safeDisplayText');
    expect(seam.properties.description?.$ref).toBe('#/$defs/safeDisplayText');
    for (const fixture of fixtures.accepted) {
      expect(validatesDescriptor(fixture), JSON.stringify(fixture)).toBe(true);
    }
  });

  it('rejects unsafe values in every descriptor string', () => {
    expect(fixtures.rejected.length).toBeGreaterThanOrEqual(10);
    for (const fixture of fixtures.rejected) {
      expect(
        validatesDescriptor(fixture.value),
        `${fixture.reason}: ${JSON.stringify(fixture.value)}`,
      ).toBe(false);
    }

    const titleOnly = fixtures.rejected.find(({ reason }) =>
      reason.startsWith('title only')
    );
    const descriptionOnly = fixtures.rejected.find(({ reason }) =>
      reason.startsWith('description only')
    );
    expect(titleOnly).toBeDefined();
    expect(descriptionOnly).toBeDefined();
    expect(validatesDescriptor({
      ...titleOnly!.value,
      title: 'Agent Explorer',
    })).toBe(true);
    expect(validatesDescriptor({
      ...descriptionOnly!.value,
      description: 'Inspect local runtime health and agent workflows.',
    })).toBe(true);
  });

  it('contains no private dependency or URL in the public seam or packages', () => {
    expect(seamText).not.toMatch(
      /@(?:rapterbox|rapteros)\/|https?:\/\/(?:[^/"'\s]*\.)?(?:rapteros|rapterbox)\./i,
    );
    const schemaUrls = [...seamText.matchAll(/https?:\/\/[^"\s]+/g)]
      .map((match) => new URL(match[0]));
    expect(schemaUrls.length).toBeGreaterThan(0);
    for (const url of schemaUrls) {
      expect(['json-schema.org', 'openrappter.dev']).toContain(url.hostname);
      expect(url.username).toBe('');
      expect(url.password).toBe('');
      expect(url.search).toBe('');
    }

    const manifests = trackedFiles().filter((path) => MANIFEST_PATTERN.test(path));
    expect(manifests.length).toBeGreaterThan(10);
    for (const path of manifests) {
      expect(manifestGroupsFor(path).length, `${path} is not inventoried`)
        .toBeGreaterThan(0);
      expect(findLeakage(read(path)), path).toEqual([]);
    }
  });

  it('inventories every tracked shipping root and dependency package', () => {
    const tracked = trackedFiles();
    for (const surface of SHIPPING_SURFACES) {
      const files = tracked.filter((path) =>
        surface.includes(path) &&
        SHIPPING_EXTENSIONS.has(extname(path)) &&
        !deliberatelyExcluded(path)
      );
      expect(files.length, `${surface.name} has no scanned files`)
        .toBeGreaterThan(0);
    }
    for (const group of MANIFEST_GROUPS) {
      const manifests = tracked.filter((path) =>
        MANIFEST_PATTERN.test(path) && group.includes(path)
      );
      expect(manifests.length, `${group.name} has no scanned manifests`)
        .toBeGreaterThan(0);
    }
    for (const extension of [
      '.ts', '.tsx', '.js', '.cjs', '.mjs', '.py', '.swift',
    ]) {
      expect(SHIPPING_EXTENSIONS.has(extension), `${extension} unsupported`)
        .toBe(true);
    }
  });

  it('scans all inventoried tracked runtime sources for proprietary leakage', () => {
    const files = trackedFiles().filter((path) =>
      shippingGroupsFor(path).length > 0
    );
    expect(files.length).toBeGreaterThan(300);
    for (const path of files) {
      expect(findLeakage(read(path)), path).toEqual([]);
    }
  });

  it('trips on every previously omitted shipping surface', () => {
    const forbiddenFixtures = [
      {
        path: 'typescript/desktop/src/private.tsx',
        content: "import client from '@rapterbox/private';",
      },
      {
        path: 'beta/electron/private.cjs',
        content: "require('@rapteros/control-plane');",
      },
      {
        path: 'beta/frontier/private.py',
        content: 'from rapteros.private import Client',
      },
      {
        path: 'beta/scripts/private.mjs',
        content: "fetch('/v1/billing/subscription');",
      },
      {
        path: 'beta/ui/private.js',
        content: 'const rapterosTelemetry = () => true;',
      },
      {
        path: 'macos/Sources/OpenRappterBar/Private.swift',
        content: 'let client = RapterOSClient()',
      },
      {
        path: 'scripts/install-private.sh',
        content: 'curl https://api.rapteros.example/control-plane',
      },
    ];
    for (const fixture of forbiddenFixtures) {
      expect(
        shippingGroupsFor(fixture.path).length,
        `${fixture.path} is outside shipping inventory`,
      ).toBeGreaterThan(0);
      expect(findLeakage(fixture.content), fixture.path).not.toEqual([]);
    }

    const manifestFixture = {
      path: 'macos/Package.swift',
      content:
        '.package(url: "https://github.com/rapterbox/private", from: "1.0.0")',
    };
    expect(manifestGroupsFor(manifestFixture.path).length).toBeGreaterThan(0);
    expect(findLeakage(manifestFixture.content)).not.toEqual([]);
  });
});
