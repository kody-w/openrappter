/**
 * The product must use a path that works, and say what to do when none does.
 *
 * The defect: openrappter always constructed the Copilot SDK provider, which
 * needs a GitHub token carrying Copilot API access. On this machine the stored
 * profile held test fixtures (`sk-test`, `oauth-token`, `device-token`) and
 * neither real `gh` account had Copilot scope — so every message returned
 * "GitHub token does not have Copilot API access", while a working, separately
 * authenticated Copilot CLI sat on the same disk answering fine.
 *
 * Two things are asserted, and the second matters as much as the first:
 *   1. it falls back to the rung that works;
 *   2. when nothing works it produces a REMEDY — words a person can act on —
 *      rather than proceeding to fail on the next request.
 */

import { describe, expect, it } from 'vitest';
import { selectBackend } from '../backend-select.js';

const yes = async () => true;
const no = async () => false;

describe('backend selection', () => {
  it('honours an explicitly pinned backend without probing', async () => {
    let probed = false;
    const choice = await selectBackend({
      env: { OPENRAPPTER_AI_BACKEND: 'copilot-cli' },
      probeSdk: async () => { probed = true; return true; },
      probeCli: async () => { probed = true; return true; },
    });
    expect(choice.kind).toBe('copilot-cli');
    expect(probed, 'a pinned backend must be taken at its word').toBe(false);
  });

  it('uses the SDK when its token really exchanges', async () => {
    const choice = await selectBackend({
      githubToken: 'gho_real', env: {}, probeSdk: yes, probeCli: yes,
    });
    expect(choice.kind).toBe('copilot-sdk');
    expect(choice.provider).not.toBeNull();
  });

  // THE ONE THIS FILE EXISTS FOR.
  it('falls back to the CLI when the GitHub token has no Copilot access', async () => {
    const choice = await selectBackend({
      githubToken: 'gho_unentitled', env: {}, probeSdk: no, probeCli: yes,
    });
    expect(choice.kind).toBe('copilot-cli');
    expect(choice.provider).not.toBeNull();
    expect(choice.reason).toMatch(/no Copilot access/i);
  });

  it('holding a token is not evidence the token works', async () => {
    // The old code treated "a token exists" as "the SDK will work". It does not.
    const choice = await selectBackend({
      githubToken: 'sk-test', env: {}, probeSdk: no, probeCli: yes,
    });
    expect(choice.kind).not.toBe('copilot-sdk');
  });

  it('uses the CLI when there is no token at all', async () => {
    const choice = await selectBackend({ env: {}, probeSdk: no, probeCli: yes });
    expect(choice.kind).toBe('copilot-cli');
    expect(choice.reason).toMatch(/own sign-in/i);
  });

  it('reports a remedy — not a failure — when nothing can answer', async () => {
    const choice = await selectBackend({
      githubToken: 'gho_unentitled', env: {}, probeSdk: no, probeCli: no,
    });
    expect(choice.kind).toBe('none');
    expect(choice.provider).toBeNull();
    expect(choice.remedy).toBeDefined();
    expect(choice.remedy!.title).toMatch(/reconnect/i);
    expect(choice.remedy!.action).toBe('reconnect-github');
    // The thing Kody actually saw was the command line. Never that again.
    expect(JSON.stringify(choice.remedy)).not.toMatch(/Command failed/);
    expect(JSON.stringify(choice.remedy)).not.toMatch(/<identity>/);
  });

  it('distinguishes "never connected" from "connection expired"', async () => {
    const fresh = await selectBackend({ env: {}, probeSdk: no, probeCli: no });
    expect(fresh.remedy!.action).toBe('install-copilot-cli');
    expect(fresh.remedy!.title).toMatch(/connect/i);
  });

  it('never returns a provider alongside a remedy', async () => {
    // A remedy means "cannot answer". Returning a provider too would let the
    // caller try anyway and produce the error this exists to prevent.
    const choice = await selectBackend({ env: {}, probeSdk: no, probeCli: no });
    expect(choice.provider).toBeNull();
  });

  it('prefers the SDK over the CLI when both work', async () => {
    const choice = await selectBackend({
      githubToken: 'gho_real', env: {}, probeSdk: yes, probeCli: yes,
    });
    expect(choice.kind).toBe('copilot-sdk');
  });
});
