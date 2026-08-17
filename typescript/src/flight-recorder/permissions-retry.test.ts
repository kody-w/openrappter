import { describe, it, expect, vi } from 'vitest';
import {
  isTransientSpawnFailure,
  withTransientRetry,
} from './permissions.js';

/**
 * The retry policy guarding Windows ACL hardening.
 *
 * `hardenPrivatePath` spawns a fresh `powershell.exe` for every private path,
 * and the ACL script loads .NET security types, so a cold start on a loaded
 * machine is slow. CI hit `spawnSync powershell.exe ETIMEDOUT` inside
 * `ShowAndTellStore.initialize`, which aborts the operation that asked for a
 * private directory. On a user's machine the same timeout would stop
 * Show-and-Tell from starting at all.
 *
 * Retrying is only safe because of a distinction these tests exist to pin: a
 * refused or unverifiable ACL exits 1 from the script and must fail
 * immediately, while a process that never got off the ground may be retried.
 * If that line ever blurs, a real permissions failure would be retried and then
 * reported as if it were flaky — the opposite of failing closed.
 */

/** A spawn failure as Node reports it: an Error carrying an errno `code`. */
function spawnError(code: string): NodeJS.ErrnoException {
  const error = new Error(`spawnSync powershell.exe ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** A script that ran and rejected the ACL: non-zero `status`, no errno code. */
function aclRejected(): Error & { status: number } {
  const error = new Error('Command failed: powershell.exe') as Error & { status: number };
  error.status = 1;
  return error;
}

describe('transient spawn failures are distinguished from ACL failures', () => {
  it('treats a timed-out or unstartable process as transient', () => {
    expect(isTransientSpawnFailure(spawnError('ETIMEDOUT'))).toBe(true);
    expect(isTransientSpawnFailure(spawnError('EAGAIN'))).toBe(true);
    expect(isTransientSpawnFailure(spawnError('EBUSY'))).toBe(true);
  });

  it('does NOT treat a rejected ACL as transient', () => {
    // The security-critical case: the script ran, verification failed, exit 1.
    expect(isTransientSpawnFailure(aclRejected())).toBe(false);
  });

  it('does not treat permission or missing-binary errors as transient', () => {
    expect(isTransientSpawnFailure(spawnError('EACCES'))).toBe(false);
    expect(isTransientSpawnFailure(spawnError('ENOENT'))).toBe(false);
    expect(isTransientSpawnFailure(null)).toBe(false);
    expect(isTransientSpawnFailure(new Error('no code'))).toBe(false);
  });
});

describe('withTransientRetry', () => {
  it('retries a timeout once and returns the eventual success', () => {
    const operation = vi
      .fn(() => 'hardened')
      .mockImplementationOnce(() => { throw spawnError('ETIMEDOUT'); });

    expect(withTransientRetry(operation)).toBe('hardened');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('rethrows a rejected ACL immediately, without a second attempt', () => {
    const operation = vi.fn(() => { throw aclRejected(); });

    expect(() => withTransientRetry(operation)).toThrow(/Command failed/);
    // The important assertion: hardening is not attempted again, so a genuine
    // permissions failure can never be reported as a flake.
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt budget and surfaces the last failure', () => {
    const operation = vi.fn(() => { throw spawnError('ETIMEDOUT'); });

    expect(() => withTransientRetry(operation)).toThrow(/ETIMEDOUT/);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry a successful call', () => {
    const operation = vi.fn(() => 'ok');
    expect(withTransientRetry(operation)).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
