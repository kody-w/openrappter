import { describe, it, expect, beforeEach } from 'vitest';
import { SecurityAuditor } from '../../security/audit.js';
import { Allowlist } from '../../security/allowlist.js';
import { DMPairingManager } from '../../security/dm-pairing.js';

describe('Security Auditor', () => {
  let auditor: SecurityAuditor;

  beforeEach(() => {
    auditor = new SecurityAuditor();
  });

  it('should instantiate', () => {
    expect(auditor).toBeDefined();
  });

  it('should have all check methods', () => {
    expect(typeof auditor.checkFilesystemPerms).toBe('function');
    expect(typeof auditor.checkGatewayConfig).toBe('function');
    expect(typeof auditor.checkChannelSecurity).toBe('function');
    expect(typeof auditor.checkConfigSecrets).toBe('function');
    expect(typeof auditor.checkBrowserSecurity).toBe('function');
    expect(typeof auditor.runAll).toBe('function');
  });

  it('checkFilesystemPerms should return array', () => {
    const result = auditor.checkFilesystemPerms();
    expect(Array.isArray(result)).toBe(true);
  });

  it('checkGatewayConfig should return array', () => {
    const result = auditor.checkGatewayConfig();
    expect(Array.isArray(result)).toBe(true);
  });

  it('checkChannelSecurity should return array', () => {
    const result = auditor.checkChannelSecurity();
    expect(Array.isArray(result)).toBe(true);
  });

  it('checkConfigSecrets should return array', () => {
    const result = auditor.checkConfigSecrets();
    expect(Array.isArray(result)).toBe(true);
  });

  it('checkBrowserSecurity should return array', () => {
    const result = auditor.checkBrowserSecurity();
    expect(Array.isArray(result)).toBe(true);
  });

  it('runAll should return array of findings', async () => {
    const findings = await auditor.runAll();
    expect(Array.isArray(findings)).toBe(true);
  });

  it('findings should have correct shape', async () => {
    const findings = await auditor.runAll();

    // At least one finding should exist (fs-001 for missing dir or actual findings)
    if (findings.length > 0) {
      const finding = findings[0];
      expect(typeof finding.checkId).toBe('string');
      expect(typeof finding.severity).toBe('string');
      expect(typeof finding.title).toBe('string');
      expect(typeof finding.detail).toBe('string');
      expect(['critical', 'high', 'medium', 'low', 'info']).toContain(finding.severity);
    }
  });

  it('severity levels should be valid', async () => {
    const findings = await auditor.runAll();
    const validSeverities = ['critical', 'high', 'medium', 'low', 'info'];

    findings.forEach(finding => {
      expect(validSeverities).toContain(finding.severity);
    });
  });
});

describe('Allowlist', () => {
  let al: Allowlist;

  beforeEach(() => {
    al = new Allowlist();
  });

  it('should add and list entries', () => {
    al.add('test-tool', 'tool');
    expect(al.list('tool')).toHaveLength(1);
  });

  it('should check exact match', () => {
    al.add('my-tool', 'tool');
    expect(al.check('my-tool', 'tool')).toBe(true);
    expect(al.check('other-tool', 'tool')).toBe(false);
  });

  it('should check glob prefix match', () => {
    al.add('npm:*', 'command');
    expect(al.check('npm:install', 'command')).toBe(true);
    expect(al.check('pip:install', 'command')).toBe(false);
  });

  it('should remove entries', () => {
    al.add('test', 'tool');
    expect(al.list('tool')).toHaveLength(1);
    al.remove('test');
    expect(al.list('tool')).toHaveLength(0);
  });

  it('should not add duplicates', () => {
    al.add('x', 'tool');
    al.add('x', 'tool');
    expect(al.list('tool')).toHaveLength(1);
  });

  it('should filter by type', () => {
    al.add('tool1', 'tool');
    al.add('cmd1', 'command');
    al.add('domain1', 'domain');

    const toolEntries = al.list('tool');
    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0].pattern).toBe('tool1');
    expect(toolEntries[0].type).toBe('tool');
  });

  it('should support domain type', () => {
    al.add('*.example.com', 'domain');
    expect(al.check('*.example.com', 'domain')).toBe(true);
  });

  it('should support sender type', () => {
    al.add('user123', 'sender');
    expect(al.check('user123', 'sender')).toBe(true);
  });

  it('should clear entries by type', () => {
    al.add('a', 'tool');
    al.add('b', 'domain');
    al.clear('tool');
    expect(al.list('tool')).toHaveLength(0);
    expect(al.list('domain')).toHaveLength(1);
  });

  it('should clear all entries', () => {
    al.add('a', 'tool');
    al.add('b', 'domain');
    al.add('c', 'command');
    al.clear();
    expect(al.list()).toHaveLength(0);
  });
});

describe('DM Pairing', () => {
  let mgr: DMPairingManager;

  beforeEach(() => {
    mgr = new DMPairingManager();
  });

  it('should generate 6-digit code', () => {
    const code = mgr.generateCode('slack', 'user1');
    expect(code).toMatch(/^\d{6}$/);
  });

  it('should verify valid code', () => {
    const code = mgr.generateCode('slack', 'user1');
    const result = mgr.verifyCode(code);
    expect(result.valid).toBe(true);
    expect(result.channel).toBe('slack');
    expect(result.senderId).toBe('user1');
  });

  it('should reject unknown code', () => {
    const result = mgr.verifyCode('000000');
    expect(result.valid).toBe(false);
  });

  it('should pair sender on verify', () => {
    const code = mgr.generateCode('slack', 'user1');
    mgr.verifyCode(code);
    expect(mgr.getPairedSenders('slack')).toContain('user1');
  });

  it('should revoke pairing', () => {
    const code = mgr.generateCode('slack', 'user1');
    mgr.verifyCode(code);
    expect(mgr.getPairedSenders('slack')).toContain('user1');

    const revoked = mgr.revoke('slack', 'user1');
    expect(revoked).toBe(true);
    expect(mgr.getPairedSenders('slack')).not.toContain('user1');
  });

  it('should return empty for unknown channel', () => {
    expect(mgr.getPairedSenders('unknown')).toEqual([]);
  });
});
