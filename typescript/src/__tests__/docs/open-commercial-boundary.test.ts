import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const license = readFileSync(resolve(root, 'LICENSE'), 'utf8');
const packageMetadata = JSON.parse(
  readFileSync(resolve(root, 'typescript/package.json'), 'utf8'),
) as { license: string };
const boundary = readFileSync(
  resolve(root, 'docs/openrappter-personal-and-hosted-services.md'),
  'utf8',
);
const seam = JSON.parse(
  readFileSync(resolve(root, 'contracts/xpedition-extension-v1.json'), 'utf8'),
) as {
  additionalProperties: boolean;
  required: string[];
  properties: Record<string, { const?: number; pattern?: string }>;
};

describe('open core and separately operated service boundary', () => {
  it('states the repository actual license without retroactive relicensing', () => {
    expect(license).toContain('Apache License');
    expect(license).toContain('Version 2.0');
    expect(packageMetadata.license).toBe('Apache-2.0');
    expect(boundary).toMatch(/It is not MIT\s+licensed/);
    expect(boundary).toMatch(
      /Nothing here\s+changes or retroactively relicenses/,
    );
  });

  it('preserves open self-host rights without promising hosted entitlement', () => {
    expect(boundary).toContain('self-host or mutate their fork');
    expect(boundary).toContain('do not automatically create');
    expect(boundary).toContain('implementation, service, and data');
  });

  it('keeps proprietary implementation and tenant state out of OpenRappter', () => {
    expect(boundary).toContain('no RapterOS billing or tenant-control-plane code');
    expect(boundary).toContain('no RapterOS customer tenancy or subscription state');
    expect(boundary).toContain('not legal advice');
  });

  it('publishes a closed, data-only v1 extension descriptor', () => {
    expect(seam.additionalProperties).toBe(false);
    expect(seam.required).toEqual([
      'id',
      'title',
      'description',
      'glyph',
      'href',
      'requiredCapability',
      'surfaceVersion',
    ]);
    expect(seam.properties.surfaceVersion?.const).toBe(1);
    expect(seam.properties.href?.pattern).toBe('^(#|https://)');
    expect(seam.properties.requiredCapability?.pattern).toBe(
      '^[a-z-]+:[a-z-]+$',
    );
  });
});
