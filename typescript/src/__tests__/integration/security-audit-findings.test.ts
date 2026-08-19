/**
 * The security auditor, tested on what it finds rather than on what it returns.
 *
 * `security-audit.test.ts` has 26 tests and every one asserts a shape:
 *
 *     it('checkGatewayConfig should return array', () => {
 *       expect(Array.isArray(auditor.checkGatewayConfig())).toBe(true);
 *     });
 *
 * That passes on the empty array the missing-file branch returns, so it was
 * green *because* the check did nothing (#246). The config checks read
 * `~/.openrappter/config.yml`, which this product does not write -- it writes
 * `config.json5` -- and a missing file is indistinguishable from a pass.
 *
 * Every test here plants a specific condition and asserts the specific finding,
 * so each one fails if its check stops working.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SecurityAuditor } from '../../security/audit.js';

let home: string | undefined;
const savedHome = process.env.OPENRAPPTER_HOME;

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
  if (savedHome === undefined) delete process.env.OPENRAPPTER_HOME;
  else process.env.OPENRAPPTER_HOME = savedHome;
});

/** A private installation containing exactly the given config. */
function installationWith(config: string): SecurityAuditor {
  home = mkdtempSync(join(tmpdir(), 'audit-test-'));
  mkdirSync(home, { recursive: true });
  const path = join(home, 'config.json5');
  writeFileSync(path, config);
  chmodSync(path, 0o600);
  chmodSync(home, 0o700);
  process.env.OPENRAPPTER_HOME = home;
  return new SecurityAuditor();
}

const ids = (findings: { checkId: string }[]) => findings.map((f) => f.checkId);

describe('gateway exposure', () => {
  it('reports a gateway bound to all interfaces with no auth', () => {
    const auditor = installationWith(`{ gateway: { bind: 'all', auth: { mode: 'none' } } }`);
    const findings = auditor.checkGatewayConfig();

    expect(ids(findings)).toContain('gw-001');
    expect(findings.find((f) => f.checkId === 'gw-001')?.severity).toBe('critical');
  });

  it('says nothing about a loopback gateway', () => {
    const auditor = installationWith(`{ gateway: { bind: 'loopback', auth: { mode: 'none' } } }`);
    expect(ids(auditor.checkGatewayConfig())).not.toContain('gw-001');
  });

  it('says nothing about an authenticated gateway on all interfaces', () => {
    const auditor = installationWith(
      `{ gateway: { bind: 'all', auth: { mode: 'password', password: '${'x'.repeat(40)}' } } }`,
    );
    expect(ids(auditor.checkGatewayConfig())).not.toContain('gw-001');
  });

  it('does not fire on a config that merely contains the word "all"', () => {
    // The regression this check was written for. The old pattern was
    // `/bind:\s*['"]?0\.0\.0\.0|all['"]?/i` -- an unparenthesised alternation,
    // so the bare substring "all" matched anywhere, and `allowlists`,
    // `install` or `wall` all set it.
    const auditor = installationWith(
      `{ gateway: { bind: 'loopback', auth: { mode: 'none' } }, channels: { imessage: { allowlist: ['+15550000000'] } } }`,
    );
    expect(ids(auditor.checkGatewayConfig())).not.toContain('gw-001');
  });

  it('reports a password shorter than 32 characters', () => {
    const auditor = installationWith(
      `{ gateway: { bind: 'loopback', auth: { mode: 'password', password: 'short' } } }`,
    );
    expect(ids(auditor.checkGatewayConfig())).toContain('gw-002');
  });

  it('does not report a long password', () => {
    const auditor = installationWith(
      `{ gateway: { auth: { mode: 'password', password: '${'y'.repeat(64)}' } } }`,
    );
    expect(ids(auditor.checkGatewayConfig())).not.toContain('gw-002');
  });
});

describe('secrets in the config file', () => {
  it('finds a planted API key', () => {
    const auditor = installationWith(`{ note: 'sk-${'a'.repeat(32)}' }`);
    const findings = auditor.checkConfigSecrets();
    expect(ids(findings)).toContain('sec-001');
  });

  it('reports a config readable by others', () => {
    const auditor = installationWith(`{ gateway: { bind: 'loopback' } }`);
    chmodSync(join(home!, 'config.json5'), 0o644);
    expect(ids(auditor.checkConfigSecrets())).toContain('sec-007');
  });

  it('says nothing about a 600 config with no secrets', () => {
    const auditor = installationWith(`{ gateway: { bind: 'loopback' } }`);
    expect(auditor.checkConfigSecrets()).toEqual([]);
  });
});

describe('filesystem permissions', () => {
  it('reports a world-readable installation directory', () => {
    const auditor = installationWith(`{}`);
    chmodSync(home!, 0o755);
    expect(ids(auditor.checkFilesystemPerms())).toContain('fs-002');
  });

  it('says nothing about a 700 directory', () => {
    const auditor = installationWith(`{}`);
    expect(ids(auditor.checkFilesystemPerms())).not.toContain('fs-002');
  });
});

describe('checks for settings this product does not have', () => {
  it('never reports CDP exposure, which is not a setting', () => {
    // Removed rather than repaired: `cdp` appears nowhere in the schema, and
    // the old pattern carried the same broken alternation, so pointing the
    // auditor at the real config made it report "Chrome DevTools Protocol
    // exposed remotely" at CRITICAL on a machine with no such setting.
    const auditor = installationWith(
      `{ browser: { headless: true }, channels: { slack: { allowlist: [] } } }`,
    );
    expect(ids(auditor.checkBrowserSecurity())).not.toContain('br-001');
  });

  it('still reports a headed browser, which is a real setting', () => {
    const auditor = installationWith(`{ browser: { headless: false } }`);
    expect(ids(auditor.checkBrowserSecurity())).toContain('br-002');
  });
});

describe('runAll', () => {
  it('returns findings from every check, on a deliberately bad installation', () => {
    const auditor = installationWith(
      `{ gateway: { bind: 'all', auth: { mode: 'none' } }, browser: { headless: false } }`,
    );
    chmodSync(home!, 0o755);

    return auditor.runAll().then((findings) => {
      const found = ids(findings);
      expect(found).toContain('gw-001');
      expect(found).toContain('br-002');
      expect(found).toContain('fs-002');
    });
  });

  it('finds nothing on a well-configured installation', () => {
    // The assertion the old suite could not make: a clean result that means
    // "checked and clean" rather than "did not look".
    const auditor = installationWith(
      `{ gateway: { bind: 'loopback', auth: { mode: 'password', password: '${'z'.repeat(48)}' } }, browser: { headless: true } }`,
    );
    return auditor.runAll().then((findings) => {
      expect(findings).toEqual([]);
    });
  });
});
