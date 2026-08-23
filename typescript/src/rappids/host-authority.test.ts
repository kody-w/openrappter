import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  RappidHostAuthority,
  rappidPairingProof,
} from './host-authority.js';

const roots: string[] = [];

function root(label: string): string {
  const path = join(
    process.cwd(),
    `.rappid-host-authority-${label}-${process.pid}-${roots.length}`,
  );
  rmSync(path, { recursive: true, force: true });
  roots.push(path);
  return path;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('RAPPID host pairing authority', () => {
  it('performs a one-time proof handshake and persists only a token hash', () => {
    let now = Date.parse('2026-08-23T20:00:00.000Z');
    const dataDir = root('pair');
    const authority = new RappidHostAuthority(dataDir, { now: () => now });
    const offer = authority.beginPairing('http://127.0.0.1:8787');
    const nonce = 'device-pair-nonce-0001';
    const installID = 'device-install-0001';
    const request = {
      schema: 'rappid-field-pair/1',
      deviceName: 'Field phone',
      deviceInstallID: installID,
      requestedScopes: ['rappid.list', 'rappid.grow'],
      nonce,
      proof: rappidPairingProof(offer.code, nonce, installID),
    };

    const credential = authority.completePairing(request);
    expect(credential).toMatchObject({
      scopes: ['rappid.list', 'rappid.grow'],
      hostURL: 'http://127.0.0.1:8787',
      hostFingerprint: offer.hostFingerprint,
      isSyntheticGrant: false,
    });
    expect(credential.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(authority.authenticateBearer(credential.token)).toMatchObject({
      deviceId: credential.credentialID,
      scopes: ['rappid.list', 'rappid.grow'],
    });
    expect(authority.authenticateBearer('wrong-token')).toBeUndefined();
    expect(() => authority.completePairing(request)).toThrow(
      'pairing proof is invalid or expired',
    );

    const restarted = new RappidHostAuthority(dataDir, { now: () => now });
    expect(restarted.authenticateBearer(credential.token)?.deviceId)
      .toBe(credential.credentialID);
    now += 91 * 24 * 60 * 60_000;
    expect(restarted.authenticateBearer(credential.token)).toBeUndefined();
  });

  it('keeps the loopback exception HTTP-only and origin-only', () => {
    const authority = new RappidHostAuthority(root('hosts'));
    expect(authority.beginPairing('http://localhost:8787').host)
      .toBe('http://localhost:8787');
    expect(authority.beginPairing('http://[::1]:8787').host)
      .toBe('http://[::1]:8787');
    expect(authority.beginPairing('https://host.example').host)
      .toBe('https://host.example');
    expect(() => authority.beginPairing('ftp://localhost:8787')).toThrow(
      'HTTPS or literal loopback HTTP',
    );
    expect(() => authority.beginPairing('ws://127.0.0.1:8787')).toThrow(
      'HTTPS or literal loopback HTTP',
    );
    expect(() => authority.beginPairing('http://host.example')).toThrow(
      'HTTPS or literal loopback HTTP',
    );
    expect(() => authority.beginPairing('https://host.example/path')).toThrow(
      'origin without a path',
    );
  });

  it('binds approvals to principal, scope, payload and one use', () => {
    let now = Date.parse('2026-08-23T20:00:00.000Z');
    const authority = new RappidHostAuthority(root('approval'), {
      now: () => now,
      approvalTtlMs: 1_000,
    });
    const binding = {
      operation: 'grow' as const,
      rappid: `rappid:@field/companion:${'a'.repeat(64)}`,
      proposalId: 'proposal-1',
    };
    const approval = authority.issueMutationApproval(
      'device-1',
      ['rappid.grow'],
      binding,
    );

    expect(authority.consumeMutationApproval('device-2', approval)).toBe(false);
    expect(authority.consumeMutationApproval('device-1', {
      ...approval,
      proposalId: 'proposal-other',
    })).toBe(false);
    expect(authority.consumeMutationApproval('device-1', approval)).toBe(true);
    expect(authority.consumeMutationApproval('device-1', approval)).toBe(false);

    expect(() => authority.issueMutationApproval(
      'device-1',
      ['rappid.list'],
      binding,
    )).toThrow('lacks rappid.grow scope');

    const expiring = authority.issueMutationApproval(
      'device-1',
      ['rappid.grow'],
      { ...binding, proposalId: 'proposal-2' },
    );
    now += 1_001;
    expect(authority.consumeMutationApproval('device-1', expiring)).toBe(false);
  });
});
