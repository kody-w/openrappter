/**
 * The six RPC-backed CLI commands shared a byte-identical private `withClient`
 * -- and therefore shared its missing `catch`. Commander does not await an
 * async `.action()`, so any rejection surfaced as an unhandled promise
 * rejection and Node printed a raw stack dump naming internal `ws` frames.
 *
 * These tests pin the consolidation (one definition, not six) and the message
 * mapping, so a failure the user can act on never regresses into a stack trace.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { explain, GATEWAY_PORT } from '../../cli/with-client.js';

const CLI_DIR = resolve(__dirname, '../../cli');

describe('withClient consolidation', () => {
  it('is defined exactly once across the CLI', () => {
    const offenders = readdirSync(CLI_DIR)
      .filter((f) => f.endsWith('.ts') && f !== 'with-client.ts')
      .filter((f) => /async function withClient/.test(readFileSync(join(CLI_DIR, f), 'utf-8')))
      .sort();

    // Six copies is how the same defect existed in six places at once. Any new
    // private copy is a place the next fix will not reach.
    expect(offenders).toEqual([]);
  });

  it('the commands that need it import the shared helper', () => {
    // Guard the guard: if the import name ever changes, the check above would
    // pass vacuously against files that no longer use a client at all.
    const users = ['approvals', 'backup', 'channels', 'cron', 'send', 'sessions'];
    for (const name of users) {
      const text = readFileSync(join(CLI_DIR, `${name}.ts`), 'utf-8');
      expect(text).toMatch(/import \{ withClient \} from '\.\/with-client\.js';/);
    }
  });
});

describe('explain', () => {
  it('turns a refused connection into an instruction', () => {
    const msg = explain(new Error('connect ECONNREFUSED 127.0.0.1:18790'));
    expect(msg).toContain(String(GATEWAY_PORT));
    expect(msg).toContain('openrappter gateway');
    expect(msg).not.toContain('ECONNREFUSED');
  });

  it('names version skew when a method is missing', () => {
    // The real case: a daemon older than the CLI. "Method not found" alone
    // reads like a bug in the command the user just typed.
    const msg = explain(new Error("Method 'exec.pending' not found"));
    expect(msg).toContain("Method 'exec.pending' not found");
    expect(msg).toContain('older than this CLI');
  });

  it('points at the token when the gateway refuses authorisation', () => {
    expect(explain(new Error('unauthorized'))).toContain('OPENRAPPTER_TOKEN');
  });

  it('passes anything unrecognised through unchanged', () => {
    // No invented advice for errors we do not understand.
    expect(explain(new Error('disk on fire'))).toBe('disk on fire');
  });

  it('handles a non-Error throw', () => {
    expect(explain('plain string')).toBe('plain string');
  });
});
