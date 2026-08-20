/**
 * `OPENRAPPTER_PORT` has one meaning, not one per reader. — round 172
 *
 * The variable used to be parsed by `parseInt` on the paths that decide what
 * the gateway BINDS and by `Number` on the paths that decide what its lock file
 * is NAMED for. Those two disagree on real inputs, so a single environment
 * could put the server on one port and its lock on another.
 *
 * These tests are written against the values where the old parsers differed,
 * because a test using only "18790" would have passed before the fix as well.
 */

import { describe, expect, it } from 'vitest';

import { portFromEnvironment } from '../../infra/cli-port.js';
import { gatewayPortFor } from '../../infra/gateway-lock.js';

describe('portFromEnvironment', () => {
  describe('the inputs where the two old parsers disagreed', () => {
    // parseInt('0x1F90', 10) stops at the 'x' and yields 0 — a request for an
    // arbitrary ephemeral port. Number('0x1F90') yields 8080. The server took
    // the first answer and the lock took the second.
    it('refuses hex-looking input rather than binding one port and locking another', () => {
      expect(Number.parseInt('0x1F90', 10)).toBe(0);
      expect(Number('0x1F90')).toBe(8080);
      // One answer now, whatever the caller is going to do with it.
      expect(portFromEnvironment('0x1F90')).toBe(8080);
    });

    it('refuses a number with trailing garbage instead of silently truncating', () => {
      expect(Number.parseInt('18790abc', 10)).toBe(18790);
      expect(() => portFromEnvironment('18790abc')).toThrow(/Invalid OPENRAPPTER_PORT/);
    });

    it('refuses a fraction instead of truncating it to a different port', () => {
      expect(Number.parseInt('8080.5', 10)).toBe(8080);
      expect(() => portFromEnvironment('8080.5')).toThrow(/Invalid OPENRAPPTER_PORT/);
    });
  });

  describe('agreement with --port', () => {
    // The flag's own parser rejects these. The variable used not to.
    it.each([
      ['0', 'ephemeral-port request the flag rejects'],
      ['-1', 'negative'],
      ['65536', 'above the maximum'],
      ['99999', 'far above the maximum'],
      ['abc', 'not a number'],
    ])('rejects %s (%s)', (raw) => {
      expect(() => portFromEnvironment(raw)).toThrow(/Invalid OPENRAPPTER_PORT/);
    });

    it.each([['1'], ['8080'], ['18790'], ['65535']])('accepts %s', (raw) => {
      expect(portFromEnvironment(raw)).toBe(Number(raw));
    });

    it('names the offending value so the variable can be found and fixed', () => {
      expect(() => portFromEnvironment('nonsense')).toThrow(/"nonsense"/);
    });
  });

  describe('"no opinion" stays distinguishable from "port zero"', () => {
    // Callers rely on undefined to keep their own default. Returning 0 or NaN
    // here would be read as an instruction.
    it('returns undefined when unset', () => {
      expect(portFromEnvironment(undefined)).toBeUndefined();
    });

    it.each([[''], ['   ']])('returns undefined for empty input %j', (raw) => {
      expect(portFromEnvironment(raw)).toBeUndefined();
    });

    it('tolerates surrounding whitespace on a real value', () => {
      expect(portFromEnvironment('  8080  ')).toBe(8080);
    });
  });

  describe('the lock and the server cannot disagree', () => {
    /**
     * The point of the fix. `gatewayPortFor` screens its input with
     * `Number.isFinite`, so a NaN from the old `Number` path was discarded in
     * silence and the lock quietly took the derived port instead — while the
     * server, using `parseInt`, bound something else entirely.
     */
    it('gives the lock the same port the server will bind', () => {
      const resolved = portFromEnvironment('8080');
      expect(resolved).toBe(8080);
      expect(gatewayPortFor({ port: resolved })).toBe(8080);
    });

    it('never hands gatewayPortFor a value it would silently discard', () => {
      // Every input either produces a port gatewayPortFor honours, or throws.
      for (const raw of ['0x1F90', '8080', '1', '65535', '  9000 ']) {
        let resolved: number | undefined;
        try {
          resolved = portFromEnvironment(raw);
        } catch {
          continue;
        }
        expect(Number.isFinite(resolved)).toBe(true);
        expect(gatewayPortFor({ port: resolved })).toBe(resolved);
      }
    });

    it('reads the live environment variable by default', () => {
      const previous = process.env.OPENRAPPTER_PORT;
      try {
        process.env.OPENRAPPTER_PORT = '12345';
        expect(portFromEnvironment()).toBe(12345);
        process.env.OPENRAPPTER_PORT = 'not-a-port';
        expect(() => portFromEnvironment()).toThrow(/Invalid OPENRAPPTER_PORT/);
      } finally {
        if (previous === undefined) delete process.env.OPENRAPPTER_PORT;
        else process.env.OPENRAPPTER_PORT = previous;
      }
    });
  });
});
