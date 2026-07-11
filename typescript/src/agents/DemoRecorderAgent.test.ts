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
