import { describe, expect, it } from 'vitest';
import { Assistant } from './Assistant.js';
import type {
  ChatOptions,
  LLMProvider,
  Message,
  ProviderResponse,
} from '../providers/types.js';

describe('Assistant conversation serialization', () => {
  it('does not expose a later user turn to an in-flight provider call', async () => {
    const snapshots: Message[][] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const provider: LLMProvider = {
      id: 'serialized-test',
      name: 'Serialized test provider',
      async isAvailable() {
        return true;
      },
      async chat(
        messages: Message[],
        _options?: ChatOptions,
      ): Promise<ProviderResponse> {
        snapshots.push(messages.map((message) => ({ ...message })));
        if (snapshots.length === 1) await firstBlocked;
        return {
          content: `reply-${snapshots.length}`,
          tool_calls: null,
        };
      },
    };
    const assistant = new Assistant(new Map(), {
      provider,
      loadWorkspaceContext: false,
      loadMemoryContext: false,
    });

    const first = assistant.getResponse(
      'first',
      undefined,
      undefined,
      'shared-session',
    );
    while (snapshots.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const second = assistant.getResponse(
      'second',
      undefined,
      undefined,
      'shared-session',
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(snapshots).toHaveLength(1);

    releaseFirst();
    await first;
    await second;

    expect(
      snapshots[0].filter((message) => message.role === 'user')
        .map((message) => message.content),
    ).toEqual(['first']);
    expect(
      snapshots[1].filter((message) => message.role === 'user')
        .map((message) => message.content),
    ).toEqual(['first', 'second']);
  });
});
