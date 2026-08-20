/**
 * ExecSafety keeps a history, and nothing was bounding it.
 *
 * The engine is a process-wide singleton (`getSharedExecSafety`) shared by
 * ShellAgent and the gateway, so whatever it retains is retained for the life
 * of the server. Measured against the released build:
 *
 *   20,000 refused commands        ->  20,000 entries kept,   8.3 MB
 *   2,000 refused 100 KB commands  ->  191.5 MB
 *   20,000 fully-used tokens       ->  all 20,000 still held
 *   5,000 refused 8 KB commands    ->  exec.history returned 40.1 MB
 *
 * Two things stand out and both are pinned below: refusing a command cost the
 * same as allowing one, and the size of each record was chosen by whoever sent
 * the command.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

import {
  ExecSafety,
  DEFAULT_MAX_AUDIT_ENTRIES,
  DEFAULT_MAX_AUDIT_COMMAND_CHARS,
  DEFAULT_MAX_APPROVAL_TOKENS,
} from '../exec-safety.js';

describe('the audit log stops growing', () => {
  it('keeps no more than the ceiling', () => {
    const safety = new ExecSafety(undefined, { maxAuditEntries: 100 });

    for (let i = 0; i < 5000; i++) safety.checkCommand(`ls /path/${i}`);

    expect(safety.getAuditLog()).toHaveLength(100);
  });

  it('refusing a command is not free either', () => {
    // The engine records blocked commands too, so a caller who only ever gets
    // refused could still grow the log without limit.
    const safety = new ExecSafety(undefined, { maxAuditEntries: 50 });

    for (let i = 0; i < 1000; i++) {
      const verdict = safety.checkCommand(`no-such-binary-${i} --flag`);
      expect(verdict.safe).toBe(false);
    }

    expect(safety.getAuditLog()).toHaveLength(50);
    expect(safety.getAuditDroppedCount()).toBe(950);
  });

  it('says how much history it threw away', () => {
    // A capped log that looks complete is worse than a short one that admits
    // it: someone investigating would conclude the entry was never written.
    const safety = new ExecSafety(undefined, { maxAuditEntries: 10 });

    for (let i = 0; i < 25; i++) safety.checkCommand(`ls /path/${i}`);

    expect(safety.getAuditDroppedCount()).toBe(15);
  });

  it('drops the oldest and keeps what just happened', () => {
    const safety = new ExecSafety(undefined, { maxAuditEntries: 3 });

    for (let i = 0; i < 6; i++) safety.checkCommand(`ls /path/${i}`);

    expect(safety.getAuditLog().map((e) => e.cmd)).toEqual([
      'ls /path/3',
      'ls /path/4',
      'ls /path/5',
    ]);
  });

  it('bounds the approval-token entries as well', () => {
    const safety = new ExecSafety(undefined, { maxAuditEntries: 5 });

    for (let i = 0; i < 50; i++) safety.issueApprovalToken(`curl http://host/${i}`);

    expect(safety.getAuditLog()).toHaveLength(5);
  });

  it('reports nothing lost once the log is deliberately emptied', () => {
    const safety = new ExecSafety(undefined, { maxAuditEntries: 2 });
    for (let i = 0; i < 10; i++) safety.checkCommand(`ls /path/${i}`);
    expect(safety.getAuditDroppedCount()).toBeGreaterThan(0);

    safety.clearAuditLog();

    expect(safety.getAuditLog()).toHaveLength(0);
    expect(safety.getAuditDroppedCount()).toBe(0);
  });

  it('has a ceiling without being asked', () => {
    const safety = new ExecSafety();
    for (let i = 0; i < DEFAULT_MAX_AUDIT_ENTRIES + 500; i++) {
      safety.checkCommand(`ls /path/${i}`);
    }
    expect(safety.getAuditLog()).toHaveLength(DEFAULT_MAX_AUDIT_ENTRIES);
  });
});

describe('the sender does not decide how much is stored', () => {
  it('keeps only the head of an oversized command', () => {
    const safety = new ExecSafety(undefined, { maxAuditCommandChars: 100 });

    safety.checkCommand('ls ' + 'A'.repeat(50_000));

    const [entry] = safety.getAuditLog();
    expect(entry.cmd.length).toBeLessThan(200);
    expect(entry.truncated).toBe(true);
  });

  it('says so in the text, not just in a flag', () => {
    // Whoever reads the history has to be able to tell the whole command from
    // the beginning of one.
    const safety = new ExecSafety(undefined, { maxAuditCommandChars: 20 });

    safety.checkCommand('ls ' + 'A'.repeat(5000));

    expect(safety.getAuditLog()[0].cmd).toContain('[truncated, 5003 chars total]');
  });

  it('leaves an ordinary command exactly as it was', () => {
    const safety = new ExecSafety(undefined, { maxAuditCommandChars: 2000 });

    safety.checkCommand('ls -la /tmp');

    const [entry] = safety.getAuditLog();
    expect(entry.cmd).toBe('ls -la /tmp');
    expect(entry.truncated).toBeUndefined();
  });

  it('truncates the record without ever truncating the decision', () => {
    // The dangerous part of a command can sit past the cutoff. If the safety
    // check ran on the shortened copy, padding would be all it took to hide a
    // second command behind a semicolon.
    const safety = new ExecSafety(undefined, { maxAuditCommandChars: 20 });

    const verdict = safety.checkCommand('ls ' + 'A'.repeat(5000) + '; rm -rf /');

    expect(verdict.safe).toBe(false);
    expect(verdict.injectionType).toBe('semicolon-chain');
  });

  it('still reads the real binary out of an oversized command', () => {
    const safety = new ExecSafety(undefined, { maxAuditCommandChars: 5 });

    safety.checkCommand('definitely-not-real ' + 'A'.repeat(5000));

    expect(safety.getAuditLog()[0].binary).toBe('definitely-not-real');
  });

  it('has a length ceiling without being asked', () => {
    const safety = new ExecSafety();
    safety.checkCommand('ls ' + 'A'.repeat(DEFAULT_MAX_AUDIT_COMMAND_CHARS * 4));
    expect(safety.getAuditLog()[0].truncated).toBe(true);
  });
});

describe('finished approval tokens are let go', () => {
  const heldTokens = (safety: ExecSafety): number =>
    (safety as unknown as { approvalTokens: Map<string, unknown> }).approvalTokens.size;

  it('does not hold on to tokens that have been spent', () => {
    const safety = new ExecSafety(undefined, { maxApprovalTokens: 10 });

    for (let i = 0; i < 500; i++) {
      const token = safety.issueApprovalToken(`ls /path/${i}`);
      safety.resolveApprovalToken(token.id, true);
      expect(safety.consumeApprovalToken(token.id, `ls /path/${i}`).ok).toBe(true);
    }

    expect(heldTokens(safety)).toBeLessThanOrEqual(11);
  });

  it('never drops a token still waiting on a person', () => {
    // Evicting a pending token would silently make an approval unanswerable.
    const safety = new ExecSafety(undefined, { maxApprovalTokens: 5 });

    const tokens = Array.from({ length: 100 }, (_, i) =>
      safety.issueApprovalToken(`ls /path/${i}`)
    );

    expect(safety.getPendingApprovalTokens()).toHaveLength(100);
    for (const token of tokens) {
      expect(safety.resolveApprovalToken(token.id, true)).toBe(true);
    }
  });

  it('never drops an approved token before it is spent', () => {
    // This one is the sharp edge: the human has already said yes, and the
    // command has not run yet. Losing it turns an approval into a refusal.
    const safety = new ExecSafety(undefined, { maxApprovalTokens: 5 });

    const approved = safety.issueApprovalToken('curl http://example.com');
    safety.resolveApprovalToken(approved.id, true);

    for (let i = 0; i < 200; i++) {
      const noise = safety.issueApprovalToken(`ls /path/${i}`);
      safety.resolveApprovalToken(noise.id, false);
    }

    expect(safety.consumeApprovalToken(approved.id, 'curl http://example.com').ok).toBe(true);
  });

  it('still catches a replay of a token that is recent', () => {
    const safety = new ExecSafety(undefined, { maxApprovalTokens: 50 });

    const token = safety.issueApprovalToken('ls /tmp');
    safety.resolveApprovalToken(token.id, true);
    expect(safety.consumeApprovalToken(token.id, 'ls /tmp').ok).toBe(true);

    const replay = safety.consumeApprovalToken(token.id, 'ls /tmp');
    expect(replay.ok).toBe(false);
    expect(replay.reason).toContain('already used');
  });

  it('refuses a token it has forgotten, rather than honouring it', () => {
    // Eviction must fail closed. A token pushed out of the table is unknown,
    // and unknown has to mean no.
    const safety = new ExecSafety(undefined, { maxApprovalTokens: 2 });

    const token = safety.issueApprovalToken('ls /tmp');
    safety.resolveApprovalToken(token.id, true);
    safety.consumeApprovalToken(token.id, 'ls /tmp');

    for (let i = 0; i < 50; i++) {
      const noise = safety.issueApprovalToken(`ls /path/${i}`);
      safety.resolveApprovalToken(noise.id, false);
    }

    const result = safety.consumeApprovalToken(token.id, 'ls /tmp');
    expect(result.ok).toBe(false);
  });

  it('lets go of tokens whose time ran out', () => {
    const safety = new ExecSafety(undefined, { maxApprovalTokens: 5 });

    for (let i = 0; i < 100; i++) safety.issueApprovalToken(`ls /path/${i}`, -1);
    safety.issueApprovalToken('ls /final');

    expect(heldTokens(safety)).toBeLessThanOrEqual(6);
  });

  it('has a ceiling without being asked', () => {
    const safety = new ExecSafety();

    for (let i = 0; i < DEFAULT_MAX_APPROVAL_TOKENS + 200; i++) {
      const token = safety.issueApprovalToken(`ls /path/${i}`);
      safety.resolveApprovalToken(token.id, false);
    }

    expect(heldTokens(safety)).toBeLessThanOrEqual(DEFAULT_MAX_APPROVAL_TOKENS + 1);
  });
});

describe('the shortened copy really does release the original', () => {
  // No assertion on the string can tell these apart: a plain slice and a
  // flattened copy are the same value. V8 just represents the first as a view
  // onto the whole command, so the "truncated" entry pins all of it in memory.
  // Measured, keeping 2,000 chars of 1,000 commands of 100,000 chars:
  // slice 95.4 MB, slice-plus-suffix 95.5 MB, flattened copy 2.0 MB.
  //
  // So this one has to weigh the heap, which needs a child process with
  // --expose-gc against the built output.
  const distUrl = new URL('../../../dist/security/exec-safety.js', import.meta.url);

  it.runIf(existsSync(fileURLToPath(distUrl)))(
    'does not keep whole commands alive behind their truncations',
    () => {
      const script = `
        const { ExecSafety } = await import(${JSON.stringify(distUrl.href)});
        const heap = () => { global.gc(); return process.memoryUsage().heapUsed; };
        const safety = new ExecSafety(undefined, { maxAuditEntries: 1000, maxAuditCommandChars: 2000 });
        const before = heap();
        for (let i = 0; i < 1000; i++) safety.checkCommand('nope ' + String(i) + 'A'.repeat(100000));
        const grew = heap() - before;
        if (safety.getAuditLog().length !== 1000) throw new Error('expected a full log');
        console.log(String(Math.round(grew / 1024 / 1024)));
      `;
      const grewMb = Number(
        execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], {
          encoding: 'utf8',
          timeout: 120_000,
        }).trim()
      );

      // 1,000 entries x 2,000 chars is about 4 MB of UTF-16. Retaining the
      // originals instead would be ~95 MB, so the two are not close.
      expect(grewMb).toBeLessThan(25);
    }
  );
});
