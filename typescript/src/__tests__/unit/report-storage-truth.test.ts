/**
 * A store is only stored if the store said so. — #136
 *
 * `ReportStorageAgent` returned `{status:'success', stored:true}`
 * unconditionally. Agents in this codebase do not throw: `execute()` returns a
 * JSON document and `MemoryAgent` reports failure as `{"status":"error"}`
 * inside it — `No message provided to remember`, or any storage failure.
 *
 * So a productivity report that was never stored was announced as stored, with
 * the contradicting reply sitting beside the claim in `memory_result`. The
 * truth was in the document and the summary next to it said the opposite,
 * which is worse than either alone: anything reading `stored` got the wrong
 * answer while the evidence was right there.
 *
 * Same rule as #134, different caller. The absence of an exception is not
 * evidence of anything.
 */

import { describe, it, expect } from 'vitest';
import { ReportStorageAgent } from '../../agents/ProductivityStackAgent.js';
import { BasicAgent } from '../../agents/BasicAgent.js';

class StubMemory extends BasicAgent {
  public calls = 0;

  constructor(private readonly reply: string) {
    super('StubMemory', {
      name: 'StubMemory',
      description: 'test double',
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }

  async execute(): Promise<string> {
    this.calls += 1;
    return this.reply;
  }

  async perform(): Promise<string> { return this.execute(); }
}

async function store(reply: string): Promise<Record<string, unknown>> {
  const agent = new ReportStorageAgent(new StubMemory(reply));
  return JSON.parse(await agent.perform({}));
}

describe('the productivity report says whether it was really stored', () => {
  it('does not claim to have stored it when memory reported an error', async () => {
    const out = await store(JSON.stringify({
      status: 'error', message: 'No message provided to remember',
    }));

    expect(out.stored).toBe(false);
    expect(out.status).toBe('error');
    expect(String(out.error)).toMatch(/No message provided to remember/);
    // The raw reply is still carried, so nothing is hidden — the summary just
    // stops contradicting it.
    expect(String(out.memory_result)).toContain('No message provided');
  });

  it('claims to have stored it when memory reported success', async () => {
    // The negative control: the fix must not report every report as unstored.
    const out = await store(JSON.stringify({ status: 'success', id: 'mem-1' }));

    expect(out.stored).toBe(true);
    expect(out.status).toBe('success');
    expect(out.error).toBeUndefined();
  });

  it('does not claim to have stored it when memory answered with nonsense', async () => {
    const out = await store('<html>gateway error</html>');

    expect(out.stored).toBe(false);
    expect(String(out.error)).toMatch(/unreadable reply/);
  });

  it('does not claim to have stored it when memory reported no status at all', async () => {
    const out = await store(JSON.stringify({ id: 'mem-2' }));

    expect(out.stored).toBe(false);
    expect(String(out.error)).toMatch(/status "unknown"/);
  });
});
