/**
 * MessageAgent iMessage boundary tests.
 *
 * iMessage delivery belongs exclusively to the trust-scoped Python sidecar.
 * MessageAgent must never bypass it with direct AppleScript sends.
 */

import { describe, expect, it } from 'vitest';
import { MessageAgent } from '../../agents/MessageAgent.js';

describe('MessageAgent — canonical iMessage boundary', () => {
  it.each(['imessage', 'imsg'])('rejects direct %s sends', async (channelId) => {
    const agent = new MessageAgent();
    const result = JSON.parse(await agent.execute({
      action: 'send',
      channelId,
      recipient: 'synthetic@example.invalid',
      content: 'hello',
    }));
    expect(result.status).toBe('error');
    expect(result.message).toContain('trust-scoped iMessage conversation');
  });

  it('does not expose recipient identifiers in the rejection', async () => {
    const agent = new MessageAgent();
    const result = JSON.parse(await agent.execute({
      action: 'send',
      channelId: 'imessage',
      recipient: 'private-address@example.invalid',
      content: 'hello',
    }));
    expect(result.message).not.toContain('private-address');
  });

  it('metadata still describes iMessage transport capability', () => {
    const agent = new MessageAgent();
    expect(agent.metadata.description).toContain('iMessage');
  });

  it('requires action parameter', async () => {
    const agent = new MessageAgent();
    const result = JSON.parse(await agent.execute({}));
    expect(result.status).toBe('error');
    expect(result.message).toContain('No action specified');
  });

  it('requires all send parameters', async () => {
    const agent = new MessageAgent();
    const result = JSON.parse(await agent.execute({
      action: 'send',
      channelId: 'imessage',
    }));
    expect(result.status).toBe('error');
    expect(result.message).toContain('required for send action');
  });
});
