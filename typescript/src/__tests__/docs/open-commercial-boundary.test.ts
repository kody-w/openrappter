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

interface NormalizedViews {
  raw: string;
  slash: string;
  token: string;
  identifiers: string[];
  invalidPercentEncoding: boolean;
}

function decodePercentLayers(value: string): {
  value: string;
  invalid: boolean;
} {
  let current = value;
  let invalid = false;
  for (let pass = 0; pass < 3; pass += 1) {
    if (/%(?![0-9a-f]{2})/i.test(current)) invalid = true;
    let changed = false;
    const next = current.replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
      try {
        const decoded = decodeURIComponent(encoded);
        if (decoded !== encoded) changed = true;
        return decoded;
      } catch {
        invalid = true;
        return encoded;
      }
    });
    current = next.normalize('NFKC');
    if (!changed) break;
  }
  return { value: current, invalid };
}

function normalizedViews(input: string): NormalizedViews {
  if (Buffer.byteLength(input, 'utf8') > MAX_TEXT_BYTES) {
    throw new Error('Normalization input exceeds the bounded text limit');
  }
  const nfkc = input.normalize('NFKC');
  const percent = decodePercentLayers(nfkc);
  const slash = percent.value
    .replace(/[\\\u2044\u2215\u29f8\uff0f]/gu, '/')
    .replace(/[\u2010-\u2015\u2212\ufe63\uff0d]/gu, '-')
    .normalize('NFKC')
    .toLowerCase();
  const camelSeparated = percent.value
    .normalize('NFKC')
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, '$1 $2');
  const token = camelSeparated
    .replace(/[\\\u2044\u2215\u29f8\uff0f]/gu, '/')
    .replace(/[\u2010-\u2015\u2212\ufe63\uff0d]/gu, '-')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const identifiers = slash
    .match(/[\p{L}\p{N}_.$@/+:-]+/gu)
    ?.map((identifier) => identifier.replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter(Boolean) ?? [];
  return {
    raw: nfkc.toLowerCase(),
    slash,
    token,
    identifiers,
    invalidPercentEncoding: percent.invalid,
  };
}

const PROTECTED_IDENTIFIER =
  /rapteros|rapterbox|tenant(?:service|client|controller|context|repository|store)|billing(?:client|service|provider|webhook|controller)|controlplane(?:controller|client|service|server|repository)|telemetry(?:client|hook|endpoint|exporter|controller)/i;
