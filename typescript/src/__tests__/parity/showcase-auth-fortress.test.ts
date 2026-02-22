/**
 * Showcase: Authorization Fortress
 *
 * Tests ApprovalManager: policies, rules, priority, scoping, blocked patterns,
 * request/approve/reject flow. No agents needed — pure ApprovalManager tests.
 */

import { describe, it, expect } from 'vitest';
import { ApprovalManager, createApprovalManager } from '../../security/approvals.js';
import type { ApprovalRule, ApprovalContext } from '../../security/approvals.js';

describe('Showcase: Authorization Fortress', () => {
  describe('Default deny policy', () => {
    it('should block all tool calls with deny policy', () => {
      const manager = createApprovalManager();
      manager.setDefaultPolicy('deny');

      const result = manager.checkApproval({ toolName: 'bash', toolArgs: { command: 'ls' } });
      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(false);
      expect(result.reason).toContain('denied');
    });
  });

  describe('Full policy', () => {
    it('should allow all tool calls with full policy', () => {
      const manager = createApprovalManager();
      manager.setDefaultPolicy('full');

      const result = manager.checkApproval({ toolName: 'bash', toolArgs: { command: 'rm -rf /' } });
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });
  });

  describe('Allowlist policy', () => {
    it('should allow tools on the allowedTools list', () => {
      const manager = createApprovalManager();
      manager.addRule({
        id: 'safe-tools',
        name: 'Safe Tools',
        policy: 'allowlist',
        allowedTools: ['read', 'list', 'search'],
        priority: 10,
        enabled: true,
      });

      const allowed = manager.checkApproval({ toolName: 'read', toolArgs: {} });
      expect(allowed.allowed).toBe(true);

      const blocked = manager.checkApproval({ toolName: 'bash', toolArgs: {} });
      // bash not in allowlist — allowlist rule doesn't match (no tools scope), falls to default
      expect(blocked.requiresApproval).toBe(true);
    });
  });

  describe('Priority ordering', () => {
    it('should apply higher priority rule first', () => {
      const manager = createApprovalManager();

      manager.addRule({
        id: 'low-priority',
        name: 'Allow All',
        policy: 'full',
        tools: ['bash'],
        priority: 1,
        enabled: true,
      });

      manager.addRule({
        id: 'high-priority',
        name: 'Block Bash',
        policy: 'deny',
        tools: ['bash'],
        priority: 100,
        enabled: true,
      });

      const result = manager.checkApproval({ toolName: 'bash', toolArgs: {} });
      expect(result.allowed).toBe(false);
      expect(result.rule?.id).toBe('high-priority');
    });
  });

  describe('Scoped rules', () => {
    it('should scope rule by channel', () => {
      const manager = createApprovalManager();
      manager.addRule({
        id: 'slack-only',
        name: 'Slack Deny',
        policy: 'deny',
        channels: ['slack'],
        priority: 10,
        enabled: true,
      });

      const slackCtx: ApprovalContext = { toolName: 'bash', toolArgs: {}, channelId: 'slack' };
      const discordCtx: ApprovalContext = { toolName: 'bash', toolArgs: {}, channelId: 'discord' };

      expect(manager.checkApproval(slackCtx).allowed).toBe(false);
      // Discord doesn't match the slack-only rule, falls through to default
      const discordResult = manager.checkApproval(discordCtx);
      expect(discordResult.rule?.id).toBeUndefined();
    });

    it('should scope rule by agent', () => {
      const manager = createApprovalManager();
      manager.addRule({
        id: 'shell-only',
        name: 'Shell Agent Full',
        policy: 'full',
        agents: ['ShellAgent'],
        priority: 10,
        enabled: true,
      });

      const shellCtx: ApprovalContext = { toolName: 'bash', toolArgs: {}, agentId: 'ShellAgent' };
      const otherCtx: ApprovalContext = { toolName: 'bash', toolArgs: {}, agentId: 'OtherAgent' };

      expect(manager.checkApproval(shellCtx).allowed).toBe(true);
      expect(manager.checkApproval(otherCtx).rule?.id).toBeUndefined();
    });
  });

  describe('Blocked patterns', () => {
    it('should block tools matching blockedPatterns regex', () => {
      const manager = createApprovalManager();
      manager.addRule({
        id: 'no-rm',
        name: 'No Remove',
        policy: 'full',
        blockedPatterns: ['rm\\s+-rf'],
        priority: 10,
        enabled: true,
      });

      const safe = manager.checkApproval({ toolName: 'bash', toolArgs: { command: 'ls -la' } });
      expect(safe.allowed).toBe(true);

      const dangerous = manager.checkApproval({ toolName: 'bash', toolArgs: { command: 'rm -rf /' } });
      expect(dangerous.allowed).toBe(false);
      expect(dangerous.reason).toContain('blocked');
    });
  });

  describe('Request/approve flow', () => {
    it('should create pending request and approve it', async () => {
      const manager = createApprovalManager();
      manager.setDefaultPolicy('allowlist');
      // No allowlist rules — all tools require approval

      const approvalPromise = manager.requestApproval({ toolName: 'bash', toolArgs: {} });

      // Get pending request
      const pending = manager.getPendingRequests();
      expect(pending.length).toBe(1);
      expect(pending[0].status).toBe('pending');

      // Approve it
      const approved = manager.approveRequest(pending[0].id, 'admin');
      expect(approved).toBe(true);

      const result = await approvalPromise;
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('Approved');
    });
  });

  describe('Request/reject flow', () => {
    it('should create pending request and reject it', async () => {
      const manager = createApprovalManager();
      manager.setDefaultPolicy('allowlist');

      const approvalPromise = manager.requestApproval({ toolName: 'bash', toolArgs: {} });

      const pending = manager.getPendingRequests();
      expect(pending.length).toBe(1);

      const rejected = manager.rejectRequest(pending[0].id, 'Too dangerous', 'admin');
      expect(rejected).toBe(true);

      const result = await approvalPromise;
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Rejected');

      // Request should be cleaned up
      const request = manager.getRequest(pending[0].id);
      expect(request?.status).toBe('rejected');
      expect(request?.reason).toBe('Too dangerous');
    });
  });
});
