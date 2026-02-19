/**
 * Security Feature Tests
 * Covers:
 *   - RateLimiter (token bucket behavior)
 *   - MultiScopeRateLimiter (global, per-IP, per-method)
 *   - DMPolicyEngine (open, pairing, closed modes; pairing code flow)
 *   - ExecSafety (command checking, injection detection, approval workflow)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  RateLimiter,
  MultiScopeRateLimiter,
  createRateLimiter,
} from '../rate-limiter.js';
import {
  DMPolicyEngine,
  createDMPolicyEngine,
} from '../dm-policy.js';
import {
  ExecSafety,
  createExecSafety,
} from '../exec-safety.js';

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limiter
// ─────────────────────────────────────────────────────────────────────────────

describe('RateLimiter — token bucket', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = createRateLimiter({
      maxTokens: 5,
      refillRate: 1,
      refillInterval: 1_000, // 1 token per second
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should instantiate via factory', () => {
    expect(limiter).toBeDefined();
    expect(typeof limiter.check).toBe('function');
    expect(typeof limiter.consume).toBe('function');
  });

  it('should allow up to maxTokens requests initially', () => {
    for (let i = 0; i < 5; i++) {
      expect(limiter.consume('user1').allowed).toBe(true);
    }
  });

  it('should block once tokens are exhausted', () => {
    for (let i = 0; i < 5; i++) limiter.consume('user1');
    const result = limiter.consume('user1');
    expect(result.allowed).toBe(false);
  });

  it('should return retryAfter when blocked', () => {
    for (let i = 0; i < 5; i++) limiter.consume('user1');
    const result = limiter.consume('user1');
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeDefined();
    expect(result.retryAfter!).toBeGreaterThan(0);
  });

  it('should track remaining tokens', () => {
    limiter.consume('user1');
    limiter.consume('user1');
    const result = limiter.consume('user1');
    expect(result.remaining).toBe(2);
  });

  it('should refill tokens after interval', () => {
    for (let i = 0; i < 5; i++) limiter.consume('user1');

    vi.advanceTimersByTime(2_000); // 2 seconds → 2 tokens refilled

    const result = limiter.consume('user1');
    expect(result.allowed).toBe(true);
  });

  it('should not exceed maxTokens on refill', () => {
    vi.advanceTimersByTime(100_000); // advance a lot
    const tokens = limiter.getTokens('user1');
    expect(tokens).toBeLessThanOrEqual(5);
  });

  it('should track separate buckets per key', () => {
    for (let i = 0; i < 5; i++) limiter.consume('user1');
    // user2 should have a fresh bucket
    expect(limiter.consume('user2').allowed).toBe(true);
  });

  it('should check without consuming', () => {
    const before = limiter.getTokens('user1');
    limiter.check('user1');
    const after = limiter.getTokens('user1');
    expect(after).toBe(before);
  });

  it('should allow consuming multiple tokens at once', () => {
    const result = limiter.consume('user1', 3);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it('should block when requested tokens exceed available', () => {
    limiter.consume('user1', 3); // 2 remaining
    const result = limiter.consume('user1', 3); // needs 3, only 2
    expect(result.allowed).toBe(false);
  });

  it('should reset a key bucket', () => {
    for (let i = 0; i < 5; i++) limiter.consume('user1');
    limiter.reset('user1');
    expect(limiter.consume('user1').allowed).toBe(true);
  });

  it('should reset all buckets', () => {
    for (let i = 0; i < 5; i++) {
      limiter.consume('user1');
      limiter.consume('user2');
    }
    limiter.resetAll();
    expect(limiter.consume('user1').allowed).toBe(true);
    expect(limiter.consume('user2').allowed).toBe(true);
  });
});

describe('MultiScopeRateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow when no scopes configured', () => {
    const ml = new MultiScopeRateLimiter();
    expect(ml.consume({}).allowed).toBe(true);
  });

  it('should enforce global rate limit', () => {
    const ml = new MultiScopeRateLimiter({
      global: { maxTokens: 2, refillRate: 1, refillInterval: 1_000 },
    });
    ml.consume({});
    ml.consume({});
    const result = ml.consume({});
    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toBe('global');
  });

  it('should enforce per-IP rate limit', () => {
    const ml = new MultiScopeRateLimiter({
      perIp: { maxTokens: 2, refillRate: 1, refillInterval: 1_000 },
    });
    ml.consume({ ip: '1.2.3.4' });
    ml.consume({ ip: '1.2.3.4' });
    const result = ml.consume({ ip: '1.2.3.4' });
    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toBe('ip');
  });

  it('should isolate per-IP buckets', () => {
    const ml = new MultiScopeRateLimiter({
      perIp: { maxTokens: 1, refillRate: 1, refillInterval: 1_000 },
    });
    ml.consume({ ip: '1.2.3.4' });
    // Different IP should still have tokens
    expect(ml.consume({ ip: '5.6.7.8' }).allowed).toBe(true);
  });

  it('should enforce per-method rate limit', () => {
    const ml = new MultiScopeRateLimiter({
      perMethod: {
        'agent.run': { maxTokens: 2, refillRate: 1, refillInterval: 1_000 },
      },
    });
    ml.consume({ method: 'agent.run' });
    ml.consume({ method: 'agent.run' });
    const result = ml.consume({ method: 'agent.run' });
    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toBe('method');
  });

  it('should allow different methods independently', () => {
    const ml = new MultiScopeRateLimiter({
      perMethod: {
        'agent.run': { maxTokens: 1, refillRate: 1, refillInterval: 1_000 },
      },
    });
    ml.consume({ method: 'agent.run' });
    // Different method should be allowed
    expect(ml.consume({ method: 'agent.chat' }).allowed).toBe(true);
  });

  it('should block globally before checking other scopes', () => {
    const ml = new MultiScopeRateLimiter({
      global: { maxTokens: 0, refillRate: 0, refillInterval: 1_000 },
      perIp: { maxTokens: 100, refillRate: 10, refillInterval: 1_000 },
    });
    const result = ml.consume({ ip: '1.2.3.4' });
    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toBe('global');
  });

  it('check should not consume tokens', () => {
    const ml = new MultiScopeRateLimiter({
      global: { maxTokens: 1, refillRate: 1, refillInterval: 1_000 },
    });
    ml.check({});
    ml.check({});
    // Consume should still work since check didn't spend tokens
    expect(ml.consume({}).allowed).toBe(true);
  });

  it('should reset all scopes', () => {
    const ml = new MultiScopeRateLimiter({
      global: { maxTokens: 1, refillRate: 1, refillInterval: 1_000 },
    });
    ml.consume({});
    ml.resetAll();
    expect(ml.consume({}).allowed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DM Policy Engine
// ─────────────────────────────────────────────────────────────────────────────

describe('DMPolicyEngine — open mode', () => {
  it('should allow all DMs in open mode', () => {
    const engine = createDMPolicyEngine({ mode: 'open' });
    expect(engine.checkAccess('user1').allowed).toBe(true);
    expect(engine.checkAccess('user2').allowed).toBe(true);
    expect(engine.checkAccess('stranger').allowed).toBe(true);
  });

  it('should respect blocklist in open mode', () => {
    const engine = createDMPolicyEngine({ mode: 'open', blocklist: ['spammer'] });
    expect(engine.checkAccess('spammer').allowed).toBe(false);
    expect(engine.checkAccess('user1').allowed).toBe(true);
  });

  it('should allow blocklisted removal', () => {
    const engine = createDMPolicyEngine({ mode: 'open' });
    engine.addToBlocklist('spammer');
    expect(engine.checkAccess('spammer').allowed).toBe(false);
    engine.removeFromBlocklist('spammer');
    expect(engine.checkAccess('spammer').allowed).toBe(true);
  });
});

describe('DMPolicyEngine — closed mode', () => {
  it('should reject all DMs not in allowlist', () => {
    const engine = createDMPolicyEngine({ mode: 'closed' });
    const result = engine.checkAccess('stranger');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/closed/i);
  });

  it('should allow allowlisted senders in closed mode', () => {
    const engine = createDMPolicyEngine({ mode: 'closed', allowlist: ['trusted'] });
    expect(engine.checkAccess('trusted').allowed).toBe(true);
    expect(engine.checkAccess('unknown').allowed).toBe(false);
  });

  it('should allow dynamically added allowlist entries', () => {
    const engine = createDMPolicyEngine({ mode: 'closed' });
    engine.addToAllowlist('newuser');
    expect(engine.checkAccess('newuser').allowed).toBe(true);
  });

  it('should remove from allowlist', () => {
    const engine = createDMPolicyEngine({ mode: 'closed', allowlist: ['trusted'] });
    engine.removeFromAllowlist('trusted');
    expect(engine.checkAccess('trusted').allowed).toBe(false);
  });

  it('blocklist should override allowlist in closed mode', () => {
    const engine = createDMPolicyEngine({
      mode: 'closed',
      allowlist: ['user1'],
      blocklist: ['user1'],
    });
    expect(engine.checkAccess('user1').allowed).toBe(false);
  });
});

describe('DMPolicyEngine — pairing mode', () => {
  it('should reject unknown sender and provide pairing code', () => {
    const engine = createDMPolicyEngine({ mode: 'pairing' });
    const result = engine.checkAccess('unknown');
    expect(result.allowed).toBe(false);
    expect(result.pairingCode).toBeDefined();
    expect(typeof result.pairingCode).toBe('string');
    expect(result.pairingCode!.length).toBeGreaterThan(0);
  });

  it('should allow already-paired sender', () => {
    const engine = createDMPolicyEngine({ mode: 'pairing' });
    const { pairingCode } = engine.checkAccess('user1');
    engine.validatePairingCode('user1', pairingCode!);
    expect(engine.checkAccess('user1').allowed).toBe(true);
  });

  it('should allow explicitly allowlisted sender without pairing', () => {
    const engine = createDMPolicyEngine({ mode: 'pairing', allowlist: ['admin'] });
    expect(engine.checkAccess('admin').allowed).toBe(true);
    // admin should get no pairing code
    expect(engine.checkAccess('admin').pairingCode).toBeUndefined();
  });

  it('should validate correct pairing code', () => {
    const engine = createDMPolicyEngine({ mode: 'pairing' });
    const code = engine.generatePairingCode('user1');
    expect(engine.validatePairingCode('user1', code)).toBe(true);
  });

  it('should reject wrong pairing code', () => {
    const engine = createDMPolicyEngine({ mode: 'pairing' });
    engine.generatePairingCode('user1');
    expect(engine.validatePairingCode('user1', 'WRONGCODE')).toBe(false);
  });

  it('should reject code used by wrong sender', () => {
    const engine = createDMPolicyEngine({ mode: 'pairing' });
    const code = engine.generatePairingCode('user1');
    expect(engine.validatePairingCode('user2', code)).toBe(false);
  });

  it('should expire pairing codes after TTL', () => {
    vi.useFakeTimers();
    const engine = createDMPolicyEngine({
      mode: 'pairing',
      pairingCodeTtlMs: 5_000,
    });
    const code = engine.generatePairingCode('user1');
    vi.advanceTimersByTime(6_000);
    expect(engine.validatePairingCode('user1', code)).toBe(false);
    vi.useRealTimers();
  });

  it('should reject code after successful use (one-time)', () => {
    const engine = createDMPolicyEngine({ mode: 'pairing' });
    const code = engine.generatePairingCode('user1');
    engine.validatePairingCode('user1', code);
    // Second use should fail
    expect(engine.validatePairingCode('user1', code)).toBe(false);
  });

  it('should revoke pairing for a sender', () => {
    const engine = createDMPolicyEngine({ mode: 'pairing' });
    const code = engine.generatePairingCode('user1');
    engine.validatePairingCode('user1', code);
    expect(engine.checkAccess('user1').allowed).toBe(true);

    engine.revokePairing('user1');
    const result = engine.checkAccess('user1');
    expect(result.allowed).toBe(false);
  });

  it('isPaired should return true after pairing', () => {
    const engine = createDMPolicyEngine({ mode: 'pairing' });
    const code = engine.generatePairingCode('user1');
    engine.validatePairingCode('user1', code);
    expect(engine.isPaired('user1')).toBe(true);
  });

  it('getPairedSenders should list paired senders', () => {
    const engine = createDMPolicyEngine({ mode: 'pairing' });
    const code1 = engine.generatePairingCode('user1');
    const code2 = engine.generatePairingCode('user2');
    engine.validatePairingCode('user1', code1);
    engine.validatePairingCode('user2', code2);
    const paired = engine.getPairedSenders();
    expect(paired).toContain('user1');
    expect(paired).toContain('user2');
  });
});

describe('DMPolicyEngine — per-channel policies', () => {
  it('should use channel policy when set', () => {
    const engine = createDMPolicyEngine({
      mode: 'open',
      channelPolicies: {
        telegram: { mode: 'closed' },
      },
    });
    // Global mode is open
    expect(engine.checkAccess('user1').allowed).toBe(true);
    // Telegram channel is closed
    expect(engine.checkAccess('user1', 'telegram').allowed).toBe(false);
  });

  it('should fall back to global mode when no channel policy', () => {
    const engine = createDMPolicyEngine({
      mode: 'closed',
      allowlist: ['admin'],
    });
    expect(engine.checkAccess('admin', 'discord').allowed).toBe(true);
    expect(engine.checkAccess('unknown', 'discord').allowed).toBe(false);
  });

  it('should setChannelPolicy at runtime', () => {
    const engine = createDMPolicyEngine({ mode: 'open' });
    engine.setChannelPolicy('slack', { mode: 'closed' });
    expect(engine.checkAccess('anyone', 'slack').allowed).toBe(false);
    expect(engine.checkAccess('anyone').allowed).toBe(true);
  });

  it('should removeChannelPolicy at runtime', () => {
    const engine = createDMPolicyEngine({ mode: 'open' });
    engine.setChannelPolicy('slack', { mode: 'closed' });
    engine.removeChannelPolicy('slack');
    // Now falls back to global open mode
    expect(engine.checkAccess('anyone', 'slack').allowed).toBe(true);
  });

  it('should merge global and channel allowlists', () => {
    const engine = createDMPolicyEngine({
      mode: 'closed',
      allowlist: ['global-admin'],
      channelPolicies: {
        slack: { mode: 'closed', allowlist: ['slack-user'] },
      },
    });
    // global-admin can access all channels
    expect(engine.checkAccess('global-admin', 'slack').allowed).toBe(true);
    // slack-user can only access slack
    expect(engine.checkAccess('slack-user', 'slack').allowed).toBe(true);
    expect(engine.checkAccess('slack-user').allowed).toBe(false);
  });

  it('addToAllowlist with channelId should scope to that channel', () => {
    const engine = createDMPolicyEngine({
      mode: 'closed',
      channelPolicies: { telegram: { mode: 'closed' } },
    });
    engine.addToAllowlist('user1', 'telegram');
    expect(engine.checkAccess('user1', 'telegram').allowed).toBe(true);
    // Not globally allowlisted
    expect(engine.checkAccess('user1').allowed).toBe(false);
  });

  it('setMode should update global mode', () => {
    const engine = createDMPolicyEngine({ mode: 'open' });
    engine.setMode('closed');
    expect(engine.checkAccess('anyone').allowed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Exec Safety
// ─────────────────────────────────────────────────────────────────────────────

describe('ExecSafety — safe command checks', () => {
  let safety: ExecSafety;

  beforeEach(() => {
    safety = createExecSafety();
  });

  it('should instantiate via factory', () => {
    expect(safety).toBeDefined();
    expect(typeof safety.checkCommand).toBe('function');
  });

  it('should allow safe binaries', () => {
    const safeCommands = [
      'ls -la',
      'cat README.md',
      'grep -r pattern src/',
      'git status',
      'npm install',
      'node index.js',
      'python script.py',
      'echo hello',
    ];

    for (const cmd of safeCommands) {
      const result = safety.checkCommand(cmd);
      expect(result.safe).toBe(true);
      expect(result.binary).toBeTruthy();
    }
  });

  it('should extract binary name correctly', () => {
    expect(safety.checkCommand('ls -la').binary).toBe('ls');
    expect(safety.checkCommand('npm run build').binary).toBe('npm');
    expect(safety.checkCommand('git commit -m "msg"').binary).toBe('git');
  });

  it('should handle binary with path', () => {
    const result = safety.checkCommand('/usr/bin/ls -la');
    expect(result.binary).toBe('ls');
    expect(result.safe).toBe(true);
  });

  it('should reject unknown binaries', () => {
    const result = safety.checkCommand('rm -rf /');
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/not in the safe list/i);
  });

  it('should have correct binary for rejected command', () => {
    const result = safety.checkCommand('curl-evil --steal-data');
    expect(result.binary).toBe('curl-evil');
  });

  it('should add and use custom safe bins', () => {
    safety.addSafeBin('myapp');
    expect(safety.checkCommand('myapp --run').safe).toBe(true);
  });

  it('should remove safe bins', () => {
    safety.removeSafeBin('cat');
    expect(safety.checkCommand('cat file.txt').safe).toBe(false);
  });

  it('isSafeBin should correctly check membership', () => {
    expect(safety.isSafeBin('ls')).toBe(true);
    expect(safety.isSafeBin('rm')).toBe(false);
    safety.addSafeBin('mybin');
    expect(safety.isSafeBin('mybin')).toBe(true);
  });

  it('listSafeBins should return sorted list', () => {
    const bins = safety.listSafeBins();
    expect(Array.isArray(bins)).toBe(true);
    expect(bins.length).toBeGreaterThan(0);
    // Verify it's sorted
    const sorted = [...bins].sort();
    expect(bins).toEqual(sorted);
  });

  it('should support custom safe bins in constructor', () => {
    const custom = createExecSafety(['myapp', 'mybuild']);
    expect(custom.checkCommand('myapp --start').safe).toBe(true);
    expect(custom.checkCommand('ls').safe).toBe(false); // not in custom list
  });
});

describe('ExecSafety — injection detection', () => {
  let safety: ExecSafety;

  beforeEach(() => {
    safety = createExecSafety();
  });

  it('should detect pipe chains', () => {
    const result = safety.checkCommand('ls | grep foo');
    expect(result.safe).toBe(false);
    expect(result.injectionType).toBe('pipe-chain');
  });

  it('should detect semicolon chaining', () => {
    const result = safety.checkCommand('ls; rm -rf /');
    expect(result.safe).toBe(false);
    expect(result.injectionType).toBe('semicolon-chain');
  });

  it('should detect command substitution $(...)', () => {
    const result = safety.checkCommand('echo $(whoami)');
    expect(result.safe).toBe(false);
    expect(result.injectionType).toBe('command-substitution');
  });

  it('should detect backtick substitution', () => {
    const result = safety.checkCommand('echo `whoami`');
    expect(result.safe).toBe(false);
    expect(result.injectionType).toBe('backtick-substitution');
  });

  it('should detect && chain', () => {
    const result = safety.checkCommand('ls && cat /etc/passwd');
    expect(result.safe).toBe(false);
    expect(result.injectionType).toBe('and-chain');
  });

  it('should detect || chain', () => {
    const result = safety.checkCommand('ls || rm -rf /');
    expect(result.safe).toBe(false);
    expect(result.injectionType).toBe('or-chain');
  });

  it('should detect dangerous redirects', () => {
    const result = safety.checkCommand('cat file > /etc/passwd');
    expect(result.safe).toBe(false);
    expect(result.injectionType).toBe('dangerous-redirect');
  });

  it('should detect newline injection', () => {
    const result = safety.checkCommand('ls\nrm -rf /');
    expect(result.safe).toBe(false);
    expect(result.injectionType).toBe('newline-injection');
  });

  it('should detect brace expansion variables', () => {
    const result = safety.checkCommand('echo ${HOME}');
    expect(result.safe).toBe(false);
    expect(result.injectionType).toBe('brace-expansion');
  });

  it('injection should take precedence over safe binary check', () => {
    // 'ls' is safe, but pipe injection is present
    const result = safety.checkCommand('ls | cat /etc/passwd');
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/injection/i);
  });
});

describe('ExecSafety — audit log', () => {
  let safety: ExecSafety;

  beforeEach(() => {
    safety = createExecSafety();
  });

  it('should record allowed commands in audit log', () => {
    safety.checkCommand('ls -la');
    const log = safety.getAuditLog();
    expect(log.length).toBeGreaterThan(0);
    const entry = log.find((e) => e.cmd === 'ls -la');
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('allowed');
  });

  it('should record blocked commands in audit log', () => {
    safety.checkCommand('evil-bin --do-harm');
    const log = safety.getAuditLog();
    const entry = log.find((e) => e.cmd === 'evil-bin --do-harm');
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('blocked');
  });

  it('audit entries should have required fields', () => {
    safety.checkCommand('git status');
    const entry = safety.getAuditLog()[0];
    expect(entry.id).toBeDefined();
    expect(entry.cmd).toBeDefined();
    expect(entry.binary).toBeDefined();
    expect(typeof entry.safe).toBe('boolean');
    expect(entry.status).toBeDefined();
    expect(entry.timestamp).toBeDefined();
  });

  it('should clear audit log', () => {
    safety.checkCommand('ls');
    safety.checkCommand('git status');
    safety.clearAuditLog();
    expect(safety.getAuditLog()).toHaveLength(0);
  });

  it('getAuditLog should return a copy', () => {
    safety.checkCommand('ls');
    const log1 = safety.getAuditLog();
    const log2 = safety.getAuditLog();
    expect(log1).not.toBe(log2); // Different array references
  });
});

describe('ExecSafety — approval workflow', () => {
  let safety: ExecSafety;

  beforeEach(() => {
    safety = createExecSafety();
  });

  it('should queue unsafe commands for approval', async () => {
    const promise = safety.requestApproval('rm -rf /tmp/data');
    const pending = safety.getPendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0].cmd).toBe('rm -rf /tmp/data');

    // Resolve to avoid hanging
    safety.approve(pending[0].id);
    await promise;
  });

  it('should resolve to true when approved', async () => {
    const promise = safety.requestApproval('dangerous-command');
    const pending = safety.getPendingApprovals();
    safety.approve(pending[0].id);
    const result = await promise;
    expect(result).toBe(true);
  });

  it('should resolve to false when rejected', async () => {
    const promise = safety.requestApproval('dangerous-command');
    const pending = safety.getPendingApprovals();
    safety.reject(pending[0].id);
    const result = await promise;
    expect(result).toBe(false);
  });

  it('should resolve to false on timeout', async () => {
    vi.useFakeTimers();
    const promise = safety.requestApproval('cmd', 100);
    vi.advanceTimersByTime(200);
    const result = await promise;
    expect(result).toBe(false);
    vi.useRealTimers();
  });

  it('should remove from pending after approval', async () => {
    const promise = safety.requestApproval('cmd');
    const pending = safety.getPendingApprovals();
    const id = pending[0].id;
    safety.approve(id);
    await promise;
    expect(safety.getPendingApprovals()).toHaveLength(0);
  });

  it('should update audit log status after approval', async () => {
    const promise = safety.requestApproval('cmd');
    const pending = safety.getPendingApprovals();
    const id = pending[0].id;
    safety.approve(id);
    await promise;

    const entry = safety.getAuditLog().find((e) => e.id === id);
    expect(entry?.status).toBe('approved');
  });

  it('should update audit log status after rejection', async () => {
    const promise = safety.requestApproval('cmd');
    const pending = safety.getPendingApprovals();
    const id = pending[0].id;
    safety.reject(id);
    await promise;

    const entry = safety.getAuditLog().find((e) => e.id === id);
    expect(entry?.status).toBe('rejected');
  });

  it('approve should return false for unknown id', () => {
    expect(safety.approve('nonexistent')).toBe(false);
  });

  it('reject should return false for unknown id', () => {
    expect(safety.reject('nonexistent')).toBe(false);
  });

  it('pending approvals should include binary and reason', async () => {
    const promise = safety.requestApproval('rm -rf /tmp');
    const pending = safety.getPendingApprovals();
    expect(pending[0].binary).toBe('rm');
    expect(pending[0].reason).toBeDefined();

    // Clean up
    safety.reject(pending[0].id);
    await promise;
  });
});
