import { describe, it, expect, beforeEach } from 'vitest';

import { AgentRouter } from '../../agents/router.js';
import type { RouteContext } from '../../agents/router.js';

/**
 * Routing decisions, made by the real router.
 *
 * `parity/multiagent.test.ts` described these behaviours in 36 `it()` blocks
 * that imported no product code: sender routing, wildcards, group routing,
 * combined conditions, regex patterns, session isolation. Every one of them
 * asserted a literal the test had just written, so the router could have routed
 * everything to one agent and the suite would still have been green.
 *
 * `integration/agents.test.ts` already covers priority ordering, the default
 * agent, session-key formats and the broadcast modes, so those are not
 * repeated. What is here is the half that had no real home — the condition
 * types and the isolation property — after which the vacuous file is removed
 * rather than left to imply coverage that exists nowhere.
 */

function context(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    senderId: 'alice',
    channelId: 'imessage',
    conversationId: 'thread-1',
    message: 'hello',
    ...overrides,
  };
}

describe('routing conditions', () => {
  let router: AgentRouter;

  beforeEach(() => {
    router = new AgentRouter();
  });

  it('routes by sender, and leaves everyone else on the default', () => {
    router.addRule({
      id: 'alice-only',
      priority: 10,
      conditions: [{ type: 'sender', value: 'alice' }],
      agentId: 'Concierge',
    });

    expect(router.route(context({ senderId: 'alice' })).agentId).toBe('Concierge');
    // The half that matters: a rule that matched everyone would look identical
    // on the first assertion alone.
    expect(router.route(context({ senderId: 'bob' })).agentId).toBe('default');
  });

  it('routes by conversation for a group rule', () => {
    router.addRule({
      id: 'family',
      priority: 10,
      conditions: [{ type: 'group', value: 'family-thread' }],
      agentId: 'Household',
    });

    expect(router.route(context({ conversationId: 'family-thread' })).agentId).toBe('Household');
    expect(router.route(context({ conversationId: 'work-thread' })).agentId).toBe('default');
  });

  it('routes by channel', () => {
    router.addRule({
      id: 'sms-only',
      priority: 10,
      conditions: [{ type: 'channel', value: 'imessage' }],
      agentId: 'Texter',
    });

    expect(router.route(context({ channelId: 'imessage' })).agentId).toBe('Texter');
    expect(router.route(context({ channelId: 'telegram' })).agentId).toBe('default');
  });

  it('requires every condition on a rule, not any of them', () => {
    // `matchesRule` uses `every`. A rule that fired on a partial match would
    // send a stranger's message to the agent meant for one person in one
    // thread, which is the kind of mistake nobody reports as a bug.
    router.addRule({
      id: 'alice-in-family',
      priority: 10,
      conditions: [
        { type: 'sender', value: 'alice' },
        { type: 'group', value: 'family-thread' },
      ],
      agentId: 'Household',
    });

    expect(
      router.route(context({ senderId: 'alice', conversationId: 'family-thread' })).agentId,
    ).toBe('Household');
    expect(
      router.route(context({ senderId: 'alice', conversationId: 'work-thread' })).agentId,
    ).toBe('default');
    expect(
      router.route(context({ senderId: 'bob', conversationId: 'family-thread' })).agentId,
    ).toBe('default');
  });

  it('matches a message against a RegExp condition', () => {
    router.addRule({
      id: 'urgent',
      priority: 10,
      conditions: [{ type: 'pattern', pattern: /\burgent\b/ }],
      agentId: 'Escalation',
    });

    expect(router.route(context({ message: 'this is urgent' })).agentId).toBe('Escalation');
    // Word boundary, so a rule written to catch "urgent" does not catch
    // "urgently reconsidering" as a different word entirely.
    expect(router.route(context({ message: 'nothing pressing' })).agentId).toBe('default');
  });

  it('treats a string pattern as case-insensitive', () => {
    // `value` is compiled with the `i` flag while `pattern` is used as given.
    // Someone writing a rule from a config file gets the forgiving one.
    router.addRule({
      id: 'refund',
      priority: 10,
      conditions: [{ type: 'pattern', value: 'refund' }],
      agentId: 'Billing',
    });

    expect(router.route(context({ message: 'I want a REFUND' })).agentId).toBe('Billing');
    expect(router.route(context({ message: 'where is my order' })).agentId).toBe('default');
  });

  it('never matches a pattern condition carrying neither pattern nor value', () => {
    // Falling through to `true` here would make an incomplete rule a catch-all
    // that silently outranks everything below it.
    router.addRule({
      id: 'empty',
      priority: 100,
      conditions: [{ type: 'pattern' }],
      agentId: 'Wrong',
    });

    expect(router.route(context()).agentId).toBe('default');
  });

  it('matches everything with an always condition', () => {
    router.addRule({
      id: 'catch-all',
      priority: 1,
      conditions: [{ type: 'always' }],
      agentId: 'Fallback',
    });

    expect(router.route(context({ senderId: 'anyone' })).agentId).toBe('Fallback');
  });
});

describe('session isolation', () => {
  it('gives two senders separate sessions under the sender format', () => {
    const router = new AgentRouter();
    router.setSessionKeyFormat('sender');

    const alice = router.route(context({ senderId: 'alice' })).sessionKey;
    const bob = router.route(context({ senderId: 'bob' })).sessionKey;

    // Two people sharing a session key would mean one reading the other's
    // conversation, which is the failure this property exists to prevent.
    expect(alice).not.toBe(bob);
    expect(alice).toContain('alice');
  });

  it('keeps one sender on one session across messages', () => {
    const router = new AgentRouter();
    router.setSessionKeyFormat('sender');

    const first = router.route(context({ message: 'hello' })).sessionKey;
    const second = router.route(context({ message: 'still me' })).sessionKey;

    expect(first).toBe(second);
  });

  it('separates conversations on the same channel under the conversation format', () => {
    const router = new AgentRouter();
    router.setSessionKeyFormat('conversation');

    const family = router.route(context({ conversationId: 'family' })).sessionKey;
    const work = router.route(context({ conversationId: 'work' })).sessionKey;

    expect(family).not.toBe(work);
  });

  it('reports which rule decided, so a surprising route can be traced', () => {
    const router = new AgentRouter();
    router.addRule({
      id: 'named-rule',
      priority: 10,
      conditions: [{ type: 'sender', value: 'alice' }],
      agentId: 'Concierge',
    });

    expect(router.route(context({ senderId: 'alice' })).rule?.id).toBe('named-rule');
    // No rule matched, so there is nothing to name.
    expect(router.route(context({ senderId: 'bob' })).rule).toBeUndefined();
  });
});
