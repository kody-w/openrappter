import { describe, expect, it } from 'vitest';
import { DemoRecorderAgent } from './DemoRecorderAgent.js';

describe('DemoRecorderAgent output names', () => {
  it.each([
    '../../tmp/escaped',
    'demo"; touch /tmp/openrappter-injected; echo "',
    '..',
    '/absolute/path',
  ])('rejects unsafe output name %s before starting a recorder', async (outputName) => {
    const agent = new DemoRecorderAgent();

    const result = JSON.parse(
      await agent.perform({ action: 'record_rar', output_name: outputName })
    );

    expect(result.status).toBe('error');
    expect(result.message).toContain('output_name');
  });

  it('allows a bounded filename without path separators', async () => {
    const agent = new DemoRecorderAgent();
    const result = JSON.parse(
      await agent.perform({ action: 'list_scripts', output_name: 'release-demo_1.0' })
    );

    expect(result.status).toBe('success');
  });
});

/**
 * This agent advertised a `query` natural-language parameter that nothing read.
 * `action` defaults to `record_rar`, so prose did not fail -- it fell through
 * and recorded the RAR walkthrough, wrote the video to disk, and returned
 * success for a demo the caller never asked for.
 */
describe('DemoRecorderAgent natural-language calls', () => {
  it('refuses a prose-only call instead of recording the default demo', async () => {
    const agent = new DemoRecorderAgent();

    const result = JSON.parse(
      await agent.perform({ query: 'record a demo of the settings screen' })
    );

    expect(result.status).toBe('error');
    expect(result.message).toMatch(/typed action/i);
    // Anti-vacuity: the message must name the actions, not just any error.
    expect(result.message).toContain('record_rar');
  });

  it('does not advertise the unimplemented natural-language query parameter', () => {
    const properties = (
      new DemoRecorderAgent().metadata.parameters as {
        properties: Record<string, unknown>;
      }
    ).properties;

    expect(Object.keys(properties)).toContain('action');
    expect(Object.keys(properties)).not.toContain('query');
  });

  it('still runs a typed action that carries stray prose alongside it', async () => {
    const agent = new DemoRecorderAgent();

    // Scope guard: refusing prose must not refuse a well-formed command.
    const result = JSON.parse(
      await agent.perform({ action: 'list_scripts', query: 'show me the demos' })
    );

    expect(result.status).toBe('success');
    expect(result.action).toBe('list_scripts');
  });
});
