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
  type?: string;
  const?: number;
  pattern?: string;
  enum?: string[];
}

interface Schema {
  additionalProperties: boolean;
  required: string[];
  properties: Record<string, SchemaProperty>;
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0').filter(Boolean);
}

function validatesDescriptor(value: Record<string, unknown>): boolean {
  const allowed = new Set(Object.keys(seam.properties));
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (seam.required.some((key) => !(key in value))) return false;
  for (const [key, rule] of Object.entries(seam.properties)) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    if (rule.const !== undefined && candidate !== rule.const) return false;
    if (rule.type && typeof candidate !== rule.type) return false;
    if (
      rule.enum &&
      (typeof candidate !== 'string' || !rule.enum.includes(candidate))
    ) return false;
    if (
      rule.pattern &&
      (typeof candidate !== 'string' || !new RegExp(rule.pattern).test(candidate))
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
      '^#[a-z][a-z0-9-]{0,63}$',
    );
    for (const fixture of fixtures.accepted) {
      expect(validatesDescriptor(fixture), JSON.stringify(fixture)).toBe(true);
    }
  });

  it('rejects external URLs, secrets, private hosts/scopes and telemetry hooks', () => {
    expect(fixtures.rejected.length).toBeGreaterThanOrEqual(10);
    for (const fixture of fixtures.rejected) {
      expect(
        validatesDescriptor(fixture.value),
        `${fixture.reason}: ${JSON.stringify(fixture.value)}`,
      ).toBe(false);
    }
  });

  it('contains no private dependency or URL in the public seam or packages', () => {
    expect(seamText).not.toMatch(/rapteros|rapterbox|tenant|billing|entitlement/i);
    const schemaUrls = [...seamText.matchAll(/https?:\/\/[^"\s]+/g)]
      .map((match) => new URL(match[0]));
    expect(schemaUrls.length).toBeGreaterThan(0);
    for (const url of schemaUrls) {
      expect(['json-schema.org', 'openrappter.dev']).toContain(url.hostname);
      expect(url.username).toBe('');
      expect(url.password).toBe('');
      expect(url.search).toBe('');
    }

    const manifests = trackedFiles().filter((path) =>
      /(^|\/)(?:package\.json|pyproject\.toml|requirements[^/]*\.txt)$/.test(path)
    );
    expect(manifests.length).toBeGreaterThan(3);
    for (const path of manifests) {
      expect(read(path), path).not.toMatch(
        /@(?:rapterbox|rapteros)\/|https?:\/\/[^"'\s]*(?:rapteros|rapterbox)/i,
      );
    }
  });

  it('scans tracked runtime sources and exports for proprietary leakage', () => {
    const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.py']);
    const runtimeRoots = [
      'typescript/src/',
      'typescript/ui/src/',
      'python/openrappter/',
      'beta/src/',
      'rapp_brainstem/',
    ];
    const files = trackedFiles().filter((path) =>
      runtimeRoots.some((prefix) => path.startsWith(prefix)) &&
      sourceExtensions.has(extname(path)) &&
      !path.includes('/__tests__/') &&
      !path.includes('/tests/')
    );
    expect(files.length).toBeGreaterThan(100);

    const forbidden = [
      /@(?:rapterbox|rapteros)\//i,
      /(?:from|import)\s+['"]rapteros(?:[./'"])/i,
      /https?:\/\/[^/"'\s]*(?:rapteros|rapterbox)\./i,
      /\/(?:v\d+\/)?(?:tenants?|billing|entitlements?|control-plane)(?:\/|\b)/i,
      /\b(?:RapterOSClient|RapterOSTenant|RapterOSBilling|rapterosTelemetry)\b/,
      /\bRAPTEROS_(?:TOKEN|API|TENANT|BILLING|TELEMETRY)\b/,
    ];
    for (const path of files) {
      const content = read(path);
      for (const pattern of forbidden) {
        expect(content, `${path} matched ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