const PROTECTED_ENDPOINT =
  /\/+(?:api\/)?(?:v\d+\/)?(?:control[-_]?plane|tenants?|billing|telemetry)(?=\/|[?#\s"'`)]|$)/i;

function normalizedValueFindings(input: string): string[] {
  const views = normalizedViews(input);
  const result = new Set<string>();
  if (
    views.identifiers.some((identifier) => PROTECTED_IDENTIFIER.test(identifier)) ||
    /\brapter\s+(?:os|box)\b/i.test(views.token)
  ) {
    result.add('protected private identifier');
  }
  if (PROTECTED_ENDPOINT.test(views.slash)) {
    result.add('private runtime endpoint');
  }
  if (
    views.invalidPercentEncoding &&
    (
      /(?:rapter|control|tenant|billing|telemetry)[\p{L}\p{N}._%+-]{0,32}%(?![0-9a-f]{2})/iu
        .test(views.raw) ||
      /%(?![0-9a-f]{2})[\p{L}\p{N}._%+-]{0,32}(?:os|box|plane|service|client|controller|context|repository|store|provider|webhook|hook|endpoint|exporter)/iu
        .test(views.raw)
    )
  ) {
    result.add('invalid percent encoding near a protected fragment');
  }
  return [...result];
}

const STRING_LITERAL =
  String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')`;

function literalValues(source: string): string[] {
  const pattern = /(["'])((?:\\.|(?!\1)[\s\S])*)\1/g;
  return [...source.matchAll(pattern)].map((match) =>
    match[2]
      .replace(/\\x([0-9a-f]{2})/gi, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\(["'\\/])/g, '$1')
  );
}

function staticallyAssembledStrings(source: string): string[] {
  const result = new Set<string>();
  const plus = new RegExp(
    `${STRING_LITERAL}(?:\\s*\\+\\s*${STRING_LITERAL})+`,
    'gs',
  );
  const adjacent = new RegExp(
    `${STRING_LITERAL}(?:\\s+${STRING_LITERAL})+`,
    'gs',
  );
  const concat = new RegExp(
    `${STRING_LITERAL}\\s*\\.concat\\(\\s*${STRING_LITERAL}(?:\\s*,\\s*${STRING_LITERAL})*\\s*\\)`,
    'gs',
  );
  const join = new RegExp(
    `\\[\\s*${STRING_LITERAL}(?:\\s*,\\s*${STRING_LITERAL})+\\s*\\]\\s*\\.join\\(\\s*${STRING_LITERAL}\\s*\\)`,
    'gs',
  );
  for (const pattern of [plus, adjacent, concat]) {
    for (const match of source.matchAll(pattern)) {
      result.add(literalValues(match[0]).join(''));
    }
  }
  for (const match of source.matchAll(join)) {
    const values = literalValues(match[0]);
    const separator = values.pop() ?? '';
    result.add(values.join(separator));
  }
  return [...result];
}

function normalizedPathFindings(path: string): string[] {
  return normalizedValueFindings(path);
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
  const result = new Set(normalizedValueFindings(content));
  for (const assembled of staticallyAssembledStrings(content)) {
    for (const finding of normalizedValueFindings(assembled)) {
      result.add(`static assembly: ${finding}`);
    }
  }
  if (basename(path).endsWith('.json')) {
    const parsed = JSON.parse(content) as unknown;
    for (const [name, specifier] of dependencyEntries(parsed)) {
      for (const finding of normalizedValueFindings(`${name}\n${specifier}`)) {
        result.add(`dependency: ${finding}`);
      }
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

const repositoryTrackedEntries = trackedEntries();
const repositoryPackageRules = packageRules(repositoryTrackedEntries);
let cachedRepositoryAudit: RepositoryAudit | undefined;

function currentRepositoryAudit(): RepositoryAudit {
  cachedRepositoryAudit ??= auditRepository(
    repositoryTrackedEntries,
    readBytes,
    binaryAudit,
    repositoryPackageRules,
  );
  return cachedRepositoryAudit;
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
    const entries = repositoryTrackedEntries;
    const result = currentRepositoryAudit();
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
      expect(
        textFindings('virtual.runtime', `fetch('${mutation}')`),
        mutation,
      ).not.toEqual([]);
    }
  });

  it('reviewer regression: normalizes raw protected identifiers and encodings internally', () => {
    const rawSamples = [
      'new TenantService()',
      'billingClient.request()',
      'class ControlPlaneController {}',
      'telemetryClient.flush()',
      "import('rapter%6fs/client')",
      "fetch('/control%2dplane/jobs')",
      "fetch('/ten%61nts/current')",
      "import('rapter∕os/client')",
      "import('ＲａｐｔｅｒＯＳ/client')",
      "import('prefix-rapter_os-suffix/client')",
      "import('rapter%ZZos/client')",
    ];
    for (const sample of rawSamples) {
      expect(textFindings('virtual.raw', sample), sample).not.toEqual([]);
    }

    const rawPaths = [
      'src/rapter%6fs/client.ts',
      'src/Rapter∕OS/client.ts',
      'src/tenant_service/client.ts',
      'src/billing.client/client.ts',
      'src/ControlPlaneController/client.ts',
      'src/telemetry\\client/client.ts',
    ];
    for (const path of rawPaths) {
      expect(normalizedPathFindings(path), path).not.toEqual([]);
    }
  });

  it('reviewer regression: detects simple static string construction without execution', () => {
    const constructions = [
      "const value = 'rapter' + 'os';",
      "value = 'rapter' 'box'",
      "const value = 'rapter'.concat('os');",
      "const value = ['rapter', 'os'].join('');",
      "const value = ['/control', '-plane'].join('');",
      "value = '/ten' + 'ants'",
    ];
    for (const construction of constructions) {
      expect(
        textFindings('virtual-construction.ts', construction),
        construction,
      ).not.toEqual([]);
    }
  });

  it('does not reject safe prose that merely discusses ordinary concepts', () => {
    const safeControls = [
      'The tenant asked the service team about an invoice.',
      'Telemetry helps a local client observe health.',
      'A controller manages the public plane.',
      'The billing cycle is described in user-facing documentation.',
      'A raptor boxes its lunch before a flight.',
    ];
    for (const control of safeControls) {
      expect(textFindings('safe-prose.md', control), control).toEqual([]);
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
    const rules = repositoryPackageRules;
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
    const virtual = new Map<string, Buffer>([
      ['future/arbitrary.rules', Buffer.from('ordinary text')],
      ['future/executable', Buffer.from([0, 1, 2, 3])],
      ['future/image.bin', Buffer.from([0, 1, 2, 3])],
      ['beta/resources/fixtures/private.png', Buffer.from([0, 1, 2, 3])],
    ]);
    const injected: TrackedEntry[] = [
      { mode: '100644', path: 'future/arbitrary.rules' },
      { mode: '100755', path: 'future/executable' },
      { mode: '100644', path: 'future/image.bin' },
      { mode: '100644', path: 'beta/resources/fixtures/private.png' },
    ];
    const result = auditRepository(
      injected,
      (path) => virtual.get(path) ?? readBytes(path),
      binaryAudit,
      repositoryPackageRules,
    );
    expect(result.contentScanned).toContain('future/arbitrary.rules');
    expect(result.unsafeBinaries).toContain('future/executable');
    expect(result.unsafeBinaries)
      .toContain('beta/resources/fixtures/private.png');
    expect(result.unclassified).toContain('future/image.bin');
  });

  it('reverse inventory detects a newly tracked path omitted from prior results', () => {
    const entries = repositoryTrackedEntries;
    const baseline = currentRepositoryAudit();
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
      [{ mode: '100644', path: injected }],
      () => Buffer.from('ordinary new text format'),
      binaryAudit,
      repositoryPackageRules,
    );
    expect(refreshed.contentScanned).toContain(injected);
  });
});
