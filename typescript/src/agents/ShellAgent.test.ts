/**
 * ShellAgent — command-execution safety wiring tests.
 *
 * Verifies that real bash execution enforces ExecSafety immediately before
 * every subprocess call, for both the explicit `action: 'bash'` path and the
 * natural-language query inference path. See typescript/src/security/exec-safety.ts
 * for the underlying policy (injection detection, safe-binary allowlisting,
 * single-use approval tokens).
 */

import { describe, it, expect } from 'vitest';
import { ShellAgent } from './ShellAgent.js';

describe('ShellAgent — safety wiring', () => {
  describe('safe commands', () => {
    it('executes an allowed command normally via action: bash', async () => {
      const agent = new ShellAgent();
      const result = JSON.parse(await agent.execute({ action: 'bash', command: 'echo hello' }));
      expect(result.status).toBe('success');
      expect(result.output).toContain('hello');
    });

    it('executes an allowed command inferred from a natural language query', async () => {
      const agent = new ShellAgent();
      const result = JSON.parse(await agent.execute({ query: 'run echo hello-from-query' }));
      expect(result.status).toBe('success');
      expect(result.output).toContain('hello-from-query');
    });
  });

  describe('dangerous commands', () => {
    it('blocks a command with a binary outside the safe list', async () => {
      const agent = new ShellAgent();
      const result = JSON.parse(await agent.execute({ action: 'bash', command: 'rm -rf /' }));
      expect(result.status).toBe('error');
      expect(result.blocked).toBe(true);
      expect(result.approval_required).toBe(true);
      expect(typeof result.approval_id).toBe('string');
    });

    it('blocks via the query-inference path too (no alternate bypass)', async () => {
      const agent = new ShellAgent();
      const result = JSON.parse(await agent.execute({ query: 'run rm -rf /' }));
      expect(result.status).toBe('error');
      expect(result.blocked).toBe(true);
    });
  });

  describe('chaining and substitution bypass attempts', () => {
    it('blocks command chaining even when every binary individually is safe', async () => {
      const agent = new ShellAgent();
      const result = JSON.parse(
        await agent.execute({ action: 'bash', command: 'echo hi && rm -rf /' })
      );
      expect(result.status).toBe('error');
      expect(result.blocked).toBe(true);
    });

    it('blocks semicolon chaining', async () => {
      const agent = new ShellAgent();
      const result = JSON.parse(
        await agent.execute({ action: 'bash', command: 'echo hi; rm -rf /' })
      );
      expect(result.status).toBe('error');
      expect(result.blocked).toBe(true);
    });

    it('blocks command substitution', async () => {
      const agent = new ShellAgent();
      const result = JSON.parse(
        await agent.execute({ action: 'bash', command: 'echo $(rm -rf /)' })
      );
      expect(result.status).toBe('error');
      expect(result.blocked).toBe(true);
    });

    it('blocks pipe chaining', async () => {
      const agent = new ShellAgent();
      const result = JSON.parse(
        await agent.execute({ action: 'bash', command: 'cat /etc/passwd | rm -rf /' })
      );
      expect(result.status).toBe('error');
      expect(result.blocked).toBe(true);
    });
  });

  describe('approval token issuance, resolution, and use', () => {
    it('requires approval for a dual-use binary even when classification is safe', async () => {
      const agent = new ShellAgent();
      const cmd = 'node --version';

      const blocked = JSON.parse(await agent.execute({ action: 'bash', command: cmd }));
      expect(blocked.status).toBe('error');
      expect(blocked.approval_required).toBe(true);

      const approvalId = blocked.approval_id as string;
      expect(agent.getExecSafety().resolveApprovalToken(approvalId, true)).toBe(true);
      const allowed = JSON.parse(
        await agent.execute({ action: 'bash', command: cmd, approval_id: approvalId })
      );
      expect(allowed.status).toBe('success');
    });

    it('issues an approval token when blocked, then allows execution once resolved', async () => {
      const agent = new ShellAgent();
      const cmd = 'rm -rf /tmp/exec-safety-ts-test-dir';

      const blocked = JSON.parse(await agent.execute({ action: 'bash', command: cmd }));
      expect(blocked.status).toBe('error');
      const approvalId = blocked.approval_id as string;
      expect(approvalId).toBeTruthy();

      // Using the token before it's approved must still fail closed.
      const stillBlocked = JSON.parse(
        await agent.execute({ action: 'bash', command: cmd, approval_id: approvalId })
      );
      expect(stillBlocked.status).toBe('error');

      // Resolve out-of-band via the shared safety engine, then retry.
      expect(agent.getExecSafety().resolveApprovalToken(approvalId, true)).toBe(true);

      const allowed = JSON.parse(
        await agent.execute({ action: 'bash', command: cmd, approval_id: approvalId })
      );
      expect(allowed.status).toBe('success');
    });

    it('rejects a mismatched command using someone else\'s approval id', async () => {
      const agent = new ShellAgent();
      const cmd = 'rm -rf /tmp/exec-safety-ts-test-dir-2';

      const blocked = JSON.parse(await agent.execute({ action: 'bash', command: cmd }));
      const approvalId = blocked.approval_id as string;
      agent.getExecSafety().resolveApprovalToken(approvalId, true);

      const mismatched = JSON.parse(
        await agent.execute({
          action: 'bash',
          command: 'rm -rf /tmp/some-other-dir',
          approval_id: approvalId,
        })
      );
      expect(mismatched.status).toBe('error');
      expect(mismatched.blocked).toBe(true);
    });

    it('cannot replay a single-use approval token', async () => {
      const agent = new ShellAgent();
      const cmd = 'rm -rf /tmp/exec-safety-ts-test-dir-3';

      const blocked = JSON.parse(await agent.execute({ action: 'bash', command: cmd }));
      const approvalId = blocked.approval_id as string;
      agent.getExecSafety().resolveApprovalToken(approvalId, true);

      const first = JSON.parse(
        await agent.execute({ action: 'bash', command: cmd, approval_id: approvalId })
      );
      expect(first.status).toBe('success');

      const replay = JSON.parse(
        await agent.execute({ action: 'bash', command: cmd, approval_id: approvalId })
      );
      expect(replay.status).toBe('error');
      expect(replay.blocked).toBe(true);
    });

    it('a bare boolean approved flag never bypasses safety', async () => {
      const agent = new ShellAgent();
      const result = JSON.parse(
        await agent.execute({ action: 'bash', command: 'rm -rf /', approved: true } as Record<
          string,
          unknown
        >)
      );
      expect(result.status).toBe('error');
      expect(result.blocked).toBe(true);
    });

    it('rejects execution when the approval was explicitly rejected', async () => {
      const agent = new ShellAgent();
      const cmd = 'rm -rf /tmp/exec-safety-ts-test-dir-4';

      const blocked = JSON.parse(await agent.execute({ action: 'bash', command: cmd }));
      const approvalId = blocked.approval_id as string;
      agent.getExecSafety().resolveApprovalToken(approvalId, false);

      const rejected = JSON.parse(
        await agent.execute({ action: 'bash', command: cmd, approval_id: approvalId })
      );
      expect(rejected.status).toBe('error');
      expect(rejected.blocked).toBe(true);
    });
  });
});
