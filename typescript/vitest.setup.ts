/**
 * Point every test at a throwaway data directory.
 *
 * `openrappterHome()` resolves `$OPENRAPPTER_HOME`, falling back to
 * `~/.openrappter`. 106 of the 117 `new GatewayServer(...)` calls in this
 * suite pass no explicit `dataDir`, so without this file they load -- and
 * write -- the developer's real installation.
 *
 * That is not hypothetical. A single `npx vitest run` on a clean checkout left
 * three fixture sessions in a real store: `test-session` and `test-session-2`
 * from `gateway.protocol.test.ts`, and `abort-session` from
 * `brainstem-abort.test.ts`. Nothing failed -- `saveSessions()` simply wrote
 * them into real user data, where they accumulated run after run.
 *
 * The reverse is just as bad: a test that *reads* that directory depends on
 * whatever the developer happens to have, so `chat.list` returns 25 sessions
 * on one machine and none in CI.
 *
 * Set before any test module is imported, so a module that captures a path at
 * import time still sees the temp directory. Tests that need their own home
 * must set `OPENRAPPTER_HOME` explicitly (see `isolatedHomeEnv` helpers) --
 * setting only `HOME` is no longer sufficient, because the dedicated variable
 * correctly outranks it.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = mkdtempSync(join(tmpdir(), 'openrappter-test-home-'));

// The directory is named `.openrappter` deliberately: several tests assert the
// resolved path ends in it (that name is part of the product's contract), and
// a temp dir called anything else would fail them for the wrong reason.
const home = join(root, '.openrappter');
mkdirSync(home, { recursive: true });
process.env.OPENRAPPTER_HOME = home;

export function teardown(): void {
  rmSync(root, { recursive: true, force: true });
}
