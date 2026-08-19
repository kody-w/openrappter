/**
 * The test suite must never read or write the developer's real installation.
 *
 * 106 of the 117 `new GatewayServer(...)` calls in this suite pass no explicit
 * `dataDir`, so they resolve through `openrappterHome()` like production does.
 * Without `vitest.setup.ts` redirecting `OPENRAPPTER_HOME`, that is the real
 * `~/.openrappter` -- and a single `npx vitest run` left three fixture
 * sessions in a real store: `test-session` and `test-session-2` from
 * `gateway.protocol.test.ts`, and `abort-session` from
 * `brainstem-abort.test.ts`.
 *
 * Nothing failed when that happened, which is the point of this file. The
 * fixtures were written by `saveSessions()` into real user data and simply
 * accumulated, run after run. The reverse direction is a flakiness source:
 * `chat.list` returns 25 sessions on a developer's machine and none in CI.
 *
 * If someone removes the setup file or the config entry, these fail rather
 * than the suite quietly going back to writing into a real home.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir, tmpdir } from 'os';
import { openrappterHome } from '../../infra/openrappter-home.js';

describe('tests are isolated from the real installation', () => {
  it('OPENRAPPTER_HOME is set and points into a temp directory', () => {
    const home = process.env.OPENRAPPTER_HOME;
    expect(home).toBeDefined();
    expect(home!.startsWith(tmpdir())).toBe(true);
  });

  it('the resolved data directory is not the real one', () => {
    const real = resolve(homedir(), '.openrappter');
    expect(resolve(openrappterHome())).not.toBe(real);

    // Not merely different -- outside it entirely, so no test can reach a
    // subdirectory of the developer's installation either.
    expect(resolve(openrappterHome()).startsWith(real)).toBe(false);
  });

  it('vitest.config.ts still loads the setup file', () => {
    // The assertions above run *because* the setup file ran. If the config
    // entry is deleted they would still pass in a stale process, so pin the
    // wiring itself.
    const config = readFileSync(resolve(__dirname, '../../../vitest.config.ts'), 'utf-8');
    expect(config).toMatch(/setupFiles:\s*\[\s*'\.\/vitest\.setup\.ts'\s*\]/);
  });

  it('the setup file redirects OPENRAPPTER_HOME', () => {
    const setup = readFileSync(resolve(__dirname, '../../../vitest.setup.ts'), 'utf-8');
    expect(setup).toMatch(/process\.env\.OPENRAPPTER_HOME\s*=/);
    expect(setup).toMatch(/mkdtempSync/);
  });
});
