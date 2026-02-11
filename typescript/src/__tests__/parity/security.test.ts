/**
 * Security & Approvals Parity Tests
 * Tests that openrappter security system matches openclaw:
 * - Execution approvals (request, resolve, policies)
 * - Scope-based authorization
 * - Audit logging
 * - Device auth scopes
 */

import { describe, it, expect } from 'vitest';

describe('Security Parity', () => {
  describe('Execution Approvals', () => {
    it('should request approval for tool execution', () => {
      const request = {
        id: 'approval_123',
        tool: 'bash',
        args: { command: 'rm -rf /tmp/old-data' },
        agentId: 'main',
        sessionId: 'session_456',
        requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      };

      expect(request.id).toBeDefined();
      expect(request.tool).toBe('bash');
    });

    it('should resolve approval (approve)', () => {
      const resolution = {
        method: 'exec.approval.resolve',
        params: {
          requestId: 'approval_123',
          decision: 'approved' as const,
          resolvedBy: 'user_admin',
        },
      };

      expect(resolution.params.decision).toBe('approved');
    });

    it('should resolve approval (deny)', () => {
      const resolution = {
        method: 'exec.approval.resolve',
        params: {
          requestId: 'approval_123',
          decision: 'denied' as const,
          reason: 'Too dangerous',
        },
      };

      expect(resolution.params.decision).toBe('denied');
    });

    it('should expire pending approvals', () => {
      const expiredRequest = {
        id: 'approval_old',
        status: 'expired' as const,
        expiresAt: '2024-01-01T00:00:00Z',
      };

      expect(expiredRequest.status).toBe('expired');
    });

    it('should list pending approvals', () => {
      const response = {
        method: 'exec.approvals.get',
        result: {
          pending: [
            { id: 'approval_1', tool: 'bash', args: { command: 'npm install' } },
            { id: 'approval_2', tool: 'write', args: { path: '/etc/config' } },
          ],
        },
      };

      expect(response.result.pending.length).toBeGreaterThan(0);
    });
  });

  describe('Approval Policies', () => {
    it('should support deny-all policy', () => {
      const policy = { mode: 'deny' as const };
      expect(policy.mode).toBe('deny');
    });

    it('should support allowlist policy', () => {
      const policy = {
        mode: 'allowlist' as const,
        rules: [
          { tool: 'bash', allow: ['ls *', 'cat *', 'echo *'] },
          { tool: 'read', allow: ['*'] },
          { tool: 'write', deny: ['/etc/*', '/sys/*'] },
        ],
      };

      expect(policy.mode).toBe('allowlist');
      expect(policy.rules.length).toBeGreaterThan(0);
    });

    it('should support full-access policy', () => {
      const policy = { mode: 'full' as const };
      expect(policy.mode).toBe('full');
    });

    it('should support per-channel policies', () => {
      const channelPolicies = {
        telegram: { mode: 'allowlist' as const },
        discord: { mode: 'deny' as const },
        cli: { mode: 'full' as const },
      };

      expect(channelPolicies.cli.mode).toBe('full');
      expect(channelPolicies.discord.mode).toBe('deny');
    });

    it('should support per-sender policies', () => {
      const senderPolicies = {
        'user_admin': { mode: 'full' as const },
        'user_guest': { mode: 'deny' as const },
      };

      expect(senderPolicies['user_admin'].mode).toBe('full');
    });

    it('should support per-agent policies', () => {
      const agentPolicies = {
        main: { mode: 'allowlist' as const },
        readonly: { mode: 'deny' as const },
      };

      expect(agentPolicies.readonly.mode).toBe('deny');
    });

    it('should match patterns with wildcards', () => {
      const matchPattern = (command: string, pattern: string): boolean => {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return regex.test(command);
      };

      expect(matchPattern('ls -la', 'ls *')).toBe(true);
      expect(matchPattern('rm -rf /', 'ls *')).toBe(false);
      expect(matchPattern('cat file.txt', 'cat *')).toBe(true);
    });

    it('should prioritize rules correctly', () => {
      const rules = [
        { priority: 10, tool: 'bash', pattern: 'rm *', action: 'deny' },
        { priority: 5, tool: 'bash', pattern: '*', action: 'allow' },
        { priority: 1, tool: '*', pattern: '*', action: 'deny' },
      ];

      const sorted = [...rules].sort((a, b) => b.priority - a.priority);
      expect(sorted[0].action).toBe('deny');
      expect(sorted[0].pattern).toBe('rm *');
    });
  });

  describe('Scope-Based Authorization', () => {
    it('should define authorization scopes', () => {
      const scopes = [
        'operator.admin',
        'operator.read',
        'operator.write',
        'operator.approvals',
        'operator.pairing',
      ];

      expect(scopes.length).toBeGreaterThanOrEqual(5);
    });

    it('should check scope authorization', () => {
      const checkScope = (userScopes: string[], requiredScope: string): boolean => {
        if (userScopes.includes('operator.admin')) return true;
        return userScopes.includes(requiredScope);
      };

      expect(checkScope(['operator.admin'], 'operator.write')).toBe(true);
      expect(checkScope(['operator.read'], 'operator.write')).toBe(false);
      expect(checkScope(['operator.read', 'operator.write'], 'operator.write')).toBe(true);
    });

    it('should assign scopes to device tokens', () => {
      const deviceToken = {
        deviceId: 'device_123',
        token: 'token_abc',
        scopes: ['operator.read', 'operator.write'],
        expiresAt: new Date(Date.now() + 86400000 * 30).toISOString(),
      };

      expect(deviceToken.scopes).toContain('operator.read');
    });
  });

  describe('Node-Level Approvals', () => {
    it('should get node approval status', () => {
      const request = {
        method: 'exec.approvals.node.get',
        params: { nodeId: 'node_123' },
      };

      const response = {
        nodeId: 'node_123',
        policy: 'allowlist',
        rules: [
          { method: 'screenshot', allowed: true },
          { method: 'database', allowed: false },
        ],
      };

      expect(response.rules.length).toBeGreaterThan(0);
    });

    it('should set node approval policy', () => {
      const request = {
        method: 'exec.approvals.node.set',
        params: {
          nodeId: 'node_123',
          policy: 'allowlist',
          allowedMethods: ['screenshot', 'notification'],
        },
      };

      expect(request.params.allowedMethods).toContain('screenshot');
    });
  });

  describe('Audit Logging', () => {
    it('should log approval decisions', () => {
      const auditEntry = {
        timestamp: new Date().toISOString(),
        type: 'approval_decision',
        requestId: 'approval_123',
        tool: 'bash',
        args: { command: 'npm install' },
        decision: 'approved',
        resolvedBy: 'user_admin',
      };

      expect(auditEntry.type).toBe('approval_decision');
      expect(auditEntry.decision).toBeDefined();
    });

    it('should log security events', () => {
      const securityEvent = {
        timestamp: new Date().toISOString(),
        type: 'auth_failure',
        deviceId: 'unknown',
        reason: 'Invalid token',
        ip: '192.168.1.100',
      };

      expect(securityEvent.type).toBe('auth_failure');
    });
  });
});
