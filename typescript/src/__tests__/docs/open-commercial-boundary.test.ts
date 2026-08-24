import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const readBytes = (path: string) => readFileSync(resolve(root, path));
const boundary = read('docs/openrappter-personal-and-hosted-services.md');
const notice = read('NOTICE');
const seam = JSON.parse(read('contracts/xpedition-extension-v1.json')) as {
  additionalProperties: boolean;
  required: string[];
  properties: Record<string, unknown>;
};
const descriptorFixtures = JSON.parse(
  read('contracts/xpedition-extension-v1-fixtures.json'),
) as {
  accepted: Record<string, unknown>[];
  rejected: { reason: string; value: Record<string, unknown> }[];
};
const binaryAudit = JSON.parse(
  read('contracts/open-commercial-binary-audit.json'),
) as Record<string, { sha256: string; reason: string }>;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateDescriptor = ajv.compile(seam);
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

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

function packageRules(entries: TrackedEntry[]): PackageShipRules[] {
  return entries
    .map(({ path }) => path)
    .filter((path) => basename(path) === 'package.json')
    .flatMap((path) => {
      const manifest = JSON.parse(read(path)) as {
        files?: string[];
        build?: { files?: string[] };
      };
      const rules = [
        ...(manifest.files ?? []),
        ...(manifest.build?.files ?? []),
      ].filter((rule) => !rule.startsWith('node_modules/'));
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
}

function packageShips(path: string, rules: PackageShipRules[]): boolean {
  return rules.some(({ base, include, exclude }) => {
    if (!path.startsWith(base)) return false;
    const relative = path.slice(base.length);
    return include.some((pattern) => pattern.test(relative)) &&
      !exclude.some((pattern) => pattern.test(relative));
  });
}

const CONTENT_FINDING_ALLOWLIST = new Set([
  'contracts/xpedition-extension-v1-fixtures.json',
  'docs/openrappter-personal-and-hosted-services.md',
  'typescript/src/__tests__/docs/open-commercial-boundary.test.ts',
]);

const PRIVATE_IDENTITY_PATTERN =
  /rapter(?:[\s._'"+-])*o(?:[\s._'"+-])*s|rapter(?:[\s._'"+-])*box/i;

interface FindingPattern {
  name: string;
  pattern: RegExp;
}

const PRIVATE_CONTENT_PATTERNS: FindingPattern[] = [
  {
    name: 'private namespace, owner, package, import or host',
    pattern: PRIVATE_IDENTITY_PATTERN,
  },
  {
    name: 'private tenant, billing or control-plane runtime contract',
    pattern:
      /\b(?:TenantContext|TenantRepository|TenantStore|TenantScoped(?:Query|Repository)|BillingProvider|BillingWebhook|Entitlement(?:Contract|Provider|Service)|ControlPlane(?:Client|Server|Service|Repository))\b/i,
  },
  {
    name: 'private runtime endpoint',
    pattern:
      /\/+(?:api\/)?(?:v\d+\/)?(?:control[-_]?plane|tenants?|billing|telemetry)(?=\/|[?#\s"'`)]|$)/i,
  },
  {
    name: 'private telemetry hook',
    pattern:
      /\b(?:TenantTelemetryHook|BillingTelemetryHook|ControlPlaneTelemetry|CommercialTelemetryHook|PrivateTelemetryHook)\b/i,
  },
];

const PRIVATE_PATH_PATTERNS: FindingPattern[] = [
  {
    name: 'private namespace or owner in tracked path',
    pattern: PRIVATE_IDENTITY_PATTERN,
  },
  {
    name: 'private runtime marker in tracked path',
    pattern:
      /(^|\/)(?:control[-_]?plane|tenants?|billing|telemetry)(?=\/|[._-]|$)/i,
  },
];

function findings(content: string, patterns: FindingPattern[]): string[] {
  return patterns
    .filter(({ pattern }) => pattern.test(content))
    .map(({ name }) => name);
}

function normalizedPathFindings(path: string): string[] {
  let normalized = path.replaceAll('\\', '/');
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Invalid escapes remain visible to the raw-path patterns.
  }
  return findings(normalized.toLowerCase(), PRIVATE_PATH_PATTERNS);
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

function textFindings(path: string, content: string): string[] {
  const result = new Set(findings(content, PRIVATE_CONTENT_PATTERNS));
  if (basename(path).endsWith('.json')) {
    const parsed = JSON.parse(content) as unknown;
    for (const [name, specifier] of dependencyEntries(parsed)) {
      for (const finding of findings(
        `${name}\n${specifier}`,
        PRIVATE_CONTENT_PATTERNS,
      )) result.add(`dependency: ${finding}`);
    }
  }
  return [...result];
}

function decodeBoundedText(buffer: Buffer): string | null {
  if (buffer.length > MAX_TEXT_BYTES || buffer.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function digest(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

interface RepositoryAudit {
  contentScanned: string[];
  binaryAudited: string[];
  unclassified: string[];
  pathViolations: { path: string; findings: string[] }[];
  contentViolations: { path: string; findings: string[] }[];
  unsafeBinaries: string[];
}

function auditRepository(
  entries: TrackedEntry[],
  bytesFor: (path: string) => Buffer,
  audit: Record<string, { sha256: string; reason: string }>,
  shippedRules: PackageShipRules[],
): RepositoryAudit {
  const result: RepositoryAudit = {
    contentScanned: [],
    binaryAudited: [],
    unclassified: [],
    pathViolations: [],
    contentViolations: [],
    unsafeBinaries: [],
  };

  for (const entry of entries) {
    const pathIssues = normalizedPathFindings(entry.path);
    if (pathIssues.length > 0) {
      result.pathViolations.push({ path: entry.path, findings: pathIssues });
    }

    const buffer = bytesFor(entry.path);
    const text = decodeBoundedText(buffer);
    if (text !== null) {
      result.contentScanned.push(entry.path);
      const contentIssues = textFindings(entry.path, text);
      if (
        contentIssues.length > 0 &&
        !CONTENT_FINDING_ALLOWLIST.has(entry.path)
      ) {
        result.contentViolations.push({
          path: entry.path,
          findings: contentIssues,
        });
      }
      continue;
    }

    const record = audit[entry.path];
    if (entry.mode === '100755' || (packageShips(entry.path, shippedRules) && !record)) {
      result.unsafeBinaries.push(entry.path);
      continue;
    }
    if (
      !record ||
      record.reason.length < 15 ||
      record.sha256 !== digest(buffer)
    ) {
      result.unclassified.push(entry.path);
      continue;
    }
    result.binaryAudited.push(entry.path);
  }

  return result;
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
  });

  it('keeps the descriptor as a closed trusted-registry selector', () => {
    expect(seam.additionalProperties).toBe(false);
    expect(seam.required).toEqual(['appId', 'surfaceVersion']);
    expect(Object.keys(seam.properties).sort()).toEqual([
      'appId',
      'capabilityIds',
      'order',
      'surfaceVersion',
    ]);
    for (const fixture of descriptorFixtures.accepted) {
      expect(validateDescriptor(fixture), JSON.stringify(validateDescriptor.errors))
        .toBe(true);
    }
    for (const fixture of descriptorFixtures.rejected) {
      expect(
        validateDescriptor(fixture.value),
        `${fixture.reason}: ${JSON.stringify(fixture.value)}`,
      ).toBe(false);
    }
  });

  it('classifies every tracked file as content-scanned or binary-audited', () => {
    const entries = trackedEntries();
    const result = auditRepository(
      entries,
      readBytes,
      binaryAudit,
      packageRules(entries),
    );
    expect(result.pathViolations).toEqual([]);
    expect(result.contentViolations).toEqual([]);
    expect(result.unsafeBinaries).toEqual([]);
    expect(result.unclassified).toEqual([]);
    expect(result.contentScanned.length + result.binaryAudited.length)
      .toBe(entries.length);
    expect(new Set([
      ...result.contentScanned,
      ...result.binaryAudited,
    ]).size).toBe(entries.length);
    expect(result.binaryAudited.sort()).toEqual(Object.keys(binaryAudit).sort());
  });

  it('rejects private namespaces in normalized paths even with neutral content', () => {
    expect(normalizedPathFindings('src/rapteros/client.ts')).not.toEqual([]);
    expect(normalizedPathFindings('SRC/RAPTERBOX/neutral.py')).not.toEqual([]);
    expect(normalizedPathFindings('src/control-plane/client.ts')).not.toEqual([]);
    expect(normalizedPathFindings('src/ordinary/client.ts')).toEqual([]);
  });

  it('regression: rejects exact reported src/rapteros/client.ts path before content scanning', () => {
    const exactReportedPath = 'src/rapteros/client.ts';
    const neutralContent = 'export const localOnly = true;';
    expect(normalizedPathFindings(exactReportedPath)).not.toEqual([]);
    expect(textFindings(exactReportedPath, neutralContent)).toEqual([]);
  });

  it('mutates namespace and path separators without bypassing the invariant', () => {
    const contentMutations = [
      'RapterOS',
      'RAPTEROS',
      'rapter-os',
      'rapter_os',
      'rapter.os',
      'rapter os',
      "rapter' + 'os",
      'RapterBox',
      'rapter-box',
      'rapter_box',
      'rapter.box',
      "rapter' + 'box",
    ];
    for (const mutation of contentMutations) {
      expect(
        textFindings('virtual.runtime', `import('${mutation}/client')`),
        mutation,
      ).not.toEqual([]);
    }

    const pathMutations = [
      'src/RAPTEROS/client.ts',
      'src/rapter-os/client.ts',
      'src/rapter_os/client.ts',
      'src/rapter.os/client.ts',
      'src/rapter%4fs/client.ts',
      'src\\RapterBox\\client.ts',
      'src/rapter-box/client.ts',
      'src/rapter_box/client.ts',
    ];
    for (const mutation of pathMutations) {
      expect(normalizedPathFindings(mutation), mutation).not.toEqual([]);
    }

    const endpointMutations = [
      '/CONTROL-PLANE',
      '/api/control_plane',
      '\\api\\control-plane',
      '///tenants/current',
      '/v99/billing?scope=read',
      'https://public.example/telemetry/events',
      '//public.example/api/control-plane',
    ];
    for (const mutation of endpointMutations) {
      const normalized = mutation.replaceAll('\\', '/');
      expect(
        textFindings('virtual.runtime', `fetch('${normalized}')`),
        mutation,
      ).not.toEqual([]);
    }
  });

  it('detects endpoints and private identities independent of syntax or scheme', () => {
    const samples = [
      "fetch('/control-plane')",
      "fetch('/api/control-plane')",
      "fetch('/tenants')",
      "fetch('/v3/billing')",
      'https://example.com/control-plane/jobs',
      '//example.com/tenants/current',
      'git+ssh://git@github.com/RapterBox/private.git',
      'github:RapterOS/private',
      "import('@RAPTERBOX/sdk')",
      "require('rapteros-control-plane')",
      'const hook = new BillingTelemetryHook()',
    ];
    for (const sample of samples) {
      expect(textFindings('virtual.rules', sample), sample).not.toEqual([]);
    }
  });

  it('scans package fixtures, unknown lock formats and arbitrary text extensions', () => {
    const rules = packageRules(trackedEntries());
    const samples = [
      {
        path: 'beta/resources/fixtures/private.py',
        content: 'from RapterOS.private import Client',
      },
      {
        path: 'python/uv.lock',
        content: 'source = "git+ssh://git@github.com/RapterBox/private.git"',
      },
      {
        path: 'future/dependencies.unknown-lock',
        content: 'package = "github:RapterOS/private"',
      },
    ];
    expect(packageShips(samples[0].path, rules)).toBe(true);
    for (const sample of samples) {
      const text = decodeBoundedText(Buffer.from(sample.content));
      expect(text, `${sample.path} did not decode`).not.toBeNull();
      expect(textFindings(sample.path, text!), sample.path).not.toEqual([]);
    }
    expect(
      textFindings(
        'future/runtime.policy',
        'ordinary local runtime policy with no private references',
      ),
    ).toEqual([]);
  });

  it('fails new unclassified text, executable binary and unaudited binary paths', () => {
    const entries = trackedEntries();
    const rules = packageRules(entries);
    const virtual = new Map<string, Buffer>([
      ['future/arbitrary.rules', Buffer.from('ordinary text')],
      ['future/executable', Buffer.from([0, 1, 2, 3])],
      ['future/image.bin', Buffer.from([0, 1, 2, 3])],
      ['beta/resources/fixtures/private.png', Buffer.from([0, 1, 2, 3])],
    ]);
    const injected: TrackedEntry[] = [
      ...entries,
      { mode: '100644', path: 'future/arbitrary.rules' },
      { mode: '100755', path: 'future/executable' },
      { mode: '100644', path: 'future/image.bin' },
      { mode: '100644', path: 'beta/resources/fixtures/private.png' },
    ];
    const result = auditRepository(
      injected,
      (path) => virtual.get(path) ?? readBytes(path),
      binaryAudit,
      rules,
    );
    expect(result.contentScanned).toContain('future/arbitrary.rules');
    expect(result.unsafeBinaries).toContain('future/executable');
    expect(result.unsafeBinaries)
      .toContain('beta/resources/fixtures/private.png');
    expect(result.unclassified).toContain('future/image.bin');
  });

  it('reverse inventory detects a newly tracked path omitted from prior results', () => {
    const entries = trackedEntries();
    const baseline = auditRepository(
      entries,
      readBytes,
      binaryAudit,
      packageRules(entries),
    );
    const classified = new Set([
      ...baseline.contentScanned,
      ...baseline.binaryAudited,
    ]);
    const injected = 'future/new-format.runtime-lock';
    const expanded = [...entries, { mode: '100644', path: injected }];
    const unaccounted = expanded
      .map(({ path }) => path)
      .filter((path) => !classified.has(path));
    expect(unaccounted).toEqual([injected]);

    const refreshed = auditRepository(
      expanded,
      (path) => path === injected
        ? Buffer.from('ordinary new text format')
        : readBytes(path),
      binaryAudit,
      packageRules(entries),
    );
    expect(refreshed.contentScanned).toContain(injected);
  });
});
