/**
 * Security & Approvals Parity Tests
 *
 * Exercises the real ApprovalManager (src/security/approvals.ts) — the product
 * code that actually enforces tool-execution policy. An earlier version of this
 * file built literal objects and asserted on their own shape, so it passed no
 * matter what the product did (proven: mutating checkApproval's deny branch to
 * `allowed: true` left every test green). These tests call the real manager and
 * assert on its decisions, and they deliberately cover ground that
 * showcase-auth-fortress.test.ts does not: per-sender scoping, allowlist by
 * command prefix, blocked tools/commands, and the request expiration path.
 */

import { describe, it, expect } from 'vitest';
import { createApprovalManager } from '../../security/approvals.js';
import type { ApprovalContext, ApprovalRule } from '../../security/approvals.js';

function rule(overrides: Partial<ApprovalRule> & Pick<ApprovalRule, 'id' | 'policy'>): ApprovalRule {
  return {
    name: overrides.id,
    priority: 10,
    enabled: true,
    ...overrides,
  };
}

describe('Security & Approvals Parity', () => {
  describe('Base policies (checkApproval)', () => {
    it('deny policy blocks every tool call', () => {
      const manager = createApprovalManager();
      manager.setDefaultPolicy('deny');

      const result = manager.checkApproval({ toolName: 'bash', toolArgs: { command: 'ls' } });
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(false);
      expect(result.reason).toContain('denied');
    });

    it('full policy allows every tool call', () => {
      const manager = createApprovalManager();
      manager.setDefaultPolicy('full');

      const result = manager.checkApproval({ toolName: 'bash', toolArgs: { command: 'rm -rf /' } });
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });

    it('allowlist allows listed tools and requires approval for the rest', () => {
      const manager = createApprovalManager();
      manager.addRule(rule({ id: 'safe', policy: 'allowlist', allowedTools: ['read', 'list'] }));

      expect(manager.checkApproval({ toolName: 'read', toolArgs: {} }).allowed).toBe(true);

      const denied = manager.checkApproval({ toolName: 'bash', toolArgs: {} });
      expect(denied.allowed).toBe(false);
      expect(denied.requiresApproval).toBe(true);
      expect(denied.reason).toContain('allowlist');
    });

    it('allowlist matches a command by prefix via allowedCommands', () => {
      const manager = createApprovalManager();
      manager.addRule(rule({ id: 'ls-only', policy: 'allowlist', allowedCommands: ['ls', 'cat'] }));

      expect(manager.checkApproval({ toolName: 'bash', toolArgs: { command: 'ls -la /' } }).allowed).toBe(true);
      expect(manager.checkApproval({ toolName: 'bash', toolArgs: { command: 'cat file' } }).allowed).toBe(true);
      expect(manager.checkApproval({ toolName: 'bash', toolArgs: { command: 'rm file' } }).allowed).toBe(false);
    });
  });

  describe('Blocklists override the policy', () => {
    it('blockedTools are refused even under a full policy', () => {
      const manager = createApprovalManager();
      manager.addRule(rule({ id: 'no-rm-tool', policy: 'full', blockedTools: ['dangerous'] }));

      expect(manager.checkApproval({ toolName: 'read', toolArgs: {} }).allowed).toBe(true);

      const blocked = manager.checkApproval({ toolName: 'dangerous', toolArgs: {} });
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toContain('blocked');
    });

    it('blockedCommands match on substring inside the command args', () => {
      const manager = createApprovalManager();
      manager.addRule(rule({ id: 'no-rmrf', policy: 'full', blockedCommands: ['rm -rf'] }));

      expect(manager.checkApproval({ toolName: 'bash', toolArgs: { command: 'ls -la' } }).allowed).toBe(true);
      expect(manager.checkApproval({ toolName: 'bash', toolArgs: { command: 'sudo rm -rf /' } }).allowed).toBe(false);
    });

    it('blockedPatterns match via regex over the serialized args', () => {
      const manager = createApprovalManager();
      manager.addRule(rule({ id: 'regex-block', policy: 'full', blockedPatterns: ['rm\\s+-rf'] }));

      expect(manager.checkApproval({ toolName: 'bash', toolArgs: { command: 'echo hi' } }).allowed).toBe(true);
      expect(manager.checkApproval({ toolName: 'bash', toolArgs: { command: 'rm   -rf /' } }).allowed).toBe(false);
    });
  });

  describe('Rule scoping', () => {
    it('scopes a rule by channel', () => {
      const manager = createApprovalManager();
      manager.addRule(rule({ id: 'discord-deny', policy: 'deny', channels: ['discord'] }));

      const onDiscord: ApprovalContext = { toolName: 'bash', toolArgs: {}, channelId: 'discord' };
      const onCli: ApprovalContext = { toolName: 'bash', toolArgs: {}, channelId: 'cli' };

      expect(manager.checkApproval(onDiscord).allowed).toBe(false);
      // cli doesn't match the discord-only rule and falls through to the default policy
      expect(manager.checkApproval(onCli).rule?.id).toBeUndefined();
    });

    it('scopes a rule by sender', () => {
      const manager = createApprovalManager();
      manager.addRule(rule({ id: 'guest-deny', policy: 'deny', senders: ['user_guest'] }));

      const asGuest: ApprovalContext = { toolName: 'bash', toolArgs: {}, senderId: 'user_guest' };
      const asAdmin: ApprovalContext = { toolName: 'bash', toolArgs: {}, senderId: 'user_admin' };

      expect(manager.checkApproval(asGuest).allowed).toBe(false);
      expect(manager.checkApproval(asGuest).rule?.id).toBe('guest-deny');
      expect(manager.checkApproval(asAdmin).rule?.id).toBeUndefined();
    });

    it('scopes a rule by agent', () => {
      const manager = createApprovalManager();
      manager.addRule(rule({ id: 'shell-full', policy: 'full', agents: ['ShellAgent'] }));

      const shell: ApprovalContext = { toolName: 'bash', toolArgs: {}, agentId: 'ShellAgent' };
      const other: ApprovalContext = { toolName: 'bash', toolArgs: {}, agentId: 'OtherAgent' };

      expect(manager.checkApproval(shell).allowed).toBe(true);
      expect(manager.checkApproval(other).rule?.id).toBeUndefined();
    });

    it('applies the highest-priority matching rule first', () => {
      const manager = createApprovalManager();
      manager.addRule(rule({ id: 'allow-bash', policy: 'full', tools: ['bash'], priority: 1 }));
      manager.addRule(rule({ id: 'block-bash', policy: 'deny', tools: ['bash'], priority: 100 }));

      const result = manager.checkApproval({ toolName: 'bash', toolArgs: {} });
      expect(result.allowed).toBe(false);
      expect(result.rule?.id).toBe('block-bash');
    });
  });

  describe('Request / approve / reject flow', () => {
    it('creates a pending request and resolves it on approval', async () => {
      const manager = createApprovalManager();
      manager.setDefaultPolicy('allowlist'); // nothing allowlisted -> approval required

      const pending = manager.requestApproval({ toolName: 'bash', toolArgs: { command: 'npm i' } });

      const requests = manager.getPendingRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0].status).toBe('pending');

      expect(manager.approveRequest(requests[0].id, 'admin')).toBe(true);

      const result = await pending;
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('Approved');
      // once resolved it is no longer pending
      expect(manager.getPendingRequests()).toHaveLength(0);
    });

    it('creates a pending request and resolves it on rejection', async () => {
      const manager = createApprovalManager();
      manager.setDefaultPolicy('allowlist');

      const pending = manager.requestApproval({ toolName: 'bash', toolArgs: {} });
      const [req] = manager.getPendingRequests();

      expect(manager.rejectRequest(req.id, 'Too dangerous', 'admin')).toBe(true);

      const result = await pending;
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Rejected');

      const stored = manager.getRequest(req.id);
      expect(stored?.status).toBe('rejected');
      expect(stored?.reason).toBe('Too dangerous');
    });

    it('expires a request that is never resolved within its timeout', async () => {
      const manager = createApprovalManager();
      manager.addRule(
        rule({
          id: 'needs-approval',
          policy: 'allowlist',
          allowedTools: ['bash'],
          requireApproval: true,
          approvalTimeout: 30,
        })
      );

      const result = await manager.requestApproval({ toolName: 'bash', toolArgs: {} });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('timed out');
      expect(result.requestId).toBeDefined();
      expect(manager.getRequest(result.requestId!)?.status).toBe('expired');
    });
  });
});
