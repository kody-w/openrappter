/**
 * `resolveCopilotAuth` is where "rejected" and "missing" become distinguishable.
 *
 * Before it existed, both returned `null` and the daemon guessed — wrongly. This
 * pair of lines is from a real log on this machine, seconds apart:
 *
 *   🦖 Cached GitHub token rejected by Copilot API — re-authenticating…
 *   🦖 No GitHub token found. Run 'openrappter onboard' to set up Copilot.
 *
 * A token was found, then reported absent. Under launchd there is no TTY, so
 * the re-authentication the first line promises never ran.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveCopilotAuth, autoAuthIfNeeded } from '../../copilot-check.js';

const accepts = async () => undefined;
const refuses = async () => { throw new Error('401 Unauthorized'); };

describe('resolveCopilotAuth', () => {
  it('reports "rejected" when a token exists but Copilot refuses it', async () => {
    const outcome = await resolveCopilotAuth({
      silent: true, interactive: false,
      discoverToken: async () => 'ghu_stale', validateToken: refuses,
    });
    expect(outcome).toEqual({ status: 'rejected', interactive: false });
  });

  it('reports "missing" when no token is discovered at all', async () => {
    const outcome = await resolveCopilotAuth({
      silent: true, interactive: false,
      discoverToken: async () => null, validateToken: accepts,
    });
    expect(outcome).toEqual({ status: 'missing', interactive: false });
  });

  it('distinguishes the two, which is the entire point', async () => {
    const rejected = await resolveCopilotAuth({
      silent: true, interactive: false,
      discoverToken: async () => 'ghu_stale', validateToken: refuses,
    });
    const missing = await resolveCopilotAuth({
      silent: true, interactive: false,
      discoverToken: async () => null, validateToken: accepts,
    });
    expect(rejected.status).not.toBe(missing.status);
  });

  it('reports "authenticated" from cache when Copilot accepts the token', async () => {
    const outcome = await resolveCopilotAuth({
      silent: true, interactive: false,
      discoverToken: async () => 'ghu_good', validateToken: accepts,
    });
    expect(outcome).toMatchObject({ status: 'authenticated', token: 'ghu_good', source: 'cache' });
  });

  it('does not attempt validation when there is no token to validate', async () => {
    const validate = vi.fn(accepts);
    await resolveCopilotAuth({
      silent: true, interactive: false,
      discoverToken: async () => null, validateToken: validate,
    });
    expect(validate).not.toHaveBeenCalled();
  });

  it('stays silent about the rejection when asked to', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await resolveCopilotAuth({
      silent: true, interactive: false,
      discoverToken: async () => 'ghu_stale', validateToken: refuses,
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns about the rejection when not silenced', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await resolveCopilotAuth({
      interactive: false,
      discoverToken: async () => 'ghu_stale', validateToken: refuses,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/rejected by Copilot API/));
    warn.mockRestore();
  });

  it('autoAuthIfNeeded still collapses every failure to null, unchanged', async () => {
    expect(await autoAuthIfNeeded({
      silent: true, interactive: false,
      discoverToken: async () => 'ghu_stale', validateToken: refuses,
    })).toBeNull();
  });

  it('autoAuthIfNeeded still returns the token on success, unchanged', async () => {
    expect(await autoAuthIfNeeded({
      silent: true, interactive: false,
      discoverToken: async () => 'ghu_good', validateToken: accepts,
    })).toBe("ghu_good");
  });
});
