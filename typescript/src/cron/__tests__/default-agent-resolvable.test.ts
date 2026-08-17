import { describe, it, expect } from 'vitest';
import {
  CronService,
  DEFAULT_CRON_AGENT_ID,
  isAssistantCronAgent,
} from '../service.js';

/**
 * A job created without an agent must be runnable.
 *
 * `addJob` supplies a default agent id; the daemon executor in `index.ts`
 * decides which ids mean "the built-in assistant". Those two lived in separate
 * files with no reason to agree, and they did not: the default was `'main'`
 * and the executor resolved only `'Assistant'` and `'openrappter'`, so every
 * job created without `-a` was scheduled, persisted, fired exactly on time and
 * then failed with `Agent not found: main`.
 *
 * Neither file was wrong on its own, which is why nothing caught it. That is
 * the shape of the invariant below: it is deliberately written against
 * `DEFAULT_CRON_AGENT_ID` rather than the string `'main'`, so it keeps holding
 * if the default is ever renamed, and it fails the moment the two sides drift
 * apart again — whichever side moves.
 *
 * It is also decision-independent. #179 asks whether `'main'` should be an
 * alias, be rejected at creation, or be replaced at creation with the real
 * name. Any of those keeps this test green; what none of them may do is leave
 * a default the executor cannot resolve.
 */
describe('cron default agent is resolvable', () => {
  it('the executor accepts whatever addJob defaults to', () => {
    expect(isAssistantCronAgent(DEFAULT_CRON_AGENT_ID, 'openrappter')).toBe(true);
  });

  it('holds regardless of what the assistant is called', () => {
    // The default must not depend on the deployment's assistant name — that is
    // the coupling that made the two files look independently correct.
    for (const assistantName of ['openrappter', 'rappter-two', '']) {
      expect(isAssistantCronAgent(DEFAULT_CRON_AGENT_ID, assistantName)).toBe(true);
    }
  });

  it('a job created without an agent gets an id the executor can run', async () => {
    const service = new CronService();
    const job = await service.addJob({
      name: 'nightly',
      schedule: '0 3 * * *',
      message: 'summarise yesterday',
    });

    expect(job.agentId).toBe(DEFAULT_CRON_AGENT_ID);
    expect(isAssistantCronAgent(job.agentId, 'openrappter')).toBe(true);
  });

  it('an explicitly named agent is still treated as a registry lookup', () => {
    // The fix must not swallow real agent names into the assistant branch, or
    // a job targeting HackerNewsAgent would silently run the assistant instead
    // — a quieter version of the same bug.
    expect(isAssistantCronAgent('HackerNewsAgent', 'openrappter')).toBe(false);
    expect(isAssistantCronAgent('MemoryAgent', 'openrappter')).toBe(false);
  });

  it('still resolves the two names the executor already accepted', () => {
    expect(isAssistantCronAgent('Assistant', 'openrappter')).toBe(true);
    expect(isAssistantCronAgent('openrappter', 'openrappter')).toBe(true);
  });
});
